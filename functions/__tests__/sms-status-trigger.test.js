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
  const ledger = new Map()
  const refs = new Map()

  function refFor(path) {
    if (!refs.has(path)) {
      refs.set(path, { _path: path })
    }
    return refs.get(path)
  }

  // enqueue writes BOTH the ledger claim (claimSend) and the queue item, so the
  // tests' queue views (notifications.size, [...notifications.values()]) must
  // count only queue documents. Partition by path at write time; reads consult
  // both maps so the idempotency claim round-trip in claimSend still works.
  const isQueuePath = (path) => path.includes('settings/textMessaging/queue/')

  const firestore = {
    doc: vi.fn((path) => refFor(path)),
    runTransaction: vi.fn(async (fn) =>
      fn({
        get: vi.fn(async (ref) => {
          const entry = notifications.get(ref._path) ?? ledger.get(ref._path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => {
          const map = isQueuePath(ref._path) ? notifications : ledger
          map.set(ref._path, data)
        }),
      })
    ),
  }
  return { firestore, notifications, ledger }
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
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'shipped' }))
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.templateKey).toBe(STATUS_TEMPLATE_KEYS.shipped)
    expect(item.trackingNumber).toBe(TRACK)
    expect(item.status).toBe('pending')
  })

  it('still yields one notification when the same transition is observed twice', async () => {
    const { firestore, notifications } = makeMockFirestore()
    const before = shipment({ status: 'pending' })
    const after = shipment({ status: 'shipped' })
    await fire(firestore, before, after)
    await fire(firestore, before, after)
    expect(notifications.size).toBe(1)
  })

  it('carries the shipment id so the whole box can be batched into one message', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'shipped' }))
    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual(['s_1'])
  })

  it('enqueues nothing when a field other than status or tracking number changes', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(
      firestore,
      shipment({ status: 'shipped', patientName: 'John Doe' }),
      shipment({ status: 'shipped', patientName: 'Jonathan Doe' })
    )
    expect(notifications.size).toBe(0)
  })

  it('enqueues nothing when the status did not change at all', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'shipped' }), shipment({ status: 'shipped' }))
    expect(notifications.size).toBe(0)
  })

  it('enqueues nothing when a tracked row flips to delivered — the refresh path', async () => {
    // The structural case pins the map; this one drives the path a carrier
    // status refresh actually takes. Trident's audit log records one
    // tracking.status_refresh on 2026-08-18 that checked 3,843 shipments and
    // updated 3,624, and 1,533 delivered notifications appeared in the queue
    // inside the same 32 seconds — every one a row flipping to delivered with
    // a tracking number already on it. This is that transition.
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ status: 'pending' }), shipment({ status: 'delivered' }))
    expect(
      notifications.size,
      'a delivered status must never enqueue a notification, however it is reached',
    ).toBe(0)
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
      shipment({ status: 'shipped', trackingNumber: '' })
    )
    expect(notifications.size).toBe(0)
  })

  it('enqueues when a later import gives an existing row its tracking number', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(
      firestore,
      shipment({ status: 'shipped', trackingNumber: '' }),
      shipment({ status: 'shipped', trackingNumber: TRACK })
    )
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.trackingNumber).toBe(TRACK)
  })

  it('does not enqueue twice when the tracking number arrives and is then re-imported', async () => {
    const { firestore, notifications } = makeMockFirestore()
    const untracked = shipment({ status: 'shipped', trackingNumber: '' })
    const tracked = shipment({ status: 'shipped', trackingNumber: TRACK })
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

  it('a delivered status generates no message — the operator\'s rule', () => {
    // "Delivered status should never send an sms." Measured why it matters:
    // Trident holds 19,399 delivered shipments across 3,106 distinct tracking
    // numbers with a phone, and 1,589 delivered notifications were already
    // sitting in its queue — 1,533 of them built inside 32 seconds on
    // 2026-08-18 by a single click of refresh tracking. Only settings.enabled
    // being false stopped them reaching a patient.
    expect(STATUS_TEMPLATE_KEYS.delivered).toBeUndefined()
  })

  it('w0-1: in_transit generates no message — it tells a patient nothing actionable', () => {
    expect(STATUS_TEMPLATE_KEYS.in_transit).toBeUndefined()
  })
})

describe('STATUS_TEMPLATE_KEYS — every value must name a template that exists', () => {
  // The seven keys measured in BOTH organizations' settings.templates on
  // 2026-08-20. templatesByLang is absent for tridentmedicalgroup, so this
  // legacy map is resolveTemplate's only source - and it THROWS
  // NoTemplateFoundError on a miss rather than returning empty.
  const REAL_TEMPLATE_KEYS = [
    'optInInvite',
    'optInConfirm',
    'optOutConfirm',
    'nonKeywordRedirect',
    'outForDelivery',
    'delivered',
    'addressIssue',
  ]

  it('maps every notifying status to a template key that actually exists', () => {
    for (const [status, templateKey] of Object.entries(STATUS_TEMPLATE_KEYS)) {
      expect(
        REAL_TEMPLATE_KEYS,
        `status "${status}" enqueues templateKey "${templateKey}", which is not a template any ` +
        'organization stores. resolveTemplate throws NoTemplateFoundError on it, and the drain ' +
        'increments the 250/day counter BEFORE the send attempt - so every retry burns a daily ' +
        'send slot and no patient is ever told anything.',
      ).toContain(templateKey)
    }
  })

  it('still refuses to notify on delivered', () => {
    // Guards the fix from over-reaching: mapping statuses to real templates
    // must not quietly reintroduce the one the operator forbade.
    expect(
      Object.values(STATUS_TEMPLATE_KEYS),
      "the operator's rule: a delivered status must never produce a message",
    ).not.toContain('delivered')
    expect(STATUS_TEMPLATE_KEYS.delivered).toBeUndefined()
  })
})
