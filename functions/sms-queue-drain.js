import { claimBatch, complete, fail, release } from './lib/smsQueue.js'
import { checkAndIncrementRateLimit, shouldHoldForWindow } from './sms-rate-limit.js'

const DEFAULT_LIMIT = 25

/**
 * Drain a bounded page of the org's SMS queue.
 *
 * Deliberately NOT here: a ledger claim. The claim is taken at ENQUEUE time and
 * persists; taking a second one here would find it already held and nothing
 * would ever send. Mutual exclusion between drain workers is the queue item's
 * own lease, not the ledger.
 */
export async function drainQueue({
  firestore,
  orgSlug,
  workerId,
  sendMessage,
  cap,
  now = new Date(),
  limit = DEFAULT_LIMIT,
}) {
  const claimed = await claimBatch({ firestore, orgSlug, limit, now, workerId })
  const summary = { claimed: claimed.length, sent: 0, failed: 0, releasedForCap: 0, heldForWindow: 0 }
  if (claimed.length === 0) return summary

  let capReached = false

  for (const item of claimed) {
    const ident = {
      firestore,
      orgSlug,
      trackingNumber: item.trackingNumber,
      templateKey: item.templateKey,
      workerId,
    }

    if (capReached) {
      await release(ident)
      summary.releasedForCap += 1
      continue
    }

    // The 8 o'clock hour is reserved for prior-day items. A same-day item is put
    // back rather than sent: release() keeps its queue place and costs it nothing
    // (only fail() increments attempts), and holding BEFORE the cap check means a
    // held item does not consume one of the day's 250 sends.
    if (shouldHoldForWindow({ now, createdAt: item.createdAt })) {
      await release(ident)
      summary.heldForWindow += 1
      continue
    }

    const allowance = await checkAndIncrementRateLimit({ firestore, orgSlug, cap, now })
    if (!allowance.allowed) {
      capReached = true
      await release(ident)
      summary.releasedForCap += 1
      continue
    }

    try {
      await sendMessage(item)
      await complete({ ...ident, now })
      summary.sent += 1
    } catch (err) {
      await fail({ ...ident, now, error: err && err.message ? err.message : String(err) })
      summary.failed += 1
    }
  }

  return summary
}
