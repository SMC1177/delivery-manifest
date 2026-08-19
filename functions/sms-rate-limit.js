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
  return fmt.format(date) // en-CA gives YYYY-MM-DD
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
  return hour === 8 && todayKey(createdAt) === todayKey(now)
}

/**
 * Atomic check-and-increment against the per-org daily cap.
 * Returns { allowed: boolean, current: number, cap: number }.
 */
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
