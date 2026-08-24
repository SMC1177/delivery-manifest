import { describe, it, expect, vi } from 'vitest'
import { onShipmentStatusChange, onShipmentCreatedInitialSms } from '../sms-status-trigger.js'

// Same real-enqueue + mock-firestore harness as sms-status-trigger.test.js: the
// guarantee under test lives in the queue's document key and the ledger claim,
// so a stubbed enqueue would prove nothing.
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
const NOW = new Date('2026-08-24T12:00:00.000Z')
const TRACK = '539404639669'

const shipment = (overrides = {}) => ({
  id: 's_1',
  status: 'pending',
  trackingNumber: TRACK,
  patientName: 'John Doe',
  date: '2026-08-22',
  ...overrides,
})

const fire = (firestore, before, after) =>
  onShipmentStatusChange({ firestore, before, after, orgSlug: ORG, shipmentId: 's_1', now: NOW })

const born = (firestore, doc) =>
  onShipmentCreatedInitialSms({ firestore, doc, orgSlug: ORG, shipmentId: 's_1', now: NOW })

describe('initial text — tracking arrival on a pending row', () => {
  it('enqueues trackingAssigned exactly once when a recent pending row gains its tracking number', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ trackingNumber: '' }), shipment({}))
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.templateKey).toBe('trackingAssigned')
    expect(item.trackingNumber).toBe(TRACK)
    expect(item.status).toBe('pending')
  })

  it('a repeat arrival is absorbed by the ledger — still exactly one item', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ trackingNumber: '' }), shipment({}))
    await fire(firestore, shipment({ trackingNumber: '' }), shipment({}))
    expect(notifications.size).toBe(1)
  })

  it('an 8-day-old pharmacy date enqueues NOTHING (the mass-text gate)', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ trackingNumber: '', date: '2026-08-16' }), shipment({ date: '2026-08-16' }))
    expect(notifications.size).toBe(0)
  })

  it('a missing pharmacy date enqueues NOTHING — unknown recency refuses, it never sends', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ trackingNumber: '', date: '' }), shipment({ date: '' }))
    expect(notifications.size).toBe(0)
  })

  it('a pending row whose OTHER fields change (tracking already present) enqueues nothing', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({ patientName: 'Old Name' }), shipment({ patientName: 'New Name' }))
    expect(notifications.size).toBe(0)
  })
})

describe('initial text — row created with tracking already present', () => {
  it('enqueues trackingAssigned once for a recent pending row born with tracking', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await born(firestore, shipment({}))
    expect(notifications.size).toBe(1)
    expect([...notifications.values()][0].templateKey).toBe('trackingAssigned')
  })

  it('an old-dated born row enqueues NOTHING — a wipe-reimport backlog stays silent', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await born(firestore, shipment({ date: '2026-08-01' }))
    expect(notifications.size).toBe(0)
  })

  it('a born row without tracking enqueues nothing', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await born(firestore, shipment({ trackingNumber: '' }))
    expect(notifications.size).toBe(0)
  })

  it('a born row in a non-pending status enqueues nothing from this path', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await born(firestore, shipment({ status: 'delivered' }))
    expect(notifications.size).toBe(0)
  })
})

describe('existing status paths — pinned unchanged', () => {
  it('pending -> shipped still enqueues outForDelivery', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({}), shipment({ status: 'shipped' }))
    expect(notifications.size).toBe(1)
    expect([...notifications.values()][0].templateKey).toBe('outForDelivery')
  })

  it('pending -> delivered still enqueues nothing', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await fire(firestore, shipment({}), shipment({ status: 'delivered' }))
    expect(notifications.size).toBe(0)
  })
})
