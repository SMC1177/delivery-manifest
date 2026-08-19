const CENTRAL_TZ = 'America/Chicago'

/**
 * Compute YYYY-MM-DD for a given Date in the given timezone.
 */
export function todayKey(date = new Date(), tz = CENTRAL_TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // Queue items store timestamps as ISO STRINGS (lib/smsQueue.js writes
  // now.toISOString()), so callers legitimately pass a string here. Intl's
  // format() throws RangeError on anything that is not a Date — measured
  // 2026-08-19, when it crashed the whole drain on the first real item.
  const d = date instanceof Date ? date : new Date(date)
  return fmt.format(d) // en-CA gives YYYY-MM-DD
}

/**
 * Should an item created at `createdAt` be HELD (not sent) at `now`?
 *
 * The 8 o'clock hour is reserved for PRIOR-DAY items: anything created
 * today waits until 9:00 so yesterday's backlog drains first. Both the
 * hour and the day key are computed in America/Chicago via Intl so the
 * cap day, the hold day and the window hour can never disagree (DST-safe).
 *
 * hold  ⟺  hour(now, America/Chicago) === 8 AND todayKey(createdAt) === todayKey(now)
 */
export function shouldHoldForWindow({ now, createdAt }) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CENTRAL_TZ,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  )
  // An unparseable createdAt must not take the whole org's drain down with it.
  // The cron already confines every send to 08:00-18:55 Central, so failing
  // OPEN here cannot produce an out-of-hours message — it only forfeits the
  // prior-day reservation for one malformed row.
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(created.getTime())) return false
  return hour === 8 && todayKey(created) === todayKey(now)
}

/**
 * Atomic check-and-increment against the per-org daily cap.
 * Returns { allowed: boolean, current: number, cap: number }.
 */
/**
 * Is `now` inside the operator's send window? 8am through 7pm America/Chicago.
 *
 * The cron already confines the scheduled drain to these hours, and a staff send
 * goes through the queue and inherits them. This exists for the ONE path that
 * reaches the provider directly: the inbound webhook's auto-replies, which before
 * B.5 could fire a STOP confirmation at 3am.
 *
 * Same Central Intl computation as todayKey and shouldHoldForWindow, deliberately,
 * so the three time rules in this module cannot drift apart. hour 18 is the six
 * o'clock hour, so the window closes at 19:00 exactly.
 */
export function isWithinSendWindow({ now }) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CENTRAL_TZ,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  )
  return hour >= 8 && hour <= 18
}

export async function checkAndIncrementRateLimit({ firestore, orgSlug, cap, now = new Date() }) {
  const key = todayKey(now)
  const path = `organizations/${orgSlug}/settings/textMessaging/usage/${key}`
  const ref = firestore.doc(path)

  return await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const current = snap.exists ? snap.data().count : 0
    if (current >= cap) {
      return { allowed: false, current, cap }
    }
    tx.set(ref, { count: current + 1, capWhenWritten: cap })
    return { allowed: true, current: current + 1, cap }
  })
}
