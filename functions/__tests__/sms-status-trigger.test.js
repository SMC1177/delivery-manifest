import { describe, it, expect, vi } from 'vitest'
import { onShipmentStatusChange, STATUS_TEMPLATE_KEYS } from '../sms-status-trigger.js'

/**
 * The trigger is driven against the REAL enqueue and a mock firestore, not a
 * stubbed enqueue. That matters: the guarantee under test is that one delivery
 * event yields one queued notification, and that guarantee lives in the queue's
 * document key. A spy would only prove the trigger called something.
 */
function makeMockFirestore() {
  const notifications = new Map()
  const refs = new Map()

  function refFor(path) {
    if (!refs.has(path)) {
      refs.set(path, { _path: path })
    }
    return refs.get(path)
  }

  const firestore = {
    doc: vi.fn((path) => refFor(path)),
    runTransaction: vi.fn(async (fn) =>
      fn({
        get: vi.fn(async (ref) => {
          const entry = notifications.get(ref._path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => { notifications.set(ref._path, data) }),
      })
    ),
  }
  return { firestore, notifications }
}

const ORG = 'acme'
const NOW = new Date('2026-08-13T12:00:00.000Z')
const TRACK = '1Z999AA10123456784'

const shipment = (overrides = {}) => ({
  id: 's_1',
  status: 'pending',
  trackingNumber: TRACK,
  patientName: 'John Doe',
  ...overrides,
})

const fire = (firestore, before, after) =>
  onShipmentStatusChange({ firestore, before, after, orgSlug: ORG, shipmentId: 's_1', now: NOW })

describe('onShipmentStatusChange', () => {
  it('enqueues exactly one notification when the status enters a notifying state', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'delivered' }))
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.templateKey).toBe(STATUS_TEMPLATE_KEYS.delivered)
    expect(item.trackingNumber).toBe(TRACK)
    expect(item.status).toBe('pending')
  })

  it('still yields one notification when the same transition is observed twice', async () => {
    const { firestore, notifications } = makeMockFirestore()
    const before = shipment({ status: 'pending' })
    const after = shipment({ status: 'delivered' })
    await fire(firestore, before, after)
    await fire(firestore, before, after)
    expect(notifications.size).toBe(1)
  })

  it('carries the shipment id so the whole box can be batched into one message', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'delivered' }))
    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual(['s_1'])
  })

  it('enqueues nothing when a field other than status or tracking number changes', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(
      firestore,
      shipment({ status: 'delivered', patientName: 'John Doe' }),
      shipment({ status: 'delivered', patientName: 'Jonathan Doe' })
    )
    expect(notifications.size).toBe(0)
  })

  it('enqueues nothing when the status did not change at all', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'delivered' }), shipment({ status: 'delivered' }))
    expect(notifications.size).toBe(0)
  })

  it('enqueues nothing for a status that is not in the notifying map', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'archived' }))
    expect(notifications.size).toBe(0)
  })

  it('enqueues nothing, rather than throwing, for a row that has no tracking number yet', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(
      firestore,
      shipment({ status: 'pending', trackingNumber: '' }),
      shipment({ status: 'delivered', trackingNumber: '' })
    )
    expect(notifications.size).toBe(0)
  })

  it('enqueues when a later import gives an existing row its tracking number', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(
      firestore,
      shipment({ status: 'delivered', trackingNumber: '' }),
      shipment({ status: 'delivered', trackingNumber: TRACK })
    )
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.trackingNumber).toBe(TRACK)
  })

  it('does not enqueue twice when the tracking number arrives and is then re-imported', async () => {
    const { firestore, notifications } = makeMockFirestore()
    const untracked = shipment({ status: 'delivered', trackingNumber: '' })
    const tracked = shipment({ status: 'delivered', trackingNumber: TRACK })
    await fire(firestore, untracked, tracked)
    await fire(firestore, tracked, tracked)
    expect(notifications.size).toBe(1)
  })
})

describe('STATUS_TEMPLATE_KEYS', () => {
  it('maps every notifying status to a template key', () => {
    for (const [status, templateKey] of Object.entries(STATUS_TEMPLATE_KEYS)) {
      expect(typeof status).toBe('string')
      expect(typeof templateKey).toBe('string')
      expect(templateKey.length).toBeGreaterThan(0)
    }
  })

  it('does not notify on a status that only means the row was filed', () => {
    expect(STATUS_TEMPLATE_KEYS.archived).toBeUndefined()
    expect(STATUS_TEMPLATE_KEYS.pending).toBeUndefined()
  })
})
