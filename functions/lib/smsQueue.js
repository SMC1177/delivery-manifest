import { claimSend, ledgerKey, requireField as coerceRequired } from './smsLedger.js'

/**
 * The SMS notification queue.
 *
 * Nothing sends directly any more. A notification is ENQUEUED here and a
 * scheduled drain sends it later. That buys four things at once: the daily cap
 * becomes pacing instead of a hard failure, several prescriptions in one box
 * collapse to one message before sending, a provider failure leaves the item
 * queued for retry instead of losing the message, and automated and manual
 * sends inherit identical guarantees because both enqueue.
 *
 * One document per (tracking number, template). The document ID is the ledger
 * key, so idempotency is a property of the path rather than a separate check
 * that can drift from the ledger's own derivation.
 */

function requireField(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`enqueue: ${name} is required`)
  }
  return coerceRequired(value, name, 'enqueue')
}

export function queuePath(orgSlug, trackingNumber, templateKey) {
  const org = requireField(orgSlug, 'orgSlug')
  const tracking = requireField(trackingNumber, 'trackingNumber')
  const template = requireField(templateKey, 'templateKey')
  return `${queueCollectionPath(org)}/${ledgerKey(tracking, template)}`
}

export async function enqueue({
  firestore,
  orgSlug,
  trackingNumber,
  templateKey,
  shipmentIds = [],
  now = new Date(),
}) {
  const claim = await claimSend({ firestore, orgSlug, trackingNumber, templateKey, now })
  if (!claim.claimed) {
    return { enqueued: false, reason: 'already_notified', trackingNumber }
  }
  const org = requireField(orgSlug, 'orgSlug')
  const tracking = requireField(trackingNumber, 'trackingNumber')
  const template = requireField(templateKey, 'templateKey')
  const path = queuePath(org, tracking, template)
  const ref = firestore.doc(path)
  const incoming = shipmentIds.map((id) => requireField(id, 'shipmentId'))
  const createdAt = now.toISOString()

  return await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const existing = snap.exists ? snap.data() || {} : null

    if (!existing) {
      tx.set(ref, {
        orgSlug: org,
        trackingNumber: tracking,
        templateKey: template,
        shipmentIds: [...new Set(incoming)],
        status: 'pending',
        attempts: 0,
        createdAt,
        nextAttemptAt: createdAt,
      })
      return { enqueued: true, trackingNumber }
    }

    const merged = [...new Set([...(existing.shipmentIds || []), ...incoming])]
    tx.set(ref, { ...existing, shipmentIds: merged })
    return { enqueued: true, trackingNumber }
  })
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000
const DEFAULT_BATCH_LIMIT = 25

/** Terminal states: an item in one of these is finished and must never be re-claimed. */
const TERMINAL_STATUSES = ['sent', 'dead']

/** Statuses a drain page may contain. Excludes terminal states so they cannot starve the page. */
const CLAIMABLE_STATUSES = ['pending', 'sending']

export function queueCollectionPath(orgSlug) {
  const org = requireField(orgSlug, 'orgSlug')
  return `organizations/${org}/settings/textMessaging/queue`
}

/**
 * Claim up to `limit` queue items for this worker.
 *
 * The claimability decision is made INSIDE the transaction rather than in the
 * query. An expired lease still has status 'sending', so a pending-only query
 * could never reclaim it; and two workers querying simultaneously see the same
 * rows, so only the in-transaction re-check decides which one actually wins.
 * The query filter is a bound on how much is read, not the correctness rule.
 */
export async function claimBatch({
  firestore,
  orgSlug,
  limit = DEFAULT_BATCH_LIMIT,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  workerId,
}) {
  const org = requireField(orgSlug, 'orgSlug')
  const worker = requireField(workerId, 'workerId')
  const nowMs = now.getTime()
  const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString()

  const page = await firestore
    .collection(queueCollectionPath(org))
    .where('status', 'in', CLAIMABLE_STATUSES)
    .orderBy('nextAttemptAt')
    .limit(limit)
    .get()

  const claimed = []

  for (const doc of page.docs) {
    if (claimed.length >= limit) break

    const taken = await firestore.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref)
      if (!fresh.exists) return null

      const data = fresh.data() || {}
      if (TERMINAL_STATUSES.includes(data.status)) return null

      if (data.nextAttemptAt) {
        const nextAttempt = Date.parse(data.nextAttemptAt)
        if (!Number.isNaN(nextAttempt) && nextAttempt > nowMs) return null
      }

      if (data.status === 'sending') {
        const expiresAt = data.leaseExpiresAt ? Date.parse(data.leaseExpiresAt) : NaN
        const held = !Number.isNaN(expiresAt) && expiresAt > nowMs
        if (held) return null
      }

      const updated = { ...data, status: 'sending', leaseOwner: worker, leaseExpiresAt }
      tx.set(doc.ref, updated)
      return { id: doc.id, ref: doc.ref, ...updated }
    })

    if (taken) claimed.push(taken)
  }

  return claimed
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 60 * 1000

/**
 * Apply a state change to a queue item, but ONLY if the caller still holds its
 * lease. A worker whose lease expired mid-send must not be able to write: by
 * then another worker may own the item and be sending it. Returns held:false
 * rather than throwing, because losing a lease is an ordinary race, not a bug.
 */
async function releaseItem({ firestore, orgSlug, trackingNumber, templateKey, workerId, apply }) {
  const org = requireField(orgSlug, 'orgSlug')
  const tracking = requireField(trackingNumber, 'trackingNumber')
  const template = requireField(templateKey, 'templateKey')
  const worker = requireField(workerId, 'workerId')
  const ref = firestore.doc(queuePath(org, tracking, template))

  return await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { held: false }

    const data = snap.data() || {}
    if (data.leaseOwner !== worker) return { held: false }

    const updated = apply(data)
    tx.set(ref, updated)
    return { held: true, item: updated }
  })
}

export async function complete({
  firestore,
  orgSlug,
  trackingNumber,
  templateKey,
  workerId,
  now = new Date(),
}) {
  const result = await releaseItem({
    firestore,
    orgSlug,
    trackingNumber,
    templateKey,
    workerId,
    apply: (data) => ({
      ...data,
      status: 'sent',
      leaseOwner: null,
      leaseExpiresAt: null,
      sentAt: now.toISOString(),
    }),
  })

  return { completed: result.held }
}

export async function fail({
  firestore,
  orgSlug,
  trackingNumber,
  templateKey,
  workerId,
  error,
  now = new Date(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  const message = error === undefined || error === null ? 'unknown error' : String(error)

  const result = await releaseItem({
    firestore,
    orgSlug,
    trackingNumber,
    templateKey,
    workerId,
    apply: (data) => {
      const attempts = (typeof data.attempts === 'number' ? data.attempts : 0) + 1
      const exhausted = attempts >= maxAttempts
      const backoff = backoffMs * Math.pow(2, attempts - 1)

      return {
        ...data,
        attempts,
        status: exhausted ? 'dead' : 'pending',
        lastError: message,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + backoff).toISOString(),
      }
    },
  })

  return { failed: result.held }
}

export async function release({ firestore, orgSlug, trackingNumber, templateKey, workerId }) {
  const result = await releaseItem({
    firestore,
    orgSlug,
    trackingNumber,
    templateKey,
    workerId,
    apply: (data) => ({
      ...data,
      status: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
    }),
  })

  return { released: result.held }
}
