import { describe, it, expect, vi } from 'vitest'
import { enqueue, claimBatch, complete, fail, release } from '../lib/smsQueue.js'
import { drainQueue } from '../sms-queue-drain.js'

/**
 * Injected-firestore mock, same shape as sms-ledger.test.js:
 * the queue receives `firestore` as a parameter and never imports it.
 *
 * The one difference: the queue holds one document per pending notification,
 * keyed by document path, so the mock keeps its state in a Map keyed by path
 * instead of a single counter. Several cases below assert that DIFFERENT keys
 * enqueue independently, which a single shared state could not express.
 */
function makeMockFirestore() {
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
  return { firestore, notifications }
}

const TRACKING = '1Z999AA10123456784'

describe('enqueue', () => {
  const ORG = 'acme'
  const TRACK = '426315840269'
  const TPL = 'delivered'

  it('stores the STRING form when trackingNumber arrives as a NUMBER', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: 426315840269, templateKey: TPL })
    const [item] = [...notifications.values()]
    expect(item.trackingNumber).toBe(TRACK)
    expect(typeof item.trackingNumber).toBe('string')
  })

  it('refuses a tracking number too large to represent exactly as a JS number', async () => {
    const { firestore } = makeMockFirestore()
    await expect(enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: 9400111899223197428490,
      templateKey: TPL,
    })).rejects.toThrow(/too large to represent exactly/i)
  })

  it('treats the numeric and string forms of one tracking number as ONE pending notification', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: 426315840269, templateKey: TPL })
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL })
    expect(notifications.size).toBe(1)
  })

  it('throws when orgSlug is missing rather than defaulting to a shared path', async () => {
    const { firestore } = makeMockFirestore()
    await expect(enqueue({ firestore, trackingNumber: TRACK, templateKey: TPL })).rejects.toThrow(/orgSlug/)
  })

  it('throws when templateKey is missing rather than queueing an unsendable item', async () => {
    const { firestore } = makeMockFirestore()
    await expect(enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACK })).rejects.toThrow(/templateKey/)
  })

  it('writes the queue item the drain needs: pending, zero attempts, and identity', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('pending')
    expect(item.attempts).toBe(0)
    expect(item.orgSlug).toBe(ORG)
    expect(item.templateKey).toBe(TPL)
    expect(typeof item.createdAt).toBe('string')
    expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false)
  })

  it('preserves the tracking number as written while deduping case-insensitively', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING.toLowerCase(), templateKey: TPL })
    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.trackingNumber).toBe(TRACKING)
  })

  it('accumulates every shipment id under one pending notification', async () => {
    const { firestore, notifications } = makeMockFirestore()
    const shipmentIds = ['ship_1', 'ship_2', 'ship_3', 'ship_4', 'ship_5']
    const trackingNumber = '1Z999CC30345678606'

    for (const shipmentId of shipmentIds) {
      await enqueue({ firestore, orgSlug: ORG, trackingNumber, templateKey: TPL, shipmentIds: [shipmentId] })
    }

    expect(notifications.size).toBe(1)
    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual(shipmentIds)
  })

  it('does not duplicate a shipment id that is enqueued twice', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL, shipmentIds: ['ship_1'] })
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL, shipmentIds: ['ship_1', 'ship_2'] })
    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual(['ship_1', 'ship_2'])
  })

  it('defaults shipmentIds to an empty array when none are supplied', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: TPL })
    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual([])
  })

  it('writes under the org path so two orgs never share a queue item', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: 'acme', trackingNumber: TRACKING, templateKey: TPL })
    await enqueue({ firestore, orgSlug: 'other', trackingNumber: TRACKING, templateKey: TPL })
    expect(notifications.size).toBe(2)
    for (const path of notifications.keys()) {
      expect(path.startsWith('organizations/')).toBe(true)
    }
  })

  it('keeps different templates for one tracking number as separate notifications', async () => {
    const { firestore, notifications } = makeMockFirestore()
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: 'shipped' })
    await enqueue({ firestore, orgSlug: ORG, trackingNumber: TRACKING, templateKey: 'delivered' })
    expect(notifications.size).toBe(2)
  })
})

function makeQueryableFirestore() {
  const { firestore, notifications } = makeMockFirestore()

  firestore.collection = vi.fn((collectionPath) => {
    const filters = []
    let max = Infinity
    let order = null
    const query = {
      where: vi.fn((field, op, value) => { filters.push({ field, op, value }); return query }),
      orderBy: vi.fn((field, direction = 'asc') => { order = { field, direction }; return query }),
      limit: vi.fn((n) => { max = n; return query }),
      get: vi.fn(async () => {
        const docs = []
        for (const [docPath, data] of notifications) {
          if (!docPath.startsWith(`${collectionPath}/`)) continue
          const id = docPath.slice(collectionPath.length + 1)
          if (id.includes('/')) continue
          const matches = filters.every((f) => (f.op === '==' ? data[f.field] === f.value : true))
          if (matches) docs.push({ id, ref: firestore.doc(docPath), data: () => data })
        }
        if (order) {
          docs.sort((a, b) => {
            const av = a.data()[order.field] ?? ''
            const bv = b.data()[order.field] ?? ''
            if (av === bv) return 0
            return (av < bv ? -1 : 1) * (order.direction === 'desc' ? -1 : 1)
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

describe('claimBatch', () => {
  const ORG = 'acme'
  const TPL = 'delivered'
  const NOW = new Date('2026-08-13T12:00:00.000Z')

  async function seed(firestore, trackingNumbers, orgSlug = ORG) {
    for (const trackingNumber of trackingNumbers) {
      await enqueue({
        firestore,
        orgSlug,
        trackingNumber,
        templateKey: TPL,
        shipmentIds: [`s_${trackingNumber}`],
        now: NOW,
      })
    }
  }

  it('claims pending items up to the requested limit and no more', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1', 'T2', 'T3', 'T4', 'T5'])
    const claimed = await claimBatch({ firestore, orgSlug: ORG, limit: 2, now: NOW, workerId: 'w1' })
    expect(claimed).toHaveLength(2)
  })

  it('does not hand the same item to a second worker', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1', 'T2'])
    const first = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    const second = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w2' })
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)
  })

  it('marks a claimed item as sending, with the owning worker and a lease expiry', async () => {
    const { firestore, notifications } = makeQueryableFirestore()
    await seed(firestore, ['T1'])
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    const [item] = [...notifications.values()]
    expect(item.status).toBe('sending')
    expect(item.leaseOwner).toBe('w1')
    expect(Date.parse(item.leaseExpiresAt)).toBeGreaterThan(NOW.getTime())
  })

  it('does not touch the attempt count at claim time', async () => {
    const { firestore, notifications } = makeQueryableFirestore()
    await seed(firestore, ['T1'])
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    const [item] = [...notifications.values()]
    expect(item.attempts).toBe(0)
  })

  it('reclaims an item whose lease expired, so a crashed worker cannot strand it', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1'])
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    const reclaimed = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: later, workerId: 'w2' })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].leaseOwner).toBe('w2')
  })

  it('leaves an item alone while another worker still holds an unexpired lease', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1'])
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    const soon = new Date(NOW.getTime() + 1000)
    const second = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: soon, workerId: 'w2' })
    expect(second).toHaveLength(0)
  })

  it('never claims another org items', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1'], 'other')
    const claimed = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    expect(claimed).toHaveLength(0)
  })

  it('returns the shipment ids on each claimed item so the drain can render one message', async () => {
    const { firestore } = makeQueryableFirestore()
    await enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: 'T1',
      templateKey: TPL,
      shipmentIds: ['s_1', 's_2', 's_3'],
      now: NOW,
    })
    const [claimed] = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    expect(claimed.shipmentIds).toEqual(['s_1', 's_2', 's_3'])
    expect(claimed.trackingNumber).toBe('T1')
    expect(claimed.templateKey).toBe(TPL)
  })

  it('returns an empty batch rather than throwing when the queue is empty', async () => {
    const { firestore } = makeQueryableFirestore()
    const claimed = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    expect(claimed).toEqual([])
  })
})

describe('complete and fail', () => {
  const ORG = 'acme'
  const TPL = 'delivered'
  const TRACK = 'T1'
  const NOW = new Date('2026-08-13T12:00:00.000Z')

  async function seedClaimed(workerId = 'w1', now = NOW) {
    const { firestore, notifications } = makeQueryableFirestore()
    await enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: TRACK,
      templateKey: TPL,
      shipmentIds: ['s_1'],
      now,
    })
    const [item] = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now, workerId })
    return { firestore, notifications, item }
  }

  const IDENT = { orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL }

  it('marks a completed item sent, clears the lease, and records when it was sent', async () => {
    const { firestore, notifications } = await seedClaimed()
    const result = await complete({ firestore, ...IDENT, workerId: 'w1', now: NOW })
    expect(result.completed).toBe(true)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('sent')
    expect(item.leaseOwner).toBeNull()
    expect(item.leaseExpiresAt).toBeNull()
    expect(Number.isNaN(Date.parse(item.sentAt))).toBe(false)
  })

  it('never claims an item that has already been sent', async () => {
    const { firestore } = await seedClaimed()
    await complete({ firestore, ...IDENT, workerId: 'w1', now: NOW })
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    const claimed = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: later, workerId: 'w2' })
    expect(claimed).toHaveLength(0)
  })

  it('refuses to complete an item whose lease another worker now holds', async () => {
    const { firestore, notifications } = await seedClaimed('w1')
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: later, workerId: 'w2' })

    const result = await complete({ firestore, ...IDENT, workerId: 'w1', now: later })

    expect(result.completed).toBe(false)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('sending')
    expect(item.leaseOwner).toBe('w2')
  })

  it('returns a failed item to pending with an incremented attempt count and the error preserved', async () => {
    const { firestore, notifications } = await seedClaimed()
    const result = await fail({
      firestore,
      ...IDENT,
      workerId: 'w1',
      now: NOW,
      error: 'RingCentral SMS failed (500): upstream unavailable',
    })
    expect(result.failed).toBe(true)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('pending')
    expect(item.attempts).toBe(1)
    expect(item.lastError).toMatch(/upstream unavailable/)
    expect(item.leaseOwner).toBeNull()
  })

  it('backs a failed item off so the next drain does not retry it immediately', async () => {
    const { firestore, notifications } = await seedClaimed()
    await fail({ firestore, ...IDENT, workerId: 'w1', now: NOW, error: 'boom' })

    const [item] = [...notifications.values()]
    expect(Date.parse(item.nextAttemptAt)).toBeGreaterThan(NOW.getTime())

    const immediate = await claimBatch({
      firestore,
      orgSlug: ORG,
      limit: 10,
      now: new Date(NOW.getTime() + 1000),
      workerId: 'w2',
    })
    expect(immediate).toHaveLength(0)
  })

  it('retries a failed item once its backoff has elapsed', async () => {
    const { firestore } = await seedClaimed()
    await fail({ firestore, ...IDENT, workerId: 'w1', now: NOW, error: 'boom' })

    const muchLater = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
    const retried = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: muchLater, workerId: 'w2' })

    expect(retried).toHaveLength(1)
    expect(retried[0].attempts).toBe(1)
  })

  it('refuses to fail an item whose lease another worker now holds', async () => {
    const { firestore, notifications } = await seedClaimed('w1')
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: later, workerId: 'w2' })

    const result = await fail({ firestore, ...IDENT, workerId: 'w1', now: later, error: 'stale' })

    expect(result.failed).toBe(false)
    const [item] = [...notifications.values()]
    expect(item.attempts).toBe(0)
    expect(item.leaseOwner).toBe('w2')
  })

  it('retires an item to dead-letter once it has exhausted its attempts, preserving the last error', async () => {
    const { firestore, notifications } = await seedClaimed()
    await fail({
      firestore,
      ...IDENT,
      workerId: 'w1',
      now: NOW,
      error: 'invalid recipient',
      maxAttempts: 1,
    })

    const [item] = [...notifications.values()]
    expect(item.status).toBe('dead')
    expect(item.lastError).toMatch(/invalid recipient/)

    const weekLater = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
    const claimed = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: weekLater, workerId: 'w2' })
    expect(claimed).toHaveLength(0)
  })

  it('reports a miss rather than throwing when the item does not exist', async () => {
    const { firestore } = makeQueryableFirestore()
    const result = await complete({
      firestore,
      orgSlug: ORG,
      trackingNumber: 'NOT_QUEUED',
      templateKey: TPL,
      workerId: 'w1',
      now: NOW,
    })
    expect(result.completed).toBe(false)
  })
})

describe('release', () => {
  const ORG = 'acme'
  const TPL = 'delivered'
  const TRACK = 'T1'
  const NOW = new Date('2026-08-13T12:00:00.000Z')
  const IDENT = { orgSlug: ORG, trackingNumber: TRACK, templateKey: TPL }

  async function seedClaimed(workerId = 'w1', now = NOW) {
    const { firestore, notifications } = makeQueryableFirestore()
    await enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: TRACK,
      templateKey: TPL,
      shipmentIds: ['s_1'],
      now,
    })
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now, workerId })
    return { firestore, notifications }
  }

  it('hands a claimed item back to pending and clears the lease', async () => {
    const { firestore, notifications } = await seedClaimed()
    const result = await release({ firestore, ...IDENT, workerId: 'w1' })
    expect(result.released).toBe(true)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('pending')
    expect(item.leaseOwner).toBeNull()
    expect(item.leaseExpiresAt).toBeNull()
  })

  it('leaves a released item indistinguishable from one that was never claimed', async () => {
    const { firestore, notifications } = await seedClaimed()
    await release({ firestore, ...IDENT, workerId: 'w1' })

    const [item] = [...notifications.values()]
    expect(item.attempts).toBe(0)
    expect(item.lastError).toBeUndefined()

    const immediate = await claimBatch({
      firestore,
      orgSlug: ORG,
      limit: 10,
      now: new Date(NOW.getTime() + 1000),
      workerId: 'w2',
    })
    expect(immediate).toHaveLength(1)
    expect(immediate[0].attempts).toBe(0)
  })

  it('preserves the shipment ids so the next run still sends one message for the whole box', async () => {
    const { firestore, notifications } = makeQueryableFirestore()
    await enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: TRACK,
      templateKey: TPL,
      shipmentIds: ['s_1', 's_2', 's_3'],
      now: NOW,
    })
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: NOW, workerId: 'w1' })
    await release({ firestore, ...IDENT, workerId: 'w1' })

    const [item] = [...notifications.values()]
    expect(item.shipmentIds).toEqual(['s_1', 's_2', 's_3'])
  })

  it('refuses to release an item whose lease another worker now holds', async () => {
    const { firestore, notifications } = await seedClaimed('w1')
    const later = new Date(NOW.getTime() + 60 * 60 * 1000)
    await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: later, workerId: 'w2' })

    const result = await release({ firestore, ...IDENT, workerId: 'w1' })

    expect(result.released).toBe(false)
    const [item] = [...notifications.values()]
    expect(item.status).toBe('sending')
    expect(item.leaseOwner).toBe('w2')
  })

  it('reports a miss rather than throwing when the item does not exist', async () => {
    const { firestore } = makeQueryableFirestore()
    const result = await release({
      firestore,
      orgSlug: ORG,
      trackingNumber: 'NOT_QUEUED',
      templateKey: TPL,
      workerId: 'w1',
    })
    expect(result.released).toBe(false)
  })
})

describe('drainQueue', () => {
  const ORG = 'acme'
  const TPL = 'delivered'
  const NOW = new Date('2026-08-13T12:00:00.000Z')

  const queueItems = (notifications) => [...notifications.values()].filter((d) => d.templateKey)

  async function seed(firestore, trackingNumbers) {
    for (const trackingNumber of trackingNumbers) {
      await enqueue({
        firestore,
        orgSlug: ORG,
        trackingNumber,
        templateKey: TPL,
        shipmentIds: [`s_${trackingNumber}`],
        now: NOW,
      })
    }
  }

  it('sends one message per queued notification and marks each sent', async () => {
    const { firestore, notifications } = makeQueryableFirestore()
    await seed(firestore, ['T1', 'T2', 'T3'])
    const sendMessage = vi.fn(async () => ({ id: 'rc_1' }))

    const result = await drainQueue({
      firestore,
      orgSlug: ORG,
      workerId: 'w1',
      sendMessage,
      cap: 100,
      now: NOW,
    })

    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(result.sent).toBe(3)
    expect(queueItems(notifications).map((d) => d.status)).toEqual(['sent', 'sent', 'sent'])
  })

  it('stops at the daily cap and leaves the remainder claimable by the next run', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, ['T1', 'T2', 'T3', 'T4', 'T5'])
    const sendMessage = vi.fn(async () => ({ id: 'rc_1' }))

    const result = await drainQueue({
      firestore,
      orgSlug: ORG,
      workerId: 'w1',
      sendMessage,
      cap: 2,
      now: NOW,
    })

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(result.sent).toBe(2)
    expect(result.releasedForCap).toBe(3)

    const next = await claimBatch({
      firestore,
      orgSlug: ORG,
      limit: 10,
      now: new Date(NOW.getTime() + 1000),
      workerId: 'w2',
    })
    expect(next).toHaveLength(3)
    expect(next.every((item) => item.attempts === 0)).toBe(true)
  })

  it('fails only the item the provider rejected and keeps sending the rest', async () => {
    const { firestore, notifications } = makeQueryableFirestore()
    await seed(firestore, ['T1', 'T2', 'T3'])
    const sendMessage = vi.fn(async (item) => {
      if (item.trackingNumber === 'T2') throw new Error('RingCentral SMS failed (400): Bad number')
      return { id: 'rc_1' }
    })

    const result = await drainQueue({
      firestore,
      orgSlug: ORG,
      workerId: 'w1',
      sendMessage,
      cap: 100,
      now: NOW,
    })

    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(result.sent).toBe(2)
    expect(result.failed).toBe(1)

    const rejected = queueItems(notifications).find((d) => d.trackingNumber === 'T2')
    expect(rejected.status).toBe('pending')
    expect(rejected.attempts).toBe(1)
    expect(rejected.lastError).toMatch(/Bad number/)
  })

  it('hands the whole box to the sender so one message can cover every prescription in it', async () => {
    const { firestore } = makeQueryableFirestore()
    await enqueue({
      firestore,
      orgSlug: ORG,
      trackingNumber: 'T1',
      templateKey: TPL,
      shipmentIds: ['s_1', 's_2', 's_3'],
      now: NOW,
    })
    const sendMessage = vi.fn(async () => ({ id: 'rc_1' }))

    await drainQueue({ firestore, orgSlug: ORG, workerId: 'w1', sendMessage, cap: 100, now: NOW })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [item] = sendMessage.mock.calls[0]
    expect(item.shipmentIds).toEqual(['s_1', 's_2', 's_3'])
    expect(item.trackingNumber).toBe('T1')
    expect(item.templateKey).toBe(TPL)
  })

  it('never claims more than the requested page, so a huge queue cannot be loaded at once', async () => {
    const { firestore } = makeQueryableFirestore()
    await seed(firestore, Array.from({ length: 40 }, (_, i) => `T${i}`))
    const sendMessage = vi.fn(async () => ({ id: 'rc_1' }))

    const result = await drainQueue({
      firestore,
      orgSlug: ORG,
      workerId: 'w1',
      sendMessage,
      cap: 1000,
      now: NOW,
      limit: 10,
    })

    expect(result.claimed).toBe(10)
    expect(sendMessage).toHaveBeenCalledTimes(10)
  })

  it('does nothing and reports nothing when the queue is empty', async () => {
    const { firestore } = makeQueryableFirestore()
    const sendMessage = vi.fn()

    const result = await drainQueue({
      firestore,
      orgSlug: ORG,
      workerId: 'w1',
      sendMessage,
      cap: 100,
      now: NOW,
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, releasedForCap: 0 })
  })
})


describe('backoff and page fairness', () => {
  const ORG = 'acme'
  const TPL = 'delivered'
  const NOW = new Date('2026-08-13T12:00:00.000Z')

  it('does not let backed-off items starve the ready ones out of a page', async () => {
    const { firestore } = makeQueryableFirestore()
    const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000)
    const halfHourAgo = new Date(NOW.getTime() - 30 * 60 * 1000)

    const backedOff = ['B1', 'B2', 'B3', 'B4', 'B5']
    for (const trackingNumber of backedOff) {
      await enqueue({
        firestore,
        orgSlug: ORG,
        trackingNumber,
        templateKey: TPL,
        shipmentIds: [`s_${trackingNumber}`],
        now: anHourAgo,
      })
    }

    const toFail = await claimBatch({ firestore, orgSlug: ORG, limit: 10, now: anHourAgo, workerId: 'w0' })
    expect(toFail).toHaveLength(5)
    for (const item of toFail) {
      await fail({
        firestore,
        orgSlug: ORG,
        trackingNumber: item.trackingNumber,
        templateKey: TPL,
        workerId: 'w0',
        now: NOW,
        error: 'provider unavailable',
      })
    }

    const ready = ['R1', 'R2', 'R3', 'R4', 'R5']
    for (const trackingNumber of ready) {
      await enqueue({
        firestore,
        orgSlug: ORG,
        trackingNumber,
        templateKey: TPL,
        shipmentIds: [`s_${trackingNumber}`],
        now: halfHourAgo,
      })
    }

    const claimed = await claimBatch({
      firestore,
      orgSlug: ORG,
      limit: 5,
      now: new Date(NOW.getTime() + 1000),
      workerId: 'w1',
    })

    expect(claimed).toHaveLength(5)
    expect(claimed.map((item) => item.trackingNumber).sort()).toEqual(ready)
  })
})
