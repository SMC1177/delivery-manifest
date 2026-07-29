// functions/__tests__/join-with-invite.test.js
// Adversarial security tests for redeemInviteAndJoin.
// Guards against the self-join hole: any signed-in user must NOT be able
// to create their own membership in any organization without a valid invite.
//
// Tests 1-7 mirror the harness used in validate-invite.test.js.
// Test 8 (rules text assertions) lives in platform-audit-rules.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
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
  FieldValue: {
    serverTimestamp: vi.fn(() => ({ _fv: 'serverTimestamp' })),
    increment: vi.fn((n) => ({ _fv: 'increment', n })),
    arrayUnion: vi.fn((...args) => ({ _fv: 'arrayUnion', args })),
  },
}))

import { redeemInviteAndJoin } from '../join-with-invite.js'

// ── Constants ────────────────────────────────────────────────────────────────
const futureDate = new Date(Date.now() + 365 * 86400000) // 1 year from now
const pastDate = new Date(Date.now() - 86400000) // 1 day ago

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock Firestore that supports the full callable flow:
 *   doc().get()          — for org existence pre-check
 *   collection().where().limit().get()  — for invite lookup
 *   runTransaction(cb)   — calls cb(t) where t has get/create/set/update
 *   collection('platformAudit').add()   — audit write
 *
 * Each option drives a different branch in the callable.
 */
function makeDb(options = {}) {
  const slug = options.slug || 'test-org'
  const uid = options.uid || 'test-uid'
  const inviteId = options.inviteId || 'invite-1'

  // ── doc().get() returns different snapshots per path ────────────────
  const docGetReturns = {}
  // Org doc pre-check
  if (options.orgExists !== undefined) {
    docGetReturns[`organizations/${slug}`] = {
      exists: !!options.orgExists,
      data: () => (options.orgData || {}),
    }
  }

  const docGet = vi.fn(async function () {
    const path = this._path
    if (docGetReturns[path] !== undefined) return docGetReturns[path]
    return { exists: false, data: () => ({}) }
  })

  const doc = vi.fn((path) => ({ _path: path, get: docGet.bind({ _path: path }) }))

  // ── invites collection query ───────────────────────────────────────
  const inviteDocs = options.inviteMatch
    ? [{ id: inviteId, data: () => ({ ...options.inviteMatch }) }]
    : []
  const invitesSnap = { empty: inviteDocs.length === 0, docs: inviteDocs }
  const invitesGet = vi.fn().mockResolvedValue(invitesSnap)
  const invitesQuery = {
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: invitesGet,
  }

  // ── platformAudit ──────────────────────────────────────────────────
  const auditAdd = options.auditFails
    ? vi.fn().mockRejectedValue(new Error('audit write failed'))
    : vi.fn().mockResolvedValue({ id: 'audit-1' })

  // ── collection router ──────────────────────────────────────────────
  const collection = vi.fn((path) => {
    if (path.includes('/invites')) return invitesQuery
    if (path === 'platformAudit') return { add: auditAdd }
    return { where: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), get: vi.fn() }
  })

  // ── transaction ────────────────────────────────────────────────────
  const memberExistsInTx = !!options.memberExistsInTx
  const inviteExistsInTx = options.inviteExistsInTx !== false // default true
  const inviteTxData = options.inviteDataInTx || options.inviteMatch || {}

  const tGet = vi.fn(async (ref) => {
    if (ref._path.includes('/members/')) {
      return {
        exists: memberExistsInTx,
        data: () => (options.memberDataInTx || {}),
      }
    }
    if (ref._path.includes('/invites/')) {
      return {
        exists: inviteExistsInTx,
        data: () => ({ ...inviteTxData }),
        id: inviteId,
      }
    }
    return { exists: false, data: () => ({}) }
  })

  const tCreate = vi.fn()
  const tSet = vi.fn()
  const tUpdate = vi.fn()
  const txHandler = { get: tGet, create: tCreate, set: tSet, update: tUpdate }

  const runTransaction = vi.fn(async (cb) => cb(txHandler))

  // ── assemble ───────────────────────────────────────────────────────
  const fakeDb = { doc, collection, runTransaction }

  return {
    fakeDb,
    doc,
    docGet,
    collection,
    invitesGet,
    auditAdd,
    runTransaction,
    txHandler,
    tGet,
    tCreate,
    tSet,
    tUpdate,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════════════════
describe('redeemInviteAndJoin — join-with-invite security invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Unauthenticated is rejected
  // ──────────────────────────────────────────────────────────────────────────
  it('rejects unauthenticated callers — no auth context means no membership path', async () => {
    const { fakeDb } = makeDb({ orgExists: true })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org', code: 'ANY' } }
    expect(request.auth).toBeUndefined()

    await expect(redeemInviteAndJoin(request)).rejects.toThrow(
      'You must be signed in to join an organization',
    )
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. THE CORE TEST — no invite, no membership
  //    If this test ever passes-through, the cross-org self-join hole is back.
  // ──────────────────────────────────────────────────────────────────────────
  it('CORE: no invite means no membership — rejects and writes nothing', async () => {
    const { fakeDb, runTransaction, tCreate, tSet, tUpdate } = makeDb({
      orgExists: true,
      inviteMatch: null, // no matching invite
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'attacker-uid', token: { email: 'evil@test.com' } },
      data: { slug: 'target-org', code: 'MADE-UP-CODE' },
    }

    await expect(redeemInviteAndJoin(request)).rejects.toThrow(
      'Invalid or expired invite code',
    )

    // MUST NOT enter the transaction — the guard is the pre-check.
    expect(runTransaction).not.toHaveBeenCalled()
    expect(tCreate).not.toHaveBeenCalled()
    expect(tSet).not.toHaveBeenCalled()
    expect(tUpdate).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3a. Expired invite rejected
  // ──────────────────────────────────────────────────────────────────────────
  it('rejects an expired invite — no membership written', async () => {
    const { fakeDb, runTransaction } = makeDb({
      orgExists: true,
      inviteMatch: {
        role: 'staff',
        code: 'EXPIRED-CODE',
        expiresAt: pastDate,
        maxUses: 10,
        usedCount: 1,
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'test-uid', token: { email: 'a@b.com' } },
      data: { slug: 'test-org', code: 'EXPIRED-CODE' },
    }

    await expect(redeemInviteAndJoin(request)).rejects.toThrow(
      'Invalid or expired invite code',
    )
    expect(runTransaction).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3b. Exhausted invite rejected
  // ──────────────────────────────────────────────────────────────────────────
  it('rejects an exhausted invite — usedCount already at maxUses', async () => {
    const { fakeDb, runTransaction } = makeDb({
      orgExists: true,
      inviteMatch: {
        role: 'staff',
        code: 'FULL-CODE',
        maxUses: 3,
        usedCount: 3,
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'test-uid', token: { email: 'a@b.com' } },
      data: { slug: 'test-org', code: 'FULL-CODE' },
    }

    await expect(redeemInviteAndJoin(request)).rejects.toThrow(
      'Invalid or expired invite code',
    )
    expect(runTransaction).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. No org enumeration — nonexistent org and wrong code indistinguishable
  // ──────────────────────────────────────────────────────────────────────────
  it('makes nonexistent org and wrong code indistinguishable to the caller', async () => {
    const authCtx = { uid: 'probe-uid', token: {} }

    // Case A: nonexistent org
    const { fakeDb: dbA } = makeDb({ orgExists: false, slug: 'no-such-org' })
    const { getFirestore: gfsA } = await import('firebase-admin/firestore')
    gfsA.mockReturnValue(dbA)

    let errorA = null
    try {
      await redeemInviteAndJoin({
        auth: authCtx,
        data: { slug: 'no-such-org', code: 'ANYTHING' },
      })
    } catch (e) {
      errorA = e
    }

    // Case B: real org, wrong code
    const { fakeDb: dbB } = makeDb({
      orgExists: true,
      slug: 'real-org',
      inviteMatch: null,
    })
    const { getFirestore: gfsB } = await import('firebase-admin/firestore')
    gfsB.mockReturnValue(dbB)

    let errorB = null
    try {
      await redeemInviteAndJoin({
        auth: authCtx,
        data: { slug: 'real-org', code: 'WRONG' },
      })
    } catch (e) {
      errorB = e
    }

    expect(errorA).toBeDefined()
    expect(errorB).toBeDefined()
    expect(errorA.code).toBe('permission-denied')
    expect(errorB.code).toBe('permission-denied')
    expect(errorA.message).toBe(errorB.message)
    expect(errorA.message).toBe('Invalid or expired invite code')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Valid code grants membership exactly once
  // ──────────────────────────────────────────────────────────────────────────
  it('grants membership for a valid invite — creates member doc, sets profile, increments usage', async () => {
    const slug = 'acme-corp'
    const uid = 'user-abc'
    const { fakeDb, runTransaction, tCreate, tSet, tUpdate, tGet } = makeDb({
      slug,
      uid,
      orgExists: true,
      orgData: { name: 'Acme Corp' },
      inviteMatch: {
        role: 'manager',
        code: 'SECRET-CODE',
        maxUses: 5,
        usedCount: 1,
        expiresAt: futureDate,
      },
      inviteId: 'inv-XYZ',
      memberExistsInTx: false,
      inviteDataInTx: {
        role: 'manager',
        code: 'SECRET-CODE',
        maxUses: 5,
        usedCount: 1,
        expiresAt: futureDate,
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: {
        uid,
        token: { name: 'Alice', email: 'alice@acme.com' },
      },
      data: { slug, code: '  SECRET-CODE  ' }, // trimming is intentional
    }

    const result = await redeemInviteAndJoin(request)

    // Return shape
    expect(result).toEqual({ success: true, role: 'manager', orgSlug: slug })

    // Transaction was entered
    expect(runTransaction).toHaveBeenCalledTimes(1)

    // t.get called for idempotence check then usage re-check
    expect(tGet).toHaveBeenCalledTimes(2)
    expect(tGet.mock.calls[0][0]._path).toBe(`organizations/${slug}/members/${uid}`)
    expect(tGet.mock.calls[1][0]._path).toBe(`organizations/${slug}/invites/inv-XYZ`)

    // Membership created with role + profile fields
    expect(tCreate).toHaveBeenCalledTimes(1)
    const [memberRefArg, memberData] = tCreate.mock.calls[0]
    expect(memberRefArg._path).toBe(`organizations/${slug}/members/${uid}`)
    expect(memberData).toMatchObject({
      role: 'manager',
      name: 'Alice',
      email: 'alice@acme.com',
      mfaEnrolled: false,
    })
    expect(memberData.joinedAt).toEqual({ _fv: 'serverTimestamp' })

    // Profile orgSlug set
    expect(tSet).toHaveBeenCalledTimes(1)
    const [profileRef, profileData, mergeOpt] = tSet.mock.calls[0]
    expect(profileRef._path).toBe(`userProfiles/${uid}`)
    expect(profileData).toEqual({ orgSlug: slug })
    expect(mergeOpt).toEqual({ merge: true })

    // Invite usage incremented by exactly one
    expect(tUpdate).toHaveBeenCalledTimes(1)
    const [inviteRefArg, usageData] = tUpdate.mock.calls[0]
    expect(inviteRefArg._path).toBe(`organizations/${slug}/invites/inv-XYZ`)
    expect(usageData.usedCount).toEqual({ _fv: 'increment', n: 1 })
    expect(usageData.usedBy).toEqual({ _fv: 'arrayUnion', args: [uid] })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Idempotence — already-member caller does not double-count usage
  // ──────────────────────────────────────────────────────────────────────────
  it('is idempotent — an already-member calling again does not increment usedCount or append to usedBy', async () => {
    // Simulates two concurrent redemptions racing through the pre-check.
    // Pre-check: invite looks available (maxUses=5, usedCount=0).
    // Race: one call already created the member; our re-read finds member exists.
    // The idempotence guard inside the transaction must bail out without writes.
    const { fakeDb, runTransaction, tCreate, tSet, tUpdate, tGet } = makeDb({
      slug: 'my-org',
      uid: 'existing-member',
      orgExists: true,
      inviteMatch: {
        role: 'staff',
        code: 'ONCE-ONLY',
        maxUses: 5,
        usedCount: 0,
      },
      inviteId: 'inv-single',
      memberExistsInTx: true, // ← a racing caller already created the membership
      inviteDataInTx: {
        role: 'staff',
        maxUses: 5,
        usedCount: 0,
        expiresAt: futureDate,
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'existing-member', token: { email: 'member@org.com' } },
      data: { slug: 'my-org', code: 'ONCE-ONLY' },
    }

    // Should NOT throw — idempotent success
    const result = await redeemInviteAndJoin(request)
    expect(result).toEqual({ success: true, role: 'staff', orgSlug: 'my-org' })

    // Transaction ran
    expect(runTransaction).toHaveBeenCalledTimes(1)

    // t.get was called for member doc (found existing) — then bailed out
    // It should NOT have called t.get on invite (no re-check needed when bailing)
    // It should NOT create/set/update anything
    expect(tCreate).not.toHaveBeenCalled()
    expect(tSet).not.toHaveBeenCalled()
    expect(tUpdate).not.toHaveBeenCalled()

    // Verify tGet was called at most once (only for member, not invite)
    // If it was called twice, the implementation did extra work after finding the member
    const memberCalls = tGet.mock.calls.filter(([ref]) =>
      ref._path.includes('/members/'),
    )
    expect(memberCalls.length).toBe(1)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Concurrency intent — usage re-check is INSIDE the transaction
  // ──────────────────────────────────────────────────────────────────────────
  it('re-checks usage inside the transaction — a race past the pre-check is caught', async () => {
    // Pre-check state: usedCount=0, maxUses=1 → passes pre-check
    // Transaction state: usedCount=1, maxUses=1 → another caller burned
    //   the last slot between pre-check and transaction commit.
    // If the re-check were absent, this would silently over-redeem.
    const { fakeDb, runTransaction, tCreate, tSet, tUpdate } = makeDb({
      orgExists: true,
      inviteMatch: {
        role: 'staff',
        code: 'RACE-ME',
        maxUses: 1,
        usedCount: 0, // ← passes pre-check
        expiresAt: futureDate,
      },
      inviteDataInTx: {
        role: 'staff',
        maxUses: 1,
        usedCount: 1, // ← exhausted by the time the transaction runs
        expiresAt: futureDate,
      },
      memberExistsInTx: false,
      inviteExistsInTx: true,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'racer-2', token: { email: 'racer2@test.com' } },
      data: { slug: 'test-org', code: 'RACE-ME' },
    }

    await expect(redeemInviteAndJoin(request)).rejects.toThrow(
      'Invalid or expired invite code',
    )

    // The call should have ENTERED the transaction (pre-check passed).
    expect(runTransaction).toHaveBeenCalledTimes(1)

    // But it must NOT have written anything — the internal re-check caught it.
    expect(tCreate).not.toHaveBeenCalled()
    expect(tSet).not.toHaveBeenCalled()
    expect(tUpdate).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Extra edge: the callable records an audit event on successful join
  // ──────────────────────────────────────────────────────────────────────────
  it('writes a platformAudit entry on successful join', async () => {
    const { fakeDb, auditAdd } = makeDb({
      orgExists: true,
      inviteMatch: {
        role: 'staff',
        code: 'AUDIT-ME',
        maxUses: 5,
        usedCount: 0,
      },
      memberExistsInTx: false,
      inviteDataInTx: {
        role: 'staff',
        maxUses: 5,
        usedCount: 0,
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'auditor', token: { email: 'auditor@test.com' } },
      data: { slug: 'test-org', code: 'AUDIT-ME' },
    }

    await redeemInviteAndJoin(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const auditData = auditAdd.mock.calls[0][0]
    expect(auditData).toMatchObject({
      actor: 'auditor',
      actorEmail: 'auditor@test.com',
      action: 'join_org_via_invite',
      orgSlug: 'test-org',
      inviteId: 'invite-1',
    })
    expect(auditData.at).toEqual({ _fv: 'serverTimestamp' })
  })
})
