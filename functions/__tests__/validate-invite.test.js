import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-functions/v2/https', () => {
  class HttpsError extends Error {
    constructor(code, message) {
      super(message)
      this.code = code
    }
  }
  return {
    onCall: vi.fn((handler) => handler),
    HttpsError,
  }
})

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
}))

import { validateInvite } from '../validate-invite.js'

function makeFakeDb({ orgSnap = null, invitesSnap = null } = {}) {
  const defaultOrgSnap = orgSnap || { exists: false, data: () => ({}) }
  const defaultInvites = invitesSnap || { empty: true, docs: [] }

  const docGet = vi.fn().mockResolvedValue(defaultOrgSnap)
  const docRef = { get: docGet }
  const doc = vi.fn().mockReturnValue(docRef)

  const invitesGet = vi.fn().mockResolvedValue(defaultInvites)
  const queryObj = {
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: invitesGet,
  }
  const collection = vi.fn().mockReturnValue(queryObj)

  const fakeDb = { doc, collection }

  return { fakeDb, doc, docGet, collection, invitesGet }
}

const futureDate = new Date(Date.now() + 86400000 * 365) // 1 year from now
const pastDate = new Date(Date.now() - 86400000) // 1 day ago

describe('validateInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ============================================================================
  // 1. Unauthenticated access — the whole point of this callable.
  // ============================================================================
  it('succeeds for a valid code with no auth context at all', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'manager', code: 'ABC123' }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    // Deliberately omit auth — the request object has no .auth property.
    const request = { data: { slug: 'test-org', code: 'ABC123' } }
    expect(request.auth).toBeUndefined()

    const result = await validateInvite(request)

    expect(result).toEqual({
      valid: true,
      orgName: 'Test Org',
      role: 'manager',
      inviteId: 'invite1',
    })
  })

  // ============================================================================
  // 2. Response whitelist — the single most important test.
  // ============================================================================
  it('returns ONLY expected keys for a valid invite (response whitelist)', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{
        id: 'invite1',
        data: () => ({
          role: 'manager',
          code: 'ABC123',
          createdBy: 'admin@test.com',
          usedBy: ['user1', 'user2'],
          maxUses: 10,
          usedCount: 3,
          expiresAt: futureDate,
          extraField: 'must-not-leak',
        }),
      }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'ABC123' } })

    // Exact key set — categorically rejects any leak.
    expect(Object.keys(result).sort()).toEqual(['inviteId', 'orgName', 'role', 'valid'])
    expect(result.valid).toBe(true)
    expect(result.orgName).toBe('Test Org')
    expect(result.role).toBe('manager')
    expect(result.inviteId).toBe('invite1')
  })

  // ============================================================================
  // 3. Org enumeration — missing org and wrong code MUST be indistinguishable.
  // ============================================================================
  it('returns indistinguishable responses for non-existent org and wrong code', async () => {
    // Case A: org does not exist
    const { fakeDb: dbA } = makeFakeDb({
      orgSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore: gfsA } = await import('firebase-admin/firestore')
    gfsA.mockReturnValue(dbA)

    const resultA = await validateInvite({ data: { slug: 'nonexistent', code: 'ANYCODE' } })

    // Case B: org exists but code is wrong (invite not found)
    const orgSnap = { exists: true, data: () => ({ name: 'Real Org' }) }
    const invitesSnap = { empty: true, docs: [] }
    const { fakeDb: dbB } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore: gfsB } = await import('firebase-admin/firestore')
    gfsB.mockReturnValue(dbB)

    const resultB = await validateInvite({ data: { slug: 'real-org', code: 'WRONG' } })

    // Each individually must match the expected shape.
    expect(resultA).toEqual({ valid: false, reason: 'invalid' })
    expect(resultB).toEqual({ valid: false, reason: 'invalid' })

    // Deep equality — if these differ AT ALL the function leaks org existence.
    expect(resultA).toEqual(resultB)
  })

  // ============================================================================
  // 4. Expired invite — past expiresAt.
  // ============================================================================
  it('returns expired verdict for an invite with a past expiresAt', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'EXPIRED', expiresAt: pastDate }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'EXPIRED' } })
    expect(result).toEqual({ valid: false, reason: 'expired' })
  })

  it('returns expired verdict for Firestore Timestamp with past toDate()', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const tsPast = { toDate: () => pastDate }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'TSEXP', expiresAt: tsPast }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'TSEXP' } })
    expect(result).toEqual({ valid: false, reason: 'expired' })
  })

  // ============================================================================
  // 5. Exhausted invite — usedCount has reached maxUses.
  // ============================================================================
  it('returns exhausted verdict when usedCount equals maxUses', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{
        id: 'invite1',
        data: () => ({ role: 'staff', code: 'FULL', maxUses: 3, usedCount: 3 }),
      }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'FULL' } })
    expect(result).toEqual({ valid: false, reason: 'exhausted' })
  })

  it('returns exhausted verdict when usedCount exceeds maxUses', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{
        id: 'invite1',
        data: () => ({ role: 'staff', code: 'OVER', maxUses: 3, usedCount: 5 }),
      }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'OVER' } })
    expect(result).toEqual({ valid: false, reason: 'exhausted' })
  })

  it('treats maxUses of 0 as unlimited', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{
        id: 'invite1',
        data: () => ({ role: 'staff', code: 'UNLIM', maxUses: 0, usedCount: 999 }),
      }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'UNLIM' } })
    expect(result.valid).toBe(true)
  })

  // ============================================================================
  // 6. Input validation — slug rejection.
  // ============================================================================
  it('rejects non-string slug (number)', async () => {
    await expect(
      validateInvite({ data: { slug: 123, code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  it('rejects null slug', async () => {
    await expect(
      validateInvite({ data: { slug: null, code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  it('rejects empty string slug', async () => {
    await expect(
      validateInvite({ data: { slug: '', code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  it('rejects whitespace-only slug', async () => {
    await expect(
      validateInvite({ data: { slug: '   ', code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  it('rejects over-long slug (>128 chars)', async () => {
    await expect(
      validateInvite({ data: { slug: 'a'.repeat(129), code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  it('rejects slug containing a slash', async () => {
    await expect(
      validateInvite({ data: { slug: 'evil/slug', code: 'ABC' } })
    ).rejects.toThrow('slug must be a non-empty string')
  })

  // ============================================================================
  // 6b. Input validation — code rejection.
  // ============================================================================
  it('rejects non-string code (number)', async () => {
    await expect(
      validateInvite({ data: { slug: 'test', code: 456 } })
    ).rejects.toThrow('code must be a non-empty string')
  })

  it('rejects null code', async () => {
    await expect(
      validateInvite({ data: { slug: 'test', code: null } })
    ).rejects.toThrow('code must be a non-empty string')
  })

  it('rejects empty string code', async () => {
    await expect(
      validateInvite({ data: { slug: 'test', code: '' } })
    ).rejects.toThrow('code must be a non-empty string')
  })

  it('rejects whitespace-only code', async () => {
    await expect(
      validateInvite({ data: { slug: 'test', code: '   ' } })
    ).rejects.toThrow('code must be a non-empty string')
  })

  it('rejects over-long code (>64 chars)', async () => {
    await expect(
      validateInvite({ data: { slug: 'test', code: 'a'.repeat(65) } })
    ).rejects.toThrow('code must be a non-empty string')
  })

  // ============================================================================
  // 7. expiresAt handling — Timestamp, Date, and missing.
  // ============================================================================
  it('handles Firestore-Timestamp-like object with toDate() for expiresAt', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const tsFuture = { toDate: () => futureDate }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'TSFUTURE', expiresAt: tsFuture }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'TSFUTURE' } })
    expect(result).toEqual({ valid: true, orgName: 'Test Org', role: 'staff', inviteId: 'invite1' })
  })

  it('handles plain Date for expiresAt', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'DATEFUTURE', expiresAt: futureDate }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'DATEFUTURE' } })
    expect(result).toEqual({ valid: true, orgName: 'Test Org', role: 'staff', inviteId: 'invite1' })
  })

  it('treats missing expiresAt as not expired', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'NOEXP' }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'NOEXP' } })
    // Should not crash; should be valid.
    expect(result).toEqual({ valid: true, orgName: 'Test Org', role: 'staff', inviteId: 'invite1' })
  })

  // ============================================================================
  // 8. Internal error handling.
  // ============================================================================
  it('throws internal error when Firestore fails unexpectedly', async () => {
    const { fakeDb, doc } = makeFakeDb({})
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    doc.mockReturnValue({
      get: vi.fn().mockRejectedValue(new Error('Firestore connection failure')),
    })

    await expect(
      validateInvite({ data: { slug: 'test-org', code: 'ANY' } })
    ).rejects.toThrow('Unable to validate invite')
  })

  // ============================================================================
  // 9. Edge cases — defaults.
  // ============================================================================
  it('defaults role to "staff" when invite has no role field', async () => {
    const orgSnap = { exists: true, data: () => ({ name: 'Test Org' }) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ code: 'NOROLE' }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'NOROLE' } })
    expect(result.role).toBe('staff')
  })

  it('falls back to slug for orgName when org doc has no name', async () => {
    const orgSnap = { exists: true, data: () => ({}) }
    const invitesSnap = {
      empty: false,
      docs: [{ id: 'invite1', data: () => ({ role: 'staff', code: 'NOORGNAME' }) }],
    }

    const { fakeDb } = makeFakeDb({ orgSnap, invitesSnap })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await validateInvite({ data: { slug: 'test-org', code: 'NOORGNAME' } })
    expect(result.orgName).toBe('test-org')
  })

  it('rejects request with undefined data', async () => {
    await expect(
      validateInvite({ data: undefined })
    ).rejects.toThrow('slug must be a non-empty string')
  })
})
