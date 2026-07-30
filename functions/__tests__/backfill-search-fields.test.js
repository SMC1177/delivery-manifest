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

import { backfillSearchFields } from '../backfill-search-fields.js'

// ── helpers ────────────────────────────────────────────────────────

/**
 * Build a fake Firestore with full control over every seam.
 *
 * doc routing:
 *   path containing "/members/"  → memberRef (for admin check)
 *   path containing "/shipments/" → cursorDocRef (for startAfter lookup)
 *   exact org doc path           → orgRef (for completion flag write)
 *   anything else                → empty doc stub
 */
function makeFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  cursorDocSnap = { exists: false, data: () => ({}) },
} = {}) {
  // ── member doc ──────────────────────────────────────────────────
  const memberGet = vi.fn().mockResolvedValue(memberSnap)
  const memberRef = { get: memberGet }

  // ── cursor doc (for startAfter) ──────────────────────────────────
  const cursorDocGet = vi.fn().mockResolvedValue(cursorDocSnap)
  const cursorDocRef = { get: cursorDocGet }

  // ── shipment query ──────────────────────────────────────────────
  const shipmentDocs = shipments.map((s) => ({
    id: s.id,
    ref: s.ref || { id: s.id, path: `organizations/test-org/shipments/${s.id}` },
    data: () => s.data,
  }))

  const shipmentSnapshot = {
    docs: shipmentDocs,
    forEach: (cb) => shipmentDocs.forEach(cb),
  }
  const shipmentGet = vi.fn().mockResolvedValue(shipmentSnapshot)

  const queryObj = {
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    startAfter: vi.fn().mockReturnThis(),
    get: shipmentGet,
  }
  const collection = vi.fn().mockReturnValue(queryObj)

  // ── batch ───────────────────────────────────────────────────────
  const batchUpdate = vi.fn()
  const batchCommit = vi.fn().mockResolvedValue([])
  const batch = vi.fn(() => ({
    update: batchUpdate,
    commit: batchCommit,
  }))

  // ── org doc ─────────────────────────────────────────────────────
  const orgUpdate = vi.fn().mockResolvedValue({ writeTime: {} })
  const orgRef = { update: orgUpdate }

  // ── doc routing ─────────────────────────────────────────────────
  function docImpl(path) {
    if (path.includes('/members/')) return memberRef
    if (path.includes('/shipments/')) return cursorDocRef
    if (path === 'organizations/test-org') return orgRef
    return { get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }
  }
  const doc = vi.fn(docImpl)

  const fakeDb = { doc, collection, batch }

  return {
    fakeDb,
    doc,
    collection,
    memberGet,
    cursorDocGet,
    shipmentGet,
    shipmentSnapshot,
    batchUpdate,
    batchCommit,
    queryObj,
    orgUpdate,
  }
}

/** Convenience: admin member snapshot. */
function adminMemberSnap() {
  return { exists: true, data: () => ({ role: 'admin' }) }
}

/** Build a shipment fixture. */
function shipment(id, fields = {}) {
  return {
    id,
    data: fields,
    ref: { id, path: `organizations/test-org/shipments/${id}` },
  }
}

// ── tests ─────────────────────────────────────────────────────────

describe('backfillSearchFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. AUTH GUARD
  // ======================================================================

  it('rejects calls with no auth context (unauthenticated)', async () => {
    // The auth guard is the very first thing checked — before any Firestore
    // call.  An unauthenticated request must not touch the database at all.
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org' } }
    expect(request.auth).toBeUndefined()

    await expect(backfillSearchFields(request)).rejects.toThrow('Login required')

    // Must not touch firestore at all
    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. PERMISSION GUARD — admin only
  // ======================================================================

  it('rejects authenticated user whose member doc is missing', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillSearchFields(request)).rejects.toThrow('Admin access required')

    // Must have checked membership
    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user1'),
    )
    // Must NOT proceed to shipments — no collection call, no batch commit
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated member whose role is not admin', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user2', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillSearchFields(request)).rejects.toThrow('Admin access required')

    // Must have checked membership
    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user2'),
    )
    // Must NOT proceed to shipments
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects admin role check when member doc exists but has no role field', async () => {
    // TRAP: `memberSnap.data().role` is undefined.  `undefined !== 'admin'` is
    // true, so the guard should reject.  If the implementation used a falsy
    // check like `!memberSnap.data().role` it would incorrectly reject a
    // member with role=0 (though unrealistic) — but the real concern is that
    // a missing role field must be treated as non-admin.
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: true, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user3', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillSearchFields(request)).rejects.toThrow('Admin access required')
    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user3'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 3. SLUG VALIDATION
  // ======================================================================

  it('rejects missing slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {},
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug is required')
  })

  it('rejects null slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: null },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug is required')
  })

  it('rejects non-string slug (number)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 42 },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug is required')
  })

  it('rejects empty string slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '' },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug is required')
  })

  it('rejects whitespace-only slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '   ' },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug is required')
  })

  it('rejects slug containing forward slash (path traversal guard)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'evil/../other-org' },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Invalid slug')
  })

  it('rejects over-long slug (>128 chars)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'a'.repeat(129) },
    }
    await expect(backfillSearchFields(request)).rejects.toThrow('Slug too long')
  })

  // ======================================================================
  // 4. IDEMPOTENCE BY PRESENCE — the subtle one
  // ======================================================================

  it('does not rewrite a document whose patientNameLower is an empty string', async () => {
    // TRAP: `!doc.data().patientNameLower` (truthiness) would rewrite a
    // blank-named patient on every single run, forever.  The implementation
    // MUST use `=== undefined` (presence), not truthiness.
    const blankDoc = shipment('s1', {
      patientName: '',
      patientNameLower: '', // already present, just empty
    })
    const missingDoc = shipment('s2', {
      patientName: 'Bob',
      // patientNameLower is absent
    })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [blankDoc, missingDoc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillSearchFields(request)

    // Only the missing-field doc gets updated
    expect(result.updated).toBe(1)
    expect(result.processed).toBe(2)

    const updatedRefs = batchUpdate.mock.calls.map((c) => c[0])
    expect(updatedRefs).not.toContain(blankDoc.ref)
    expect(updatedRefs).toContain(missingDoc.ref)
  })

  it('does not rewrite a document that already has patientNameLower set', async () => {
    // After a prior backfill run, every doc already has patientNameLower.
    // Re-running must write zero documents.
    const docs = [
      shipment('d1', { patientName: 'Alice', patientNameLower: 'alice' }),
      shipment('d2', { patientName: 'Bob', patientNameLower: 'bob' }),
      shipment('d3', { patientName: 'Carol', patientNameLower: 'carol' }),
    ]

    const { fakeDb, batchUpdate, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillSearchFields(request)

    expect(result.updated).toBe(0)
    expect(result.processed).toBe(3)
    expect(result.done).toBe(true)

    // No batch updates and no commit
    expect(batchUpdate).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 5. THE HALF-BACKFILLED-ORG TRAP
  // ======================================================================

  it('does NOT write org completion flag when chunk is full (non-final)', async () => {
    // This is the most important test.  If the completion flag is set
    // mid-run (first chunk out of many), Batch B live queries would see
    // a half-backfilled collection and records would silently vanish from
    // the UI.  `done` must be false and the org doc MUST NOT be touched.
    const allDocs = Array.from({ length: 3 }, (_, i) =>
      shipment(`hdoc${i + 1}`, { patientName: `Patient ${i + 1}` }),
    )

    const { fakeDb, orgUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: allDocs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 3 },
    }

    const result = await backfillSearchFields(request)

    // processed (3) === chunkSize (3), so done must be false
    expect(result.processed).toBe(3)
    expect(result.done).toBe(false)
    expect(result.cursor).toBeTruthy()

    // Org doc MUST NOT be written — this is the half-backfilled org disaster
    expect(orgUpdate).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 6. COMPLETION ON SHORT (FINAL) CHUNK
  // ======================================================================

  it('writes org completion flag when chunk is short (done:true)', async () => {
    const docs = [
      shipment('s1', { patientName: 'First' }),
      shipment('s2', { patientName: 'Second' }),
    ]

    const { fakeDb, orgUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 3 },
    }

    const result = await backfillSearchFields(request)

    // 2 < 3 → done
    expect(result.done).toBe(true)

    expect(orgUpdate).toHaveBeenCalledTimes(1)
    expect(orgUpdate).toHaveBeenCalledWith({
      searchBackfillComplete: true,
      searchBackfillCompletedAt: FieldValue.serverTimestamp(),
    })
  })

  it('marks completion even for an empty collection (zero shipments)', async () => {
    // An org with no shipments is trivially complete — 0 < chunkSize,
    // so done is true.  The client may safely apply the filter.
    const { fakeDb, orgUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillSearchFields(request)

    expect(result.done).toBe(true)
    expect(result.processed).toBe(0)
    expect(result.cursor).toBeNull()

    expect(orgUpdate).toHaveBeenCalledTimes(1)
    expect(orgUpdate).toHaveBeenCalledWith({
      searchBackfillComplete: true,
      searchBackfillCompletedAt: FieldValue.serverTimestamp(),
    })
  })

  // ======================================================================
  // 7. CURSOR — resume semantics
  // ======================================================================

  it('returns the last doc id as cursor for resumed calls', async () => {
    const docs = [
      shipment('alpha', { patientName: 'A' }),
      shipment('beta', { patientName: 'B' }),
      shipment('gamma', { patientName: 'C' }),
    ]

    const { fakeDb } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 3 },
    }

    const result = await backfillSearchFields(request)
    expect(result.cursor).toBe('gamma')
  })

  it('returns null cursor for an empty collection', async () => {
    const { fakeDb } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillSearchFields(request)
    expect(result.cursor).toBeNull()
  })

  it('passes startAfter with cursor doc snapshot on resume', async () => {
    // Simulate the second call: the cursor doc exists and startAfter is used.
    const docs = [shipment('gamma', { patientName: 'C' })]

    const cursorSnap = {
      exists: true,
      id: 'beta',
      ref: { id: 'beta', path: 'organizations/test-org/shipments/beta' },
      data: () => ({ patientName: 'B' }),
    }

    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
      cursorDocSnap: cursorSnap,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', cursor: 'beta' },
    }

    const result = await backfillSearchFields(request)

    expect(result.cursor).toBe('gamma')
    // startAfter must have been called with the cursor doc snapshot
    expect(queryObj.startAfter).toHaveBeenCalledWith(cursorSnap)
  })

  // ======================================================================
  // 8. LIMIT — cap and default
  // ======================================================================

  it('caps limit at 500 when caller passes a larger value', async () => {
    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 600 },
    }

    await backfillSearchFields(request)

    // Firestore batch has a hard 500-write limit — an uncapped limit is a
    // live crash.  The implementation MUST clamp.
    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('defaults limit to 500 when no limit is provided', async () => {
    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await backfillSearchFields(request)

    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('defaults limit to 500 when limit is provided but invalid (null, negative, string)', async () => {
    // Number.isFinite(null) → false, Number.isFinite('50') → false,
    // Number.isFinite(-1) → true but -1 > 0 → false.
    // All should fall through to DEFAULT_CHUNK.
    for (const badLimit of [null, '50', -1, NaN, Infinity]) {
      const { fakeDb, queryObj } = makeFakeDb({
        memberSnap: adminMemberSnap(),
        shipments: [],
      })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      const request = {
        auth: { uid: 'admin1', token: {} },
        data: { slug: 'test-org', limit: badLimit },
      }

      await backfillSearchFields(request)
      expect(queryObj.limit).toHaveBeenCalledWith(500)
    }
  })

  // ======================================================================
  // 9. DERIVED VALUE — patientName → patientNameLower
  // ======================================================================

  it('derives patientNameLower by trimming and lowercasing patientName', async () => {
    const doc = shipment('s1', { patientName: '  Alice SMITH  ' })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [doc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await backfillSearchFields(request)

    expect(batchUpdate).toHaveBeenCalledWith(doc.ref, {
      patientNameLower: 'alice smith',
    })
  })

  it('handles missing patientName as empty string', async () => {
    const doc = shipment('s1', { someOtherField: 42 })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [doc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await backfillSearchFields(request)

    expect(batchUpdate).toHaveBeenCalledWith(doc.ref, {
      patientNameLower: '',
    })
  })

  it('handles non-string patientName as empty string', async () => {
    // If someone somehow stored a number or boolean in patientName,
    // it must not throw — fall back to empty string.
    const doc = shipment('s1', { patientName: 42 })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [doc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await backfillSearchFields(request)

    expect(batchUpdate).toHaveBeenCalledWith(doc.ref, {
      patientNameLower: '',
    })
  })

  it('handles null patientName as empty string', async () => {
    const doc = shipment('s1', { patientName: null })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [doc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await backfillSearchFields(request)

    expect(batchUpdate).toHaveBeenCalledWith(doc.ref, {
      patientNameLower: '',
    })
  })
})
