import { describe, it, expect, vi } from 'vitest'
import { enqueue } from '../lib/smsQueue.js'
import { drainQueue } from '../sms-queue-drain.js'

function makeQueryableFirestore() {
  const notifications = new Map()
  const refs = new Map()

  function refFor(path) {
    if (!refs.has(path)) {
      const ref = {
        _path: path,
        get: vi.fn(async () => {
          const entry = notifications.get(path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn(async (data) => { notifications.set(path, data) }),
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
          const entry = notifications.get(ref._path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => { notifications.set(ref._path, data) }),
      }
      return fn(tx)
    }),
  }

  firestore.collection = vi.fn((collectionPath) => {
    const filters = []
    let max = Infinity
    const order = []
    const query = {
      where: vi.fn((field, op, value) => { filters.push({ field, op, value }); return query }),
      orderBy: vi.fn((field, direction = 'asc') => { order.push({ field, direction }); return query }),
      limit: vi.fn((n) => { max = n; return query }),
      get: vi.fn(async () => {
        const docs = []
        for (const [docPath, data] of notifications) {
          if (!docPath.startsWith(collectionPath + '/')) continue
          const id = docPath.slice(collectionPath.length + 1)
          if (id.includes('/')) continue
          const matches = filters.every((f) => (f.op === '==' ? data[f.field] === f.value : true))
          if (matches) docs.push({ id, ref: firestore.doc(docPath), data: () => data })
        }
        for (const { field, direction } of order) {
          docs.sort((a, b) => {
            const av = a.data()[field] ?? ''
            const bv = b.data()[field] ?? ''
            if (av === bv) return 0
            return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1)
          })
        }
        const page = docs.slice(0, max)
        return { docs: page, size: page.length, empty: page.length === 0 }
      }),
    }
    return query
  })

  return { firestore, notifications }
}

describe('drainQueue — 8 o-clock hour hold (B-2)', () => {
  const ORG = 'acme'
  const TPL = 'delivered'

  it('releases a SAME-DAY item during the 8 o-clock hour: sent=0, failed=0, heldForWindow=1, sendMessage never called', async () => {
    const { firestore } = makeQueryableFirestore()
    const now = new Date('2026-05-19T13:00:00Z') // 08:00 CDT
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: 'T1', templateKey: TPL, shipmentIds: ['s1'], now })

    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const summary = await drainQueue({ firestore, orgSlug: ORG, workerId: 'w', cap: 250, now, sendMessage })

    expect(summary.sent).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.heldForWindow).toBe(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('sends a PRIOR-DAY item during the 8 o-clock hour: sent=1, sendMessage called once', async () => {
    const { firestore } = makeQueryableFirestore()
    const now = new Date('2026-05-19T13:00:00Z') // 08:00 CDT
    const yesterday = new Date('2026-05-18T10:00:00Z') // prior day Central
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: 'T2', templateKey: TPL, shipmentIds: ['s2'], now: yesterday })

    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const summary = await drainQueue({ firestore, orgSlug: ORG, workerId: 'w', cap: 250, now, sendMessage })

    expect(summary.sent).toBe(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
