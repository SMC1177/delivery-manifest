// functions/__tests__/staff-lifecycle.test.js
// RED-FIRST adversarial suite for the three staff-lifecycle callables in
// functions/staff-lifecycle.js. That module does NOT exist yet, so this suite
// is EXPECTED TO FAIL TO LOAD (the static import below throws until the
// s2-impl-callables snippet lands). A green result here would be a failed
// proof — the orchestrator runs this suite and expects a load failure.
//
// The defect being pinned: a staff member is THREE records —
//   1. the Firebase Auth login
//   2. userProfiles/{uid}
//   3. organizations/{slug}/members/{uid}
// The browser SDK cannot delete another user's Auth account (Admin SDK only),
// so the old removeMember flow deleted only the member doc and the login
// survived, permanently holding that person's email. Re-adding that person
// then failed with "email already in use". The discriminating assertions in
// the removeStaffAccount success case check ALL THREE deletions separately
// (and the last-admin case checks that NONE happen).
//
// "Admin" means the CALLER's member doc for THAT org has role === 'admin',
// mirroring the gate in archive-shipments.js / sms-save-creds.js:
//   if (!memberSnap.exists || memberSnap.data().role !== 'admin') throw ...
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

// Auth contract the callables must speak: getAuth() exposes deleteUser,
// getUserByEmail and generateEmailVerificationLink. createUser is present ONLY
// so the "no second account is ever created" invariant can be asserted — the
// callables must never call it.
const { deleteUser, getUserByEmail, generateEmailVerificationLink, createUser } =
  vi.hoisted(() => ({
    deleteUser: vi.fn(),
    getUserByEmail: vi.fn(),
    generateEmailVerificationLink: vi.fn(),
    createUser: vi.fn(),
  }))

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    deleteUser,
    getUserByEmail,
    generateEmailVerificationLink,
    createUser,
  })),
}))

// Static import — this line is the intended red: while
// functions/staff-lifecycle.js is absent, the whole suite fails to LOAD.
import { resendStaffInvite, removeStaffAccount, linkExistingStaff } from '../staff-lifecycle.js'

// ── Constants ────────────────────────────────────────────────────────────────
const SLUG = 'acme'
const ADMIN_UID = 'admin-1'
const STAFF_UID = 'staff-1'
const STAFF_EMAIL = 'staff@acme.com'
const VERIFY_LINK = 'https://example.com/verify?oobCode=abc123'

// Org where admin-1 is an admin and staff-1 is a plain staff member.
const adminOnlySnapshots = {
  [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com', name: 'Boss' },
  [`organizations/${SLUG}/members/${STAFF_UID}`]: { role: 'staff', email: STAFF_EMAIL, name: 'Staff One' },
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Fake Firestore keyed by FULL document path, so every path the callables
// touch is addressable exactly:
//   organizations/{slug}/members/{uid}   member docs  ({ role, email, name })
//   userProfiles/{uid}                   profile docs ({ displayName, email })
// `deletedPaths` records every doc().delete() and `setCalls` every doc().set(),
// so tests can assert that ALL THREE records went away — or that NONE did.
// collection(path).where(field, op, value).get() filters member docs by field,
// so a "last remaining admin" count works against the same snapshots map.
function makeDb({ snapshots = {} } = {}) {
  const deletedPaths = []
  const setCalls = []

  const doc = vi.fn((path) => ({
    get: vi.fn(async () =>
      snapshots[path]
        ? { exists: true, data: () => snapshots[path] }
        : { exists: false, data: () => ({}) },
    ),
    delete: vi.fn(async () => {
      deletedPaths.push(path)
    }),
    set: vi.fn(async (data) => {
      setCalls.push({ path, data })
    }),
  }))

  const collection = vi.fn((path) => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const docs = Object.keys(snapshots)
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({ id: p.slice(prefix.length), exists: true, data: () => snapshots[p] }))
    const query = (filtered) => ({
      where: vi.fn((field, op, value) =>
        query(filtered.filter((d) => (op === '==' ? d.data()[field] === value : false))),
      ),
      get: vi.fn(async () => ({ docs: filtered })),
    })
    return query(docs)
  })

  return { fakeDb: { doc, collection }, doc, deletedPaths, setCalls }
}

// ════════════════════════════════════════════════════════════════════════════
describe('resendStaffInvite({ slug, memberId })', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteUser.mockReset()
    getUserByEmail.mockReset()
    generateEmailVerificationLink.mockReset()
    createUser.mockReset()
  })

  // 1. Unauthenticated caller — no request.auth at all.
  it('rejects an unauthenticated caller', async () => {
    const { fakeDb } = makeDb({ snapshots: adminOnlySnapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: SLUG, memberId: STAFF_UID } }
    expect(request.auth).toBeUndefined()
    await expect(resendStaffInvite(request)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  // 2. Signed in, but the caller's member doc for THAT org is not an admin.
  it('rejects a signed-in caller who is not an admin of the org', async () => {
    const { fakeDb } = makeDb({ snapshots: adminOnlySnapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      resendStaffInvite({
        auth: { uid: STAFF_UID },
        data: { slug: SLUG, memberId: STAFF_UID },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  // 3. memberId is not a member of that org.
  it('rejects a memberId that is not a member of the org', async () => {
    const { fakeDb } = makeDb({ snapshots: adminOnlySnapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      resendStaffInvite({
        auth: { uid: ADMIN_UID },
        data: { slug: SLUG, memberId: 'ghost-9' },
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(generateEmailVerificationLink).not.toHaveBeenCalled()
  })

  // 4. Success: returns the member's email plus a fresh verification link.
  it('returns the email and a generated verification link', async () => {
    generateEmailVerificationLink.mockResolvedValue(VERIFY_LINK)
    const { fakeDb } = makeDb({ snapshots: adminOnlySnapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await resendStaffInvite({
      auth: { uid: ADMIN_UID },
      data: { slug: SLUG, memberId: STAFF_UID },
    })

    expect(generateEmailVerificationLink).toHaveBeenCalledWith(STAFF_EMAIL)
    expect(result).toEqual({ email: STAFF_EMAIL, link: VERIFY_LINK })
  })
})
// ════════════════════════════════════════════════════════════════════════════
describe('removeStaffAccount({ slug, memberId })', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteUser.mockReset()
    getUserByEmail.mockReset()
    generateEmailVerificationLink.mockReset()
    createUser.mockReset()
  })

  // 5. Non-admin caller is refused before anything is touched.
  it('rejects a non-admin caller and deletes nothing', async () => {
    const snapshots = {
      ...adminOnlySnapshots,
      [`organizations/${SLUG}/members/staff-2`]: { role: 'staff', email: 'two@acme.com', name: 'Staff Two' },
    }
    const { fakeDb, deletedPaths } = makeDb({ snapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      removeStaffAccount({
        auth: { uid: STAFF_UID },
        data: { slug: SLUG, memberId: 'staff-2' },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(deletedPaths).toEqual([])
  })

  // 6. Removing the LAST remaining admin must be refused — and nothing at all
  //    may be deleted (no deleteUser call, no Firestore deletes).
  it('refuses to remove the last remaining admin and deletes nothing', async () => {
    const { fakeDb, deletedPaths } = makeDb({
      snapshots: {
        [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com' },
        [`organizations/${SLUG}/members/${STAFF_UID}`]: { role: 'staff', email: STAFF_EMAIL },
        [`userProfiles/${ADMIN_UID}`]: { displayName: 'Boss', email: 'boss@acme.com' },
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    // The only admin in the org (the caller) tries to remove themself.
    await expect(
      removeStaffAccount({
        auth: { uid: ADMIN_UID },
        data: { slug: SLUG, memberId: ADMIN_UID },
      }),
    ).rejects.toMatchObject({ code: 'failed-precondition' })

    expect(deleteUser).not.toHaveBeenCalled()
    expect(deletedPaths).toEqual([])
  })

  // 7. ★ The discriminating case. The old broken code deleted only the member
  //    doc, so a test asserting just that one deletion PASSES on the bug. Here
  //    ALL THREE records must go: the Auth login, the profile, the member.
  it('deletes ALL THREE records on success — auth user, userProfile, member doc', async () => {
    deleteUser.mockResolvedValue(undefined)
    const snapshots = {
      ...adminOnlySnapshots,
      [`userProfiles/${STAFF_UID}`]: { displayName: 'Staff One', email: STAFF_EMAIL },
    }
    const { fakeDb, deletedPaths, doc } = makeDb({ snapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await removeStaffAccount({
      auth: { uid: ADMIN_UID },
      data: { slug: SLUG, memberId: STAFF_UID },
    })

    expect(result).toMatchObject({ success: true })
    // 7a. Auth login gone — the assertion the broken browser flow could never do.
    expect(deleteUser).toHaveBeenCalledTimes(1)
    expect(deleteUser).toHaveBeenCalledWith(STAFF_UID)
    // 7b. userProfiles/{uid} gone.
    expect(doc).toHaveBeenCalledWith(`userProfiles/${STAFF_UID}`)
    // 7c. organizations/{slug}/members/{uid} gone.
    expect(doc).toHaveBeenCalledWith(`organizations/${SLUG}/members/${STAFF_UID}`)
    expect(deletedPaths).toHaveLength(2)
    expect(deletedPaths).toEqual(
      expect.arrayContaining([`userProfiles/${STAFF_UID}`, `organizations/${SLUG}/members/${STAFF_UID}`]),
    )
  })

  // 8. Half-cleaned state is recoverable: if the Auth account is ALREADY gone
  //    (auth/user-not-found), the callable must still clear both Firestore
  //    records and report success instead of dying mid-way.
  it('still clears both Firestore records when the auth user is already gone', async () => {
    deleteUser.mockRejectedValue(Object.assign(new Error('No user record'), { code: 'auth/user-not-found' }))
    const snapshots = {
      ...adminOnlySnapshots,
      [`userProfiles/${STAFF_UID}`]: { displayName: 'Staff One', email: STAFF_EMAIL },
    }
    const { fakeDb, deletedPaths, doc } = makeDb({ snapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await removeStaffAccount({
      auth: { uid: ADMIN_UID },
      data: { slug: SLUG, memberId: STAFF_UID },
    })

    expect(deleteUser).toHaveBeenCalledWith(STAFF_UID)
    expect(result).toMatchObject({ success: true })
    expect(doc).toHaveBeenCalledWith(`userProfiles/${STAFF_UID}`)
    expect(doc).toHaveBeenCalledWith(`organizations/${SLUG}/members/${STAFF_UID}`)
    expect(deletedPaths).toEqual(
      expect.arrayContaining([`userProfiles/${STAFF_UID}`, `organizations/${SLUG}/members/${STAFF_UID}`]),
    )
  })
})
// ════════════════════════════════════════════════════════════════════════════
describe('linkExistingStaff({ slug, email, name, role })', () => {
  const NEW_EMAIL = 'new-hire@acme.com'
  const EXISTING_UID = 'existing-uid-42'

  beforeEach(() => {
    vi.clearAllMocks()
    deleteUser.mockReset()
    getUserByEmail.mockReset()
    generateEmailVerificationLink.mockReset()
    createUser.mockReset()
  })

  // 9. Non-admin caller is refused before anything is written.
  it('rejects a non-admin caller', async () => {
    const { fakeDb, setCalls } = makeDb({ snapshots: adminOnlySnapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      linkExistingStaff({
        auth: { uid: STAFF_UID },
        data: { slug: SLUG, email: NEW_EMAIL, name: 'New Hire', role: 'manager' },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(createUser).not.toHaveBeenCalled()
    expect(setCalls).toEqual([])
  })

  // 10. No Auth account exists for that email — refuse with a pointer to the
  //     normal invite flow instead of half-creating records under a dead uid.
  it('refuses when no auth account exists for the email and suggests a normal invite', async () => {
    getUserByEmail.mockRejectedValue(Object.assign(new Error('No user record'), { code: 'auth/user-not-found' }))
    const { fakeDb, setCalls } = makeDb({
      snapshots: {
        [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com' },
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      linkExistingStaff({
        auth: { uid: ADMIN_UID },
        data: { slug: SLUG, email: NEW_EMAIL, name: 'New Hire', role: 'manager' },
      }),
    ).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/invite/i) })

    expect(createUser).not.toHaveBeenCalled()
    expect(setCalls).toEqual([])
  })

  // 11. Success: writes the member doc AND the profile doc against the
  //     EXISTING uid returned by getUserByEmail — and never creates a second
  //     account (the "email already in use" trap must not re-occur).
  it('links the existing auth uid — writes member and profile docs, no new account', async () => {
    getUserByEmail.mockResolvedValue({ uid: EXISTING_UID })
    const { fakeDb, setCalls, doc } = makeDb({
      snapshots: {
        [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com' },
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await linkExistingStaff({
      auth: { uid: ADMIN_UID },
      data: { slug: SLUG, email: NEW_EMAIL, name: 'New Hire', role: 'manager' },
    })

    expect(getUserByEmail).toHaveBeenCalledWith(NEW_EMAIL)
    expect(result).toMatchObject({ success: true })
    // Both docs are written against the EXISTING uid...
    expect(doc).toHaveBeenCalledWith(`organizations/${SLUG}/members/${EXISTING_UID}`)
    expect(doc).toHaveBeenCalledWith(`userProfiles/${EXISTING_UID}`)
    const memberSet = setCalls.find((c) => c.path === `organizations/${SLUG}/members/${EXISTING_UID}`)
    const profileSet = setCalls.find((c) => c.path === `userProfiles/${EXISTING_UID}`)
    expect(memberSet?.data).toMatchObject({ role: 'manager', name: 'New Hire', email: NEW_EMAIL })
    expect(profileSet?.data).toMatchObject({ displayName: 'New Hire', email: NEW_EMAIL })
    // ...and no new account is ever created.
    expect(createUser).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })
})
// ════════════════════════════════════════════════════════════════════════════
describe('linkExistingStaff — orphan precondition guard', () => {
  const ORPHAN_EMAIL = 'orphan@acme.com'
  const ORPHAN_UID = 'existing-uid-42'

  beforeEach(() => {
    vi.clearAllMocks()
    deleteUser.mockReset()
    getUserByEmail.mockReset()
    generateEmailVerificationLink.mockReset()
    createUser.mockReset()
  })

  // A. ★ The orphan precondition. linkExistingStaff is documented as adopting
  //    an "orphaned login (one that exists in Auth but has no member/profile
  //    records)" — a destructive implementation never checks that, so calling
  //    it for someone who ALREADY has a member doc silently overwrites that
  //    doc: role becomes the caller-supplied value, mfaEnrolled resets to
  //    false, and joinedAt is destroyed. A test asserting merely "it refused"
  //    would pass for the WRONG reason; the discriminating assertion here is
  //    that the seeded doc is left untouched.
  it('refuses a non-orphaned login and leaves the existing member doc untouched', async () => {
    const memberPath = `organizations/${SLUG}/members/${ORPHAN_UID}`
    const profilePath = `userProfiles/${ORPHAN_UID}`
    getUserByEmail.mockResolvedValue({ uid: ORPHAN_UID })
    const snapshots = {
      [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com', name: 'Boss' },
      [memberPath]: {
        role: 'admin',
        name: 'Original Name',
        email: ORPHAN_EMAIL,
        mfaEnrolled: true,
        joinedAt: new Date('2024-03-01T10:00:00Z'),
      },
    }
    const { fakeDb, setCalls } = makeDb({ snapshots })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    await expect(
      linkExistingStaff({
        auth: { uid: ADMIN_UID },
        data: { slug: SLUG, email: ORPHAN_EMAIL, name: 'Replacement Name', role: 'staff' },
      }),
    ).rejects.toMatchObject({ code: 'failed-precondition' })

    // The seeded member doc is UNCHANGED — role stays 'admin', mfa stays true.
    expect(snapshots[memberPath].role).toBe('admin')
    expect(snapshots[memberPath].mfaEnrolled).toBe(true)
    // No write reached that doc path at all...
    expect(setCalls.some((c) => c.path === memberPath)).toBe(false)
    // ...and no profile was scribbled over either.
    expect(setCalls.some((c) => c.path === profilePath)).toBe(false)
  })

  // B. The legitimate orphan path must still work — a genuine adoption must
  //    not be refused. This guards against over-fixing: a fix that refuses
  //    EVERYTHING passes Test A but has to fail HERE.
  it('still adopts a genuine orphan login (no member doc exists)', async () => {
    const memberPath = `organizations/${SLUG}/members/${ORPHAN_UID}`
    getUserByEmail.mockResolvedValue({ uid: ORPHAN_UID })
    const { fakeDb, setCalls, doc } = makeDb({
      snapshots: {
        [`organizations/${SLUG}/members/${ADMIN_UID}`]: { role: 'admin', email: 'boss@acme.com', name: 'Boss' },
      },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const result = await linkExistingStaff({
      auth: { uid: ADMIN_UID },
      data: { slug: SLUG, email: ORPHAN_EMAIL, name: 'Orphan One', role: 'staff' },
    })

    expect(getUserByEmail).toHaveBeenCalledWith(ORPHAN_EMAIL)
    expect(result).toMatchObject({ success: true })
    // Member doc written at the EXISTING uid...
    expect(doc).toHaveBeenCalledWith(memberPath)
    const memberSet = setCalls.find((c) => c.path === memberPath)
    expect(memberSet?.data).toMatchObject({ role: 'staff', name: 'Orphan One', email: ORPHAN_EMAIL })
    // ...and no second account is ever created.
    expect(createUser).not.toHaveBeenCalled()
  })
})

