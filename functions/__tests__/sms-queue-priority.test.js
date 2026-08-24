import { describe, it, expect, vi } from 'vitest'
import { claimBatch } from '../lib/smsQueue.js'

/**
 * A query-capable firestore mock: claimBatch reads a page via
 * collection().where().orderBy().orderBy().limit().get() and then claims each
 * doc in a transaction. The mock sorts claimable items by nextAttemptAt then
 * createdAt — exactly what the real query does — so what is under test is the
 * CLAIM ORDER the drain produces, not the mock's ordering.
 */
function makeQueryableFirestore(seed) {
  const items = new Map(Object.entries(seed))
  const refFor = (id) => ({ _id: id })

  const firestore = {
    collection: vi.fn(() => {
      const query = {
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn((n) => {
          query._limit = n
          return query
        }),
        get: vi.fn(async () => {
          const docs = [...items.entries()]
            .filter(([, d]) => d.status === 'pending' || d.status === 'sending')
            .sort(([, a], [, b]) =>
              a.nextAttemptAt < b.nextAttemptAt ? -1 : a.nextAttemptAt > b.nextAttemptAt ? 1 :
              a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
            .slice(0, query._limit ?? Infinity)
            .map(([id, d]) => ({ id, ref: refFor(id), data: () => ({ ...d }) }))
          return { docs }
        }),
      }
      return query
    }),
    runTransaction: vi.fn(async (fn) =>
      fn({
        get: vi.fn(async (ref) => {
          const entry = items.get(ref._id)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => {
          items.set(ref._id, data)
        }),
      })
    ),
  }
  return { firestore, items }
}

const item = (templateKey, at) => ({
  orgSlug: 'acme',
  trackingNumber: `TN-${templateKey}-${at}`,
  templateKey,
  shipmentIds: ['s_1'],
  status: 'pending',
  attempts: 0,
  createdAt: at,
  nextAttemptAt: at,
})

const NOW = new Date('2026-08-24T12:00:00.000Z')

const seedMixed = () => ({
  'a__outForDelivery': item('outForDelivery', '2026-08-24T10:00:00.000Z'),
  'b__outForDelivery': item('outForDelivery', '2026-08-24T10:01:00.000Z'),
  'c__addressIssue': item('addressIssue', '2026-08-24T10:02:00.000Z'),
  'd__trackingAssigned': item('trackingAssigned', '2026-08-24T11:00:00.000Z'),
  'e__trackingAssigned': item('trackingAssigned', '2026-08-24T11:01:00.000Z'),
})

describe('queue priority — the initial message drains first', () => {
  it('claims every trackingAssigned item before any other template, despite older competitors', async () => {
    const { firestore } = makeQueryableFirestore(seedMixed())
    const claimed = await claimBatch({ firestore, orgSlug: 'acme', workerId: 'w1', limit: 5, now: NOW })
    expect(claimed.map((c) => c.templateKey)).toEqual([
      'trackingAssigned',
      'trackingAssigned',
      'outForDelivery',
      'outForDelivery',
      'addressIssue',
    ])
  })

  it('a page smaller than the initial backlog holds ONLY trackingAssigned items', async () => {
    const { firestore } = makeQueryableFirestore(seedMixed())
    const claimed = await claimBatch({ firestore, orgSlug: 'acme', workerId: 'w1', limit: 2, now: NOW })
    expect(claimed.map((c) => c.templateKey)).toEqual(['trackingAssigned', 'trackingAssigned'])
  })

  it('within the priority class the time order is preserved', async () => {
    const { firestore } = makeQueryableFirestore(seedMixed())
    const claimed = await claimBatch({ firestore, orgSlug: 'acme', workerId: 'w1', limit: 5, now: NOW })
    expect(claimed[0].trackingNumber).toBe('TN-trackingAssigned-2026-08-24T11:00:00.000Z')
    expect(claimed[1].trackingNumber).toBe('TN-trackingAssigned-2026-08-24T11:01:00.000Z')
  })

  it('without initial items the existing oldest-first order is unchanged', async () => {
    const seed = seedMixed()
    delete seed['d__trackingAssigned']
    delete seed['e__trackingAssigned']
    const { firestore } = makeQueryableFirestore(seed)
    const claimed = await claimBatch({ firestore, orgSlug: 'acme', workerId: 'w1', limit: 5, now: NOW })
    expect(claimed.map((c) => c.templateKey)).toEqual(['outForDelivery', 'outForDelivery', 'addressIssue'])
  })
})
