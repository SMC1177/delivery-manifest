import { describe, it, expect } from 'vitest'
import { resolveMfaEnrollmentState } from '../utils/mfaEnrollmentState'

describe('resolveMfaEnrollmentState', () => {
  it('resolves not-enrolled when the stored flag is stale TRUE but the live factor count is zero', () => {
    // The real bug: AccountModal.jsx reads a denormalized flag (mfaEnrolled === true) and
    // tells the user "Two-factor authentication is enabled" while Firebase Auth holds ZERO
    // enrolled factors — and hides the enrollment QR behind that same branch, so the user
    // cannot fix it themselves.
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: 0, hasUser: true })).toBe('not-enrolled')
  })

  it('resolves enrolled when the live factor count is >= 1 even if the flag never updated', () => {
    // A user who enrolled on a second device while the flag never synced must see management
    // UI, not the enrollment QR again — offering double-enrollment is a mistake.
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: 1, hasUser: true })).toBe('enrolled')
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: 2, hasUser: true })).toBe('enrolled')
  })

  it('resolves enrolled when the stale-able flag and the live factors agree', () => {
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: 1, hasUser: true })).toBe('enrolled')
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: 3, hasUser: true })).toBe('enrolled')
  })

  it('resolves not-enrolled when the stale-able flag and the live factors agree on zero', () => {
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: 0, hasUser: true })).toBe('not-enrolled')
  })

  it('resolves checking while factors have not been read yet, regardless of the stored flag', () => {
    // checking is its own state: do not treat it as not-enrolled (rendering the QR to an
    // enrolled user invites double-enrollment) nor as enrolled (recreates the original bug).
    // This only applies when a user exists to read from; without a user we fall back below.
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: null, hasUser: true })).toBe('checking')
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: null, hasUser: true })).toBe('checking')
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: undefined, hasUser: true })).toBe('checking')
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: undefined, hasUser: true })).toBe('checking')
  })

  it('falls back to the stored flag when there is no user to read factors from', () => {
    // With no user (signed out, or a test env without auth.currentUser) there is nothing to
    // await — resolving 'checking' would hang forever and blank the 2FA section in signed-out
    // edges and every test environment. The stored flag is the only signal we have.
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: null, hasUser: false })).toBe('enrolled')
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: null, hasUser: false })).toBe('not-enrolled')
  })

  it('still lets a valid live factor count win even without a user object', () => {
    // A count can only have come from a real read, so it outranks the fallback-to-flag branch.
    expect(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: 1, hasUser: false })).toBe('enrolled')
    expect(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: 0, hasUser: false })).toBe('not-enrolled')
  })

  it('never resolves the falsely-reassuring state for garbage factor counts', () => {
    // A negative or NaN count must never resolve 'enrolled' — assert it lands in a safe state.
    expect(['checking', 'not-enrolled']).toContain(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: -1, hasUser: true }))
    expect(['checking', 'not-enrolled']).toContain(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: -1, hasUser: true }))
    expect(['checking', 'not-enrolled']).toContain(resolveMfaEnrollmentState({ storedFlag: false, liveFactorCount: NaN, hasUser: true }))
    expect(['checking', 'not-enrolled']).toContain(resolveMfaEnrollmentState({ storedFlag: true, liveFactorCount: NaN, hasUser: true }))
  })
})
