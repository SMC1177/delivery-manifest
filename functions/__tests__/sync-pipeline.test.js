import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mapFedExStatus } from '../fedex-status.js'
import { mapUpsStatus } from '../ups-status.js'

/**
 * Integration tests for the sync pipeline logic.
 *
 * Since index.js has top-level Firebase side effects (initializeApp, defineSecret),
 * we test the pipeline logic by reimplementing the core update-decision algorithm
 * using the real mapFedExStatus/mapUpsStatus functions. This validates the seam
 * between status mapping and the Firestore update logic.
 */

// Simulates the core logic from syncFedExForOrg: given a shipment and a FedEx
// track result, determines what updates (if any) should be applied.
function computeFedExUpdates(shipment, trackResult) {
  const latestStatus = trackResult?.latestStatusDetail
  const newStatus = mapFedExStatus(latestStatus?.code)

  if (!newStatus || newStatus === shipment.status) return null

  const updates = {
    status: newStatus,
    fedexStatus: latestStatus?.statusByLocale || latestStatus?.code,
    fedexDescription: latestStatus?.description || null,
    updatedBy: 'system:fedex-sync',
  }

  if (newStatus === 'delivered') {
    updates.deliveredAt = 'SERVER_TIMESTAMP'
  }
  if (newStatus === 'shipped' && !shipment.shippedAt) {
    updates.shippedAt = 'SERVER_TIMESTAMP'
  }

  return updates
}

// Simulates the core logic from syncUpsForOrg
function computeUpsUpdates(shipment, trackData) {
  const pkg = trackData?.trackResponse?.shipment?.[0]?.package?.[0]
  if (!pkg) return null

  const currentStatus = pkg.currentStatus || pkg.activity?.[0]?.status
  const statusType = currentStatus?.type || null
  const newStatus = mapUpsStatus(statusType)

  if (!newStatus || newStatus === shipment.status) return null

  const updates = {
    status: newStatus,
    upsStatus: currentStatus?.description || statusType,
    upsDescription: currentStatus?.description || null,
    updatedBy: 'system:ups-sync',
  }

  if (newStatus === 'delivered') {
    updates.deliveredAt = 'SERVER_TIMESTAMP'
  }
  if (newStatus === 'shipped' && !shipment.shippedAt) {
    updates.shippedAt = 'SERVER_TIMESTAMP'
  }

  return updates
}

describe('FedEx sync pipeline integration', () => {
  it('returns null when no track result', () => {
    const shipment = { status: 'pending', trackingNumber: '123' }
    expect(computeFedExUpdates(shipment, null)).toBeNull()
  })

  it('returns null when status code is unknown', () => {
    const shipment = { status: 'pending', trackingNumber: '123' }
    const trackResult = { latestStatusDetail: { code: 'ZZ' } }
    expect(computeFedExUpdates(shipment, trackResult)).toBeNull()
  })

  it('returns null when status has not changed', () => {
    const shipment = { status: 'in_transit', trackingNumber: '123' }
    const trackResult = { latestStatusDetail: { code: 'IT', statusByLocale: 'In Transit' } }
    expect(computeFedExUpdates(shipment, trackResult)).toBeNull()
  })

  it('updates status when it changes from pending to in_transit', () => {
    const shipment = { status: 'pending', trackingNumber: '123' }
    const trackResult = {
      latestStatusDetail: { code: 'IT', statusByLocale: 'In Transit', description: 'Package in transit' },
    }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates).not.toBeNull()
    expect(updates.status).toBe('in_transit')
    expect(updates.fedexStatus).toBe('In Transit')
    expect(updates.fedexDescription).toBe('Package in transit')
    expect(updates.updatedBy).toBe('system:fedex-sync')
  })

  it('sets deliveredAt timestamp when status is delivered', () => {
    const shipment = { status: 'in_transit', trackingNumber: '123' }
    const trackResult = { latestStatusDetail: { code: 'DL', statusByLocale: 'Delivered' } }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates.status).toBe('delivered')
    expect(updates.deliveredAt).toBe('SERVER_TIMESTAMP')
  })

  it('sets shippedAt only if not already set', () => {
    const shipment = { status: 'pending', trackingNumber: '123', shippedAt: null }
    const trackResult = { latestStatusDetail: { code: 'SH', statusByLocale: 'Shipped' } }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates.status).toBe('shipped')
    expect(updates.shippedAt).toBe('SERVER_TIMESTAMP')
  })

  it('does not overwrite existing shippedAt', () => {
    const shipment = { status: 'pending', trackingNumber: '123', shippedAt: '2024-01-01T00:00:00Z' }
    const trackResult = { latestStatusDetail: { code: 'SH', statusByLocale: 'Shipped' } }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates.status).toBe('shipped')
    expect(updates.shippedAt).toBeUndefined()
  })

  it('handles exception status correctly', () => {
    const shipment = { status: 'in_transit', trackingNumber: '123' }
    const trackResult = { latestStatusDetail: { code: 'DE', statusByLocale: 'Delivery Exception' } }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates.status).toBe('exception')
  })

  it('falls back to code when statusByLocale is missing', () => {
    const shipment = { status: 'pending', trackingNumber: '123' }
    const trackResult = { latestStatusDetail: { code: 'IT' } }
    const updates = computeFedExUpdates(shipment, trackResult)
    expect(updates.fedexStatus).toBe('IT')
  })

  it('handles batch processing: multiple shipments with mixed results', () => {
    const shipments = [
      { status: 'pending', trackingNumber: '001' },
      { status: 'in_transit', trackingNumber: '002' },
      { status: 'shipped', trackingNumber: '003' },
    ]
    const trackResults = [
      { latestStatusDetail: { code: 'IT', statusByLocale: 'In Transit' } },
      { latestStatusDetail: { code: 'IT', statusByLocale: 'In Transit' } }, // no change
      { latestStatusDetail: { code: 'DL', statusByLocale: 'Delivered' } },
    ]

    const results = shipments.map((s, i) => computeFedExUpdates(s, trackResults[i]))
    expect(results[0]).not.toBeNull() // pending → in_transit
    expect(results[1]).toBeNull()     // no change
    expect(results[2]).not.toBeNull() // shipped → delivered
    expect(results[2].deliveredAt).toBe('SERVER_TIMESTAMP')
  })
})

describe('UPS sync pipeline integration', () => {
  it('returns null when no track data', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123' }
    expect(computeUpsUpdates(shipment, null)).toBeNull()
  })

  it('returns null when no package in response', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123' }
    const data = { trackResponse: { shipment: [{ package: [] }] } }
    expect(computeUpsUpdates(shipment, data)).toBeNull()
  })

  it('returns null when status has not changed', () => {
    const shipment = { status: 'in_transit', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'I', description: 'In Transit' } }] }],
      },
    }
    expect(computeUpsUpdates(shipment, data)).toBeNull()
  })

  it('updates status when it changes from pending to in_transit', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'I', description: 'In Transit' } }] }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('in_transit')
    expect(updates.upsStatus).toBe('In Transit')
    expect(updates.updatedBy).toBe('system:ups-sync')
  })

  it('sets deliveredAt timestamp when status is delivered', () => {
    const shipment = { status: 'in_transit', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'D', description: 'Delivered' } }] }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('delivered')
    expect(updates.deliveredAt).toBe('SERVER_TIMESTAMP')
  })

  it('sets shippedAt only if not already set', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123', shippedAt: null }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'M', description: 'Manifest' } }] }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('shipped')
    expect(updates.shippedAt).toBe('SERVER_TIMESTAMP')
  })

  it('does not overwrite existing shippedAt', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123', shippedAt: '2024-01-01T00:00:00Z' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'P', description: 'Pickup' } }] }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('shipped')
    expect(updates.shippedAt).toBeUndefined()
  })

  it('handles exception status correctly', () => {
    const shipment = { status: 'in_transit', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'X', description: 'Exception' } }] }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('exception')
  })

  it('falls back to activity status when currentStatus is missing', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{
          package: [{
            activity: [{ status: { type: 'I', description: 'In Transit' } }],
          }],
        }],
      },
    }
    const updates = computeUpsUpdates(shipment, data)
    expect(updates.status).toBe('in_transit')
  })

  it('returns null for unknown UPS status type', () => {
    const shipment = { status: 'pending', trackingNumber: '1Z123' }
    const data = {
      trackResponse: {
        shipment: [{ package: [{ currentStatus: { type: 'ZZ', description: 'Unknown' } }] }],
      },
    }
    expect(computeUpsUpdates(shipment, data)).toBeNull()
  })
})
