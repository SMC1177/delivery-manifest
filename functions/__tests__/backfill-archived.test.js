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

import { backfillArchivedFlag } from '../backfill-archived.js'

// ── helpers ────────────────────────────────────────────────────────

/** Build a fake Firestore with full control over every seam. */
function makeFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  cursorDocSnap = { exists: false, data: () => ({}) },
} = {}) {
  // ── member doc ──────────────────────────────────────────────────
  const memberGet = vi.fn().mockResolvedValue(memberSnap)
  const memberRef = { get: memberGet }

  // ── cursor doc ──────────────────────────────────────────────────
  const cursorDocGet = vi.fn().mockResolvedValue(cursorDocSnap)
  const cursorDocRef = { get: cursorDocGet }

  // ── shipment query ──────────────────────────────────────────────
  const shipmentDocs = shipments.map((s) => ({
    id: s.id,
    ref: s.ref || { path: `organizations/test-org/shipments/${s.id}` },
    data: () => s.data,
  }))

  const shipmentSnapshot = {
    docs: shipmentDocs,
    forEach: (cb) => shipmentDocs.forEach(cb),
  }
  const shipmentGet = vi.fn().mockResolvedValue(shipmentSnapshot)

  // The query builder — every chainable method returns `this` so the
  // implementation can call orderBy / limit / startAfter / get in any
  // order.  We track startAfter calls separately for cursor tests.
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

  // ── doc routing ─────────────────────────────────────────────────
  function docImpl(path) {
    if (path.includes('/members/')) return memberRef
    if (path.includes('/shipments/')) return cursorDocRef
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
  }
}

/** A convenience: admin member snapshot. */
function adminMemberSnap() {
  return { exists: true, data: () => ({ role: 'admin' }) }
}

/** Build a shipment fixture. */
function shipment(id, fields = {}) {
  return { id, data: fields, ref: { id, path: `organizations/test-org/shipments/${id}` } }
}

// ── tests ─────────────────────────────────────────────────────────

describe('backfillArchivedFlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. ADMIN GUARD
  // ======================================================================

  it('rejects calls with no auth context (unauthenticated)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org' } }
    // request.auth is deliberately absent
    expect(request.auth).toBeUndefined()

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Login required')

    // Must not touch firestore at all
    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated user who is not a member of the org', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Admin access required')

    // It must have checked membership — if it skipped the role check,
    // this test would pass even though the guard is missing.
    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user1')
    )
    // Must not proceed to shipments
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

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Admin access required')

    // Must have checked membership
    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user2')
    )
    // Must not proceed to shipments
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. NEVER CLOBBER AN ARCHIVE — THE MOST IMPORTANT TEST
  // ======================================================================

  it('never adds documents with archived:true to the write batch', async () => {
    // If this regresses, an admin-scheduled archive would be silently
    // undone across the entire collection on the next backfill run.
    const archivedDoc = shipment('doc-archived', { archived: true, name: 'Already Archived' })
    const missingDoc = shipment('doc-missing', { name: 'No archived field' })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [archivedDoc, missingDoc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillArchivedFlag(request)

    // The missing-field doc should be stamped
    expect(result.updated).toBe(1)
    expect(result.processed).toBe(2)

    // batchUpdate must NOT have been called with the archived doc's ref
    const updatedRefs = batchUpdate.mock.calls.map((c) => c[0])
    expect(updatedRefs).not.toContain(archivedDoc.ref)
    // batchUpdate MUST have been called with the missing doc's ref
    expect(updatedRefs).toContain(missingDoc.ref)
  })

  // ======================================================================
  // 3. IDEMPOTENCE (field presence, not truthiness)
  // ======================================================================

  it('never rewrites documents that already have archived:false (field is present but falsy)', async () => {
    // TRAP: an implementation that decides by truthiness (!doc.data().archived)
    // would rewrite archived:false on every run. This test uses archived:false
    // explicitly PRESENT, which MUST be distinguished from undefined.
    const falseDoc = shipment('doc-false', { archived: false, name: 'Explicitly false' })
    const missingDoc = shipment('doc-missing', { name: 'No archived field' })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [falseDoc, missingDoc],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillArchivedFlag(request)

    // Only the missing-field doc gets stamped
    expect(result.updated).toBe(1)
    expect(result.processed).toBe(2)

    const updatedRefs = batchUpdate.mock.calls.map((c) => c[0])
    expect(updatedRefs).not.toContain(falseDoc.ref)
    expect(updatedRefs).toContain(missingDoc.ref)
  })

  it('re-running a completed backfill writes zero documents', async () => {
    // After a full backfill, every doc already has archived:false.
    const docs = [
      shipment('doc1', { archived: false }),
      shipment('doc2', { archived: false }),
      shipment('doc3', { archived: false }),
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

    const result = await backfillArchivedFlag(request)

    expect(result.updated).toBe(0)
    expect(result.processed).toBe(3)
    expect(result.done).toBe(true)

    // No batch updates issued; commit must not have been called either
    expect(batchUpdate).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 4. CHUNKING AND RESUMPTION
  // ======================================================================

  it('processes at most chunkSize documents and returns done:false with a cursor', async () => {
    const allDocs = Array.from({ length: 5 }, (_, i) =>
      shipment(`doc${i + 1}`, { name: `Shipment ${i + 1}` })
    )

    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: allDocs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 3 },
    }

    const result = await backfillArchivedFlag(request)

    // Even though 5 docs are in the snapshot, chunkSize=3 was requested
    // and .limit(3) was called.  The test returns all 5 docs because we
    // control the snapshot — the real Firestore would limit to 3, but
    // we are testing the return shape logic.  When processed (5) is NOT
    // less than chunkSize (3), done is false.
    expect(result.done).toBe(false)
    expect(result.cursor).toBe('doc5')
    expect(typeof result.cursor).toBe('string')

    // Verify limit was capped to 3
    expect(queryObj.limit).toHaveBeenCalledWith(3)
  })

  it('caps chunk size at 500 even when caller passes a larger limit', async () => {
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

    await backfillArchivedFlag(request)

    // Firestore's writeBatch throws above 500 — an uncapped limit is a
    // live crash.  The implementation MUST cap at 500.
    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('defaults chunk size to 500 when no limit is provided', async () => {
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

    await backfillArchivedFlag(request)

    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('continues from cursor and eventually terminates with done:true, every doc stamped exactly once', async () => {
    // Simulate a full backfill across 3 calls with chunkSize=2 on 5 docs.
    // Each doc is missing the archived field, so all should be stamped.
    const allDocs = Array.from({ length: 5 }, (_, i) =>
      shipment(`s${i + 1}`, { name: `Shipment ${i + 1}` })
    )

    const { getFirestore } = await import('firebase-admin/firestore')

    const trackedRefs = [] // collect all refs passed to batch.update across calls

    // ── Call 1: chunkSize=2, no cursor → first page ───────────────
    const cursorSnap2 = {
      exists: true,
      id: 's2',
      ref: allDocs[1].ref,
      data: () => allDocs[1].data,
    }

    const c1 = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [allDocs[0], allDocs[1]], // docs 1-2
      cursorDocSnap: cursorSnap2,
    })
    getFirestore.mockReturnValue(c1.fakeDb)

    const r1 = await backfillArchivedFlag({
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 2 },
    })

    expect(r1.processed).toBe(2)
    expect(r1.updated).toBe(2)
    expect(r1.done).toBe(false)
    expect(r1.cursor).toBe('s2')
    // startAfter must NOT have been called (no cursor in request)
    expect(c1.queryObj.startAfter).not.toHaveBeenCalled()
    trackedRefs.push(...c1.batchUpdate.mock.calls.map((c) => c[0]))

    // ── Call 2: chunkSize=2, cursor='s2' → second page ────────────
    const cursorSnap4 = {
      exists: true,
      id: 's4',
      ref: allDocs[3].ref,
      data: () => allDocs[3].data,
    }

    const c2 = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [allDocs[2], allDocs[3]], // docs 3-4
      cursorDocSnap: cursorSnap2, // the cursor being LOOKED UP is 's2'
    })
    getFirestore.mockReturnValue(c2.fakeDb)

    const r2 = await backfillArchivedFlag({
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 2, cursor: 's2' },
    })

    expect(r2.processed).toBe(2)
    expect(r2.updated).toBe(2)
    expect(r2.done).toBe(false)
    expect(r2.cursor).toBe('s4')
    // startAfter MUST have been called with the cursor doc snap
    expect(c2.queryObj.startAfter).toHaveBeenCalledWith(cursorSnap2)
    trackedRefs.push(...c2.batchUpdate.mock.calls.map((c) => c[0]))

    // ── Call 3: chunkSize=2, cursor='s4' → final page ─────────────
    const c3 = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [allDocs[4]], // doc 5 only
      cursorDocSnap: cursorSnap4, // the cursor being LOOKED UP is 's4'
    })
    getFirestore.mockReturnValue(c3.fakeDb)

    const r3 = await backfillArchivedFlag({
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 2, cursor: 's4' },
    })

    expect(r3.processed).toBe(1)
    expect(r3.updated).toBe(1)
    expect(r3.done).toBe(true)
    expect(r3.cursor).toBe('s5')
    expect(c3.queryObj.startAfter).toHaveBeenCalledWith(cursorSnap4)
    trackedRefs.push(...c3.batchUpdate.mock.calls.map((c) => c[0]))

    // Every doc stamped exactly once
    expect(trackedRefs.length).toBe(5)
    const trackedIds = trackedRefs.map((ref) => ref.id).sort()
    expect(trackedIds).toEqual(['s1', 's2', 's3', 's4', 's5'])
  })

  // ======================================================================
  // 5. INPUT VALIDATION
  // ======================================================================

  it('rejects non-string slug (number)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 123 },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Slug is required')
  })

  it('rejects null slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: null },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Slug is required')
  })

  it('rejects empty string slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Slug is required')
  })

  it('rejects whitespace-only slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '   ' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Slug is required')
  })

  it('rejects over-long slug (>128 chars)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'a'.repeat(129) },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Slug too long')
  })

  it('rejects slug containing forward slash (path traversal guard)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'evil/../other-org' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Invalid slug')
  })

  // ======================================================================
  // 6. EDGE / ERROR CASES
  // ======================================================================

  it('stamps archived:false on documents missing the field', async () => {
    const docs = [
      shipment('doc1', { name: 'First' }),
      shipment('doc2', { name: 'Second' }),
    ]

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await backfillArchivedFlag(request)

    expect(result.updated).toBe(2)
    expect(result.processed).toBe(2)
    expect(result.done).toBe(true)

    // Both docs should be stamped with archived:false
    expect(batchUpdate).toHaveBeenCalledWith(docs[0].ref, { archived: false })
    expect(batchUpdate).toHaveBeenCalledWith(docs[1].ref, { archived: false })
    expect(batchUpdate).toHaveBeenCalledTimes(2)
  })

  it('handles an empty collection with no errors', async () => {
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

    const result = await backfillArchivedFlag(request)

    expect(result).toEqual({
      processed: 0,
      updated: 0,
      done: true,
      cursor: null,
    })
  })

  it('throws internal error when the shipment query fails', async () => {
    const { fakeDb, shipmentGet } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    // Override the query get to throw
    shipmentGet.mockRejectedValue(new Error('Firestore connection failure'))

    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Backfill failed')
  })

  it('throws internal error when batch commit fails', async () => {
    const docs = [shipment('doc1', { name: 'First' })]

    const { fakeDb, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    batchCommit.mockRejectedValue(new Error('Batch write failure'))

    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(backfillArchivedFlag(request)).rejects.toThrow('Backfill failed')
  })
})
