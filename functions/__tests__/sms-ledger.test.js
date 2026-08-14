import { describe, it, expect, vi } from 'vitest'
import { claimSend } from '../lib/smsLedger.js'

/**
 * Injected-firestore mock, same shape as sms-rate-limit.test.js:
 * the ledger receives `firestore` as a parameter and never imports it.
 *
 * The one difference: the ledger holds one document per claim, keyed by
 * document path, so the mock keeps its state in a Map keyed by path instead
 * of a single counter. Several cases below assert that DIFFERENT keys claim
 * independently, which a single shared state could not express.
 */
function makeMockFirestore() {
  const claims = new Map()
  const refs = new Map()

  function refFor(path) {
    if (!refs.has(path)) {
      const ref = {
        _path: path,
        get: vi.fn(async () => {
          const entry = claims.get(path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn(async (data) => { claims.set(path, data) }),
      }
      refs.set(path, ref)
    }
    return refs.get(path)
  }

  const firestore = {
    doc: vi.fn((path) => refFor(path)),
    runTransaction: vi.fn(async (fn) => {
      const tx = {
        get: vi.fn(async (ref) => {
          const entry = claims.get(ref._path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => { claims.set(ref._path, data) }),
      }
      return fn(tx)
    }),
  }
  return { firestore, claims }
}

const TRACKING = '1Z999AA10123456784'

describe('claimSend', () => {
  const ORG = 'acme'
  const TRACK = '426315840269'
  const TPL = 'delivered'

  it('does not throw when trackingNumber arrives as a NUMBER', async () => {
    const { firestore } = makeMockFirestore()
    const r = await claimSend({ firestore, orgSlug: ORG, trackingNumber: 426315840269, templateKey: TPL })
    expect(r.claimed).toBe(true)
  })

  it('refuses a tracking number too large to represent exactly as a JS number', async () => {
    const { firestore } = makeMockFirestore()
    await expect(claimSend({
      firestore,
      orgSlug: 'acme',
      trackingNumber: 9400111899223197428490,
      templateKey: 'delivered',
    })).rejects.toThrow(/too large to represent exactly/i)
  })

  it('still accepts a 12-digit numeric tracking number, which is inside the safe range', async () => {
    const { firestore } = makeMockFirestore()
    const result = await claimSend({
      firestore,
      orgSlug: 'acme',
      trackingNumber: 426315840269,
      templateKey: 'delivered',
    })
    expect(result.claimed).toBe(true)
  })

  it('treats the numeric and string forms of one tracking number as ONE claim', async () => {
    const { firestore } = makeMockFirestore()
    const first = await claimSend({ firestore, orgSlug: ORG, trackingNumber: 426315840269, templateKey: TPL })
    const second = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL })
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
  })

  it('throws when orgSlug is missing rather than defaulting to a shared path', async () => {
    const { firestore } = makeMockFirestore()
    await expect(claimSend({ firestore, trackingNumber: TRACK, templateKey: TPL })).rejects.toThrow(/orgSlug/)
  })

  it('throws when templateKey is missing', async () => {
    const { firestore } = makeMockFirestore()
    await expect(claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK })).rejects.toThrow(/templateKey/)
  })

  it('throws when trackingNumber is missing', async () => {
    const { firestore } = makeMockFirestore()
    await expect(claimSend({ firestore, orgSlug: ORG, templateKey: TPL })).rejects.toThrow(/trackingNumber/)
  })

  it('derives a six-segment path naming the org exactly once with a single-segment key', async () => {
    const { firestore } = makeMockFirestore()
    await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL })
    const path = firestore.doc.mock.calls[0][0]
    const segments = path.split('/')
    expect(segments).toHaveLength(6)
    expect(segments.filter((s) => s === ORG)).toHaveLength(1)
    expect(segments[segments.length - 1]).toContain('__')
  })

  it('refuses a second claim while the first has not expired', async () => {
    const { firestore } = makeMockFirestore()
    await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL, now: new Date('2026-08-13T00:00:00Z') })
    const second = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL, now: new Date('2026-09-13T00:00:00Z') })
    expect(second.claimed).toBe(false)
  })

  it('allows a fresh claim once the previous one has expired', async () => {
    const { firestore } = makeMockFirestore()
    await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL, now: new Date('2026-08-13T00:00:00Z') })
    const again = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL, now: new Date('2027-01-01T00:00:00Z') })
    expect(again.claimed).toBe(true)
  })

  it('claims a new tracking number', async () => {
    const { firestore } = makeMockFirestore()
    const result = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(result.claimed).toBe(true)
  })

  it('refuses a second claim for the same tracking number', async () => {
    const { firestore } = makeMockFirestore()
    const first = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(first.claimed).toBe(true)

    const second = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(second.claimed).toBe(false)
  })

  it('does not create a second ledger entry for a refused duplicate', async () => {
    const { firestore, claims } = makeMockFirestore()
    await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(claims.size).toBe(1)

    await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(claims.size).toBe(1)
  })

  it('claims different tracking numbers independently', async () => {
    const { firestore, claims } = makeMockFirestore()
    const acme = await claimSend({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(acme.claimed).toBe(true)

    const globe = await claimSend({ firestore, orgSlug: ORG, trackingNumber: '1Z999BB20234567895', templateKey: TPL })
    expect(globe.claimed).toBe(true)

    expect(claims.size).toBe(2)
  })

  it('allows exactly one successful claim for five shipment ids sharing one tracking number', async () => {
    const { firestore } = makeMockFirestore()
    const shipmentIds = ['ship_1', 'ship_2', 'ship_3', 'ship_4', 'ship_5']
    const trackingNumber = '1Z999CC30345678606'

    let successfulClaims = 0
    for (const shipmentId of shipmentIds) {
      const result = await claimSend({ firestore, orgSlug: ORG, trackingNumber, templateKey: TPL, shipmentIds: [shipmentId] })
      if (result.claimed) successfulClaims += 1
    }

    expect(successfulClaims).toBe(1)
  })
})
