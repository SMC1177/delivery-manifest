// functions/__tests__/upload-org-logo.test.js
//
// Adversarial BREAKER tests for the uploadOrgLogo callable
// (functions/upload-org-logo.js).
//
// WHY THE CALLABLE EXISTS: the browser-side logo upload died at three
// successive gates and still returned 403 — the deployed Storage rules only
// honour the org-admin path, locking out a platform admin who is not enrolled
// in the org. This file attacks the server-side replacement the way a
// reviewer would: every rejection must leave Storage untouched, and both the
// org-admin AND the platform-admin paths must be able to write.
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
  FieldValue: { serverTimestamp: vi.fn(() => ({ _methodName: 'serverTimestamp' })) },
}))

vi.mock('firebase-admin/storage', () => ({
  getStorage: vi.fn(),
}))

import { uploadOrgLogo } from '../upload-org-logo.js'

// A 1x1 transparent PNG, base64-encoded. Decodes to 68 non-empty bytes —
// well under the 2 MB cap, so it clears every format gate.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function adminMember() {
  return { exists: true, data: () => ({ role: 'admin' }) }
}

function platformAdminProfile() {
  return { exists: true, data: () => ({ platformAdmin: true }) }
}

/**
 * Build fake Firestore + fake Storage with every seam exposed.
 *
 * Firestore doc routing:
 *   path starting with "userProfiles/" → profileRef (platform-admin check)
 *   path containing "/members/"        → memberRef (org-admin check)
 *   anything else                      → empty stub doc
 */
function makeFakeBackend({
  memberSnap = { exists: false, data: () => ({}) },
  profileSnap = { exists: false, data: () => ({}) },
} = {}) {
  const memberRef = { get: vi.fn().mockResolvedValue(memberSnap) }
  const profileRef = { get: vi.fn().mockResolvedValue(profileSnap) }

  const auditAdd = vi.fn().mockResolvedValue({ id: 'audit-1' })
  const collection = vi.fn(() => ({ add: auditAdd }))

  const doc = vi.fn((path) => {
    if (path.startsWith('userProfiles/')) return profileRef
    if (path.includes('/members/')) return memberRef
    return { get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }
  })
  const fakeDb = { doc, collection }

  const fileSave = vi.fn().mockResolvedValue(undefined)
  const file = vi.fn(() => ({ save: fileSave }))
  const bucket = { name: 'fake-bucket', file }

  return { fakeDb, doc, collection, memberRef, profileRef, auditAdd, file, fileSave, bucket }
}

/** Point the mocked firestore + storage modules at the fake backend. */
async function wire(backend) {
  const { getFirestore } = await import('firebase-admin/firestore')
  getFirestore.mockReturnValue(backend.fakeDb)
  const { getStorage } = await import('firebase-admin/storage')
  getStorage.mockReturnValue({ bucket: vi.fn(() => backend.bucket) })
  return backend
}

function authorizedRequest(overrides = {}) {
  return {
    auth: { uid: 'admin-1', token: {} },
    data: { slug: 'test-org', contentType: 'image/png', dataBase64: TINY_PNG_BASE64, ...overrides },
  }
}

describe('uploadOrgLogo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. AUTH GUARD
  // ======================================================================

  it('rejects unauthenticated calls before touching storage or firestore', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const request = {
      data: { slug: 'test-org', contentType: 'image/png', dataBase64: TINY_PNG_BASE64 },
    }
    expect(request.auth).toBeUndefined()

    await expect(uploadOrgLogo(request)).rejects.toThrow('Login required')

    // NOTHING may be written — the save mock must never even be reached,
    // let alone called.
    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.doc).not.toHaveBeenCalled()
    expect(b.fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. PERMISSION GUARD — neither org admin nor platform admin
  // ======================================================================

  it('rejects a signed-in user with no member doc and no platform-admin flag', async () => {
    const b = await wire(
      makeFakeBackend({
        memberSnap: { exists: false, data: () => ({}) },
        profileSnap: { exists: false, data: () => ({}) },
      }),
    )

    await expect(uploadOrgLogo(authorizedRequest())).rejects.toThrow('Admin access required')

    // Both authorization lookups must have happened (org membership first,
    // then the platform-admin profile fallback)…
    expect(b.memberRef.get).toHaveBeenCalledTimes(1)
    expect(b.profileRef.get).toHaveBeenCalledTimes(1)
    // …and neither may have led to a write.
    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.auditAdd).not.toHaveBeenCalled()
  })

  it('rejects a member whose role is not admin', async () => {
    const b = await wire(
      makeFakeBackend({
        memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
        profileSnap: { exists: false, data: () => ({}) },
      }),
    )

    await expect(uploadOrgLogo(authorizedRequest({ auth: { uid: 'admin-1', token: {} } }))).rejects.toThrow(
      'Admin access required',
    )

    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 3. ORG ADMIN SUCCEEDS
  // ======================================================================

  it('allows an org admin (members/{uid} role=admin) and saves the object', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const result = await uploadOrgLogo(authorizedRequest())

    // The object is saved at the derived path, once, with the right bytes.
    expect(b.file).toHaveBeenCalledTimes(1)
    expect(b.file).toHaveBeenCalledWith('organizations/test-org/logo.png')

    const [savedBuffer, options] = b.fileSave.mock.calls[0]
    expect(Buffer.isBuffer(savedBuffer)).toBe(true)
    expect(savedBuffer.length).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length)
    expect(options.contentType).toBe('image/png')

    // Download token metadata so getDownloadURL-style access keeps working.
    const token = options.metadata.metadata.firebaseStorageDownloadTokens
    expect(token).toEqual(expect.any(String))

    // The returned URL is the public getDownloadURL-style URL for this object.
    expect(result.url).toBe(
      `https://firebasestorage.googleapis.com/v0/b/fake-bucket/o/${encodeURIComponent(
        'organizations/test-org/logo.png',
      )}?alt=media&token=${token}`,
    )

    // Audit entry through the org audit log.
    expect(b.fakeDb.collection).toHaveBeenCalledWith('organizations/test-org/auditLog')
    expect(b.auditAdd).toHaveBeenCalledTimes(1)
    expect(b.auditAdd).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'org.logo_updated', targetId: 'logo.png', userId: 'admin-1' }),
    )

    // An org admin must NOT need the platform-admin profile lookup.
    expect(b.profileRef.get).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 4. PLATFORM ADMIN SUCCEEDS — THE KEY ONE
  // ======================================================================

  it('ALLOWS a platform admin with NO member doc in the org (the gap the callable exists to close)', async () => {
    // The deployed Storage rules honour only the org-admin path, so a
    // platform admin supporting an org they are not enrolled in gets 403'd
    // by the rules. This callable must NOT reproduce that limitation.
    const b = await wire(
      makeFakeBackend({
        memberSnap: { exists: false, data: () => ({}) },
        profileSnap: platformAdminProfile(),
      }),
    )

    const result = await uploadOrgLogo(authorizedRequest())

    expect(b.memberRef.get).toHaveBeenCalledTimes(1)
    expect(b.profileRef.get).toHaveBeenCalledTimes(1)
    expect(b.file).toHaveBeenCalledTimes(1)
    expect(b.file).toHaveBeenCalledWith('organizations/test-org/logo.png')
    expect(b.fileSave).toHaveBeenCalledTimes(1)
    expect(b.auditAdd).toHaveBeenCalledTimes(1)
    expect(b.auditAdd).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1' }))
    expect(result.url).toContain('organizations%2Ftest-org%2Flogo.png')
  })

  // ======================================================================
  // 5. THE SIZE TRAP — decoded bytes, not base64 string length
  // ======================================================================

  it('rejects a payload whose DECODED bytes exceed 2MB and writes nothing', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    // base64 inflates by roughly a third: 2MB + 1 decoded bytes becomes a
    // ~2.67MB string. A size check that measures the ENCODED string (or a
    // decoded-size limit misapplied to the string) would let a ~2.6MB file
    // through. The implementation MUST decode first and measure the buffer.
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 1)
    const dataBase64 = oversized.toString('base64')

    // Sanity: this payload is a VALID base64 string that clears every format
    // gate — the rejection must come from the decoded-byte count, not the
    // character set or padding.
    expect(dataBase64.length % 4).toBe(0)
    expect(Buffer.from(dataBase64, 'base64').length).toBe(2 * 1024 * 1024 + 1)

    const request = authorizedRequest({ dataBase64 })

    await expect(uploadOrgLogo(request)).rejects.toThrow('Image is too large')

    // Nothing may be written — and the size gate fires before any Firestore
    // authorization read even happens.
    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.auditAdd).not.toHaveBeenCalled()
    expect(b.doc).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 6. CONTENT-TYPE ALLOW-LIST
  // ======================================================================

  it.each(['application/pdf', 'text/html'])('rejects non-image contentType %s', async (contentType) => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const request = authorizedRequest({ contentType })

    await expect(uploadOrgLogo(request)).rejects.toThrow('Unsupported image type')

    // Rejected before any write, and before any Firestore authorization read.
    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.auditAdd).not.toHaveBeenCalled()
    expect(b.doc).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 7. SLUG PATH-TRAVERSAL GUARD
  // ======================================================================

  it('rejects a slug containing a forward slash (cannot escape the organizations/ prefix)', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const request = authorizedRequest({ slug: 'evil/../other-org' })

    await expect(uploadOrgLogo(request)).rejects.toThrow('Invalid organization slug')

    expect(b.doc).not.toHaveBeenCalled()
    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
    expect(b.auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 8. OBJECT PATH — derived from validated contentType, never the client
  // ======================================================================

  it('derives the object path from the contentType — a client-supplied filename cannot influence it', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    // The caller stuffs a hostile filename AND an objectPath override into
    // the payload — both must be ignored completely.
    const request = authorizedRequest({
      contentType: 'image/jpeg',
      fileName: 'backdoor.exe',
      objectPath: 'organizations/evil/logo.x',
    })

    const result = await uploadOrgLogo(request)

    expect(b.file).toHaveBeenCalledTimes(1)
    expect(b.file).toHaveBeenCalledWith('organizations/test-org/logo.jpg')
    expect(result.url).toContain('organizations%2Ftest-org%2Flogo.jpg')
  })

  // ======================================================================
  // 9. PAYLOAD FORMAT GATES
  // ======================================================================

  it.each(['', '   ', undefined])('rejects missing/blank dataBase64 (%j)', async (dataBase64) => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const request = dataBase64 === undefined ? authorizedRequest({ dataBase64: undefined }) : authorizedRequest({ dataBase64 })

    await expect(uploadOrgLogo(request)).rejects.toThrow('Invalid image data')

    expect(b.file).not.toHaveBeenCalled()
    expect(b.fileSave).not.toHaveBeenCalled()
  })

  it('accepts a data-URL payload (data:image/png;base64,…) and stores the stripped bytes', async () => {
    const b = await wire(makeFakeBackend({ memberSnap: adminMember() }))

    const request = authorizedRequest({ dataBase64: `data:image/png;base64,${TINY_PNG_BASE64}` })

    const result = await uploadOrgLogo(request)

    expect(b.file).toHaveBeenCalledTimes(1)
    expect(b.file).toHaveBeenCalledWith('organizations/test-org/logo.png')
    const [savedBuffer] = b.fileSave.mock.calls[0]
    expect(savedBuffer.length).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length)
    expect(result.url).toContain('organizations%2Ftest-org%2Flogo.png')
  })
})
