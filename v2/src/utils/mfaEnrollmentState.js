/**
 * Resolve 2FA enrollment state from the live Auth factor count.
 *
 * The legacy `storedFlag` (Firestore `mfaEnrolled` boolean) drifts from
 * Firebase Auth's truth: it can say "protected" while Auth holds zero
 * factors, hiding the enrollment QR.
 *
 * There are two kinds of unknown, and they resolve differently:
 *  - User is signed in but the factor read is still in flight (no valid
 *    count yet): return 'checking' — never guess while we can still learn.
 *  - There is no user to read from (hasUser === false): there is nothing
 *    to await, so fall back to `storedFlag` instead of leaving the 2FA
 *    section permanently 'checking' for signed-out edges and test envs.
 *
 * A valid live count (non-negative integer) always wins, even when
 * hasUser is false — a count can only have come from a real read.
 */
export function resolveMfaEnrollmentState({ storedFlag, liveFactorCount, hasUser }) {
  // A valid live count (non-negative integer) wins over everything,
  // including hasUser === false: it can only have come from a real read.
  if (typeof liveFactorCount === 'number' && Number.isInteger(liveFactorCount) && liveFactorCount >= 0) {
    return liveFactorCount >= 1 ? 'enrolled' : 'not-enrolled';
  }

  // No valid count — user is present, so the read is still in flight.
  // Never guess; 'checking' keeps the section pending.
  if (hasUser === true) return 'checking';

  // No user: there is nothing to await. Fall back to the stored flag so
  // signed-out edges and test environments are not stuck on 'checking'.
  return storedFlag === true ? 'enrolled' : 'not-enrolled';
}
