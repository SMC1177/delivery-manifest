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
  FieldValue: {
    serverTimestamp: vi.fn(() => ({ _methodName: 'serverTimestamp' })),
  },
}))

import { deleteArchivedShipments } from '../delete-archived.js'

// ==========================================================================
// HELPERS
// ==========================================================================

/**
 * Build a fake Firestore for delete-archived filter-mode tests.
 *
 * The query returns ALL docs placed in `shipments` — even non-archived ones.
 * This lets us test the load-bearing `deletableDocs.filter(doc =>
 * doc.data().archived === true)` guard independently from the query-level
 * `where('archived', '==', true)`.  Both guards exist in the real code;
 * this mock proves the second guard independently.
 *
 * @param {Object} opts
 * @param {Object} opts.memberSnap    — snapshot returned for member doc get
 * @param {Array}  opts.shipments     — docs the query returns AND available
 *                                       for individual doc gets (ids mode)
 * @param {string} opts.orgSlug
 * @param {number|null} opts.forceCount — override the server-side count used
 *                                         by confirmCount (null = auto-compute
 *                                         from shipments' archived===true docs)
 * @param {Array}  opts.extraShipmentGets — extra {id, snap} for docs NOT in
 *                                           `shipments` but fetchable via
 *                                           doc().get()
 * @param {Object} opts.cursorDocSnap — optional override for cursor doc lookup
 */
function makeDeleteFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  orgSlug = 'test-org',
  forceCount = null,
  extraShipmentGets = [],
  cursorDocSnap = null,
} = {}) {
  /** @type {Map<string, Object>} */
  const shipmentDocMap = new Map()
  for (const s of shipments) {
    const ref = s.ref || { id: s.id, path: `organizations/${orgSlug}/shipments/${s.id}` }
    shipmentDocMap.set(s.id, { exists: true, id: s.id, ref, data: () => s.data })
  }
  for (const { id, snap } of extraShipmentGets) {
    shipmentDocMap.set(id, snap)
  }

  // Query returns docs from shipments ONLY (NOT extraShipmentGets)
  const queryDocs = [...shipmentDocMap.values()].filter(
    (d) => !extraShipmentGets.some((e) => e.id === d.id),
  )
  const archivedDocCount = queryDocs.filter((d) => d.data().archived === true).length

  // ── member doc ──────────────────────────────────────────────────
  const memberGet = vi.fn().mockResolvedValue(memberSnap)
  const memberRef = { get: memberGet }

  // ── query (returns ALL docs — even non-archived ones) ───────────
  let appliedLimit = Infinity
  const queryGet = vi.fn(() => {
    const docs = queryDocs.slice(0, appliedLimit)
    return Promise.resolve({ docs, forEach: (cb) => docs.forEach(cb) })
  })

  const countGet = vi.fn().mockResolvedValue({
    data: () => ({ count: forceCount !== null ? forceCount : archivedDocCount }),
  })
  const countObj = { get: countGet }

  const queryObj = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn((n) => { appliedLimit = n; return queryObj }),
    startAfter: vi.fn().mockReturnThis(),
    count: vi.fn(() => countObj),
    get: queryGet,
  }

  // ── batch ───────────────────────────────────────────────────────
  const batchDelete = vi.fn()
  const batchCommit = vi.fn().mockResolvedValue([])
  const batch = vi.fn(() => ({ delete: batchDelete, commit: batchCommit }))

  // ── audit ───────────────────────────────────────────────────────
  const auditAdd = vi.fn().mockResolvedValue({ id: 'audit-1' })

  // ── doc routing ─────────────────────────────────────────────────
  function docImpl(path) {
    if (path.includes('/members/')) return memberRef

    const shipmentMatch = path.match(/\/shipments\/([^/]+)$/)
    if (shipmentMatch) {
      const sid = shipmentMatch[1]
      // Cursor doc lookup takes priority
      if (cursorDocSnap && sid === cursorDocSnap.id) {
        return { get: vi.fn().mockResolvedValue(cursorDocSnap) }
      }
      const existing = shipmentDocMap.get(sid)
      if (existing) return { get: vi.fn().mockResolvedValue(existing) }
      return { get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }
    }
    return { get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }
  }
  const doc = vi.fn(docImpl)

  // ── collection routing ──────────────────────────────────────────
  function collectionImpl(path) {
    if (path === 'platformAudit') return { add: auditAdd }
    if (path.includes('/shipments')) return queryObj
    return { get: vi.fn().mockResolvedValue({ docs: [] }) }
  }
  const collection = vi.fn(collectionImpl)

  const fakeDb = { doc, collection, batch }

  return {
    fakeDb, doc, collection, memberGet, queryGet, queryObj, countGet,
    batchDelete, batchCommit, batch, auditAdd, shipmentDocMap,
  }
}

/** Admin member snapshot. */
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

// ==========================================================================
// TESTS — deleteArchivedShipments filter mode
// ==========================================================================

describe('deleteArchivedShipments filter mode', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // ------------------------------------------------------------------
  // 1. NON-ADMIN REJECTED
  // ------------------------------------------------------------------

  it('rejects unauthenticated call — no delete without login', async () => {
    const { fakeDb } = makeDeleteFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      data: { slug: 'test-org', filter: { status: 'delivered' } },
    }
    expect(request.auth).toBeUndefined()

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Login required')

    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects non-member — no delete, batch never committed', async () => {
    const { fakeDb, doc, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' } },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user1'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('rejects non-admin member — no delete, batch never created', async () => {
    const { fakeDb, doc, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user2', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' } },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user2'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // 2. AND SEMANTICS — filter criteria combine as AND
  // ------------------------------------------------------------------

  it('deletes only docs matching ALL filter criteria — partial match survives', async () => {
    // Doc A: archived=true, status='delivered', date in range → should delete
    const matchAll = shipment('s-match', { archived: true, status: 'delivered', date: '2024-06-15', name: 'Match All' })
    // Doc B: archived=true, status='delivered' but OUTSIDE date range → must survive
    const matchPartial = shipment('s-partial', { archived: true, status: 'delivered', date: '2023-01-01', name: 'Partial' })

    const { fakeDb, queryObj, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [matchAll],
      extraShipmentGets: [
        { id: matchPartial.id, snap: { exists: true, id: matchPartial.id, ref: matchPartial.ref, data: () => matchPartial.data } },
      ],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered', dateFrom: '2024-01-01', dateTo: '2024-12-31' },
      },
    }

    const result = await deleteArchivedShipments(request)

    // Verify query uses AND via where clauses
    expect(queryObj.where).toHaveBeenCalledWith('archived', '==', true)
    expect(queryObj.where).toHaveBeenCalledWith('status', '==', 'delivered')
    expect(queryObj.where).toHaveBeenCalledWith('date', '>=', '2024-01-01')
    expect(queryObj.where).toHaveBeenCalledWith('date', '<=', '2024-12-31')

    // Only the matching doc is deleted; partial match survives
    expect(result.deleted).toBe(1)
    expect(batchDelete).toHaveBeenCalledTimes(1)
    expect(batchDelete).toHaveBeenCalledWith(matchAll.ref)
    expect(batchDelete).not.toHaveBeenCalledWith(matchPartial.ref)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('combines status, date range, AND search criteria — partial matches survive', async () => {
    const matchAll = shipment('s-match', {
      archived: true, status: 'delivered', date: '2024-06-15',
      patientNameLower: 'johnson', name: 'Johnson',
    })
    const noSearchMatch = shipment('s-nosearch', {
      archived: true, status: 'delivered', date: '2024-07-01',
      patientNameLower: 'smith', name: 'Smith',
    })

    const { fakeDb, queryObj, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [matchAll],
      extraShipmentGets: [
        { id: noSearchMatch.id, snap: { exists: true, id: noSearchMatch.id, ref: noSearchMatch.ref, data: () => noSearchMatch.data } },
      ],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered', dateFrom: '2024-01-01', dateTo: '2024-12-31', search: 'john' },
      },
    }

    const result = await deleteArchivedShipments(request)

    // Only matchAll is deleted; partial match survives
    expect(result.deleted).toBe(1)
    expect(batchDelete).toHaveBeenCalledWith(matchAll.ref)
    expect(batchDelete).not.toHaveBeenCalledWith(noSearchMatch.ref)

    // search uses prefix range query
    expect(queryObj.where).toHaveBeenCalledWith('patientNameLower', '>=', 'john')
    expect(queryObj.where).toHaveBeenCalledWith('patientNameLower', '<=', 'john\uf8ff')
  })

  // ------------------------------------------------------------------
  // 3. THE IRREVERSIBLE ONE — non-archived doc NEVER deleted
  // ------------------------------------------------------------------

  it('NEVER deletes a doc whose archived is not exactly true, even matching all criteria', async () => {
    // Archived doc matching all criteria → should be deleted
    const archivedMatch = shipment('s-arch', {
      archived: true, status: 'delivered', date: '2024-06-15', name: 'Archived',
    })
    // NON-archived doc matching ALL criteria → must SURVIVE
    const liveMatch = shipment('s-live', {
      archived: false, status: 'delivered', date: '2024-06-15', name: 'Live!',
    })
    // Document with archived completely missing → must SURVIVE
    const missingArchived = shipment('s-missing', {
      status: 'delivered', date: '2024-06-15', name: 'Missing field',
    })
    // Document with archived='true' (string, not boolean) → must SURVIVE
    const strTrue = shipment('s-strtrue', {
      archived: 'true', status: 'delivered', date: '2024-06-15', name: 'String true',
    })
    // Document with archived=1 (number) → must SURVIVE
    const numOne = shipment('s-numone', {
      archived: 1, status: 'delivered', date: '2024-06-15', name: 'Number 1',
    })

    const { fakeDb, batchDelete, batchCommit, batch } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [archivedMatch, liveMatch, missingArchived, strTrue, numOne],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered', dateFrom: '2024-01-01', dateTo: '2024-12-31' },
      },
    }

    const result = await deleteArchivedShipments(request)

    // All 5 docs are in the query result; processed = 5
    expect(result.processed).toBe(5)
    // Only the one with archived===true is deleted
    expect(result.deleted).toBe(1)
    expect(result.done).toBe(true)

    // Exactly one batch.delete call — for the archived:true doc
    expect(batchDelete).toHaveBeenCalledTimes(1)
    expect(batchDelete).toHaveBeenCalledWith(archivedMatch.ref)

    // None of the dangerous shapes were passed to batch.delete
    const deletedRefs = batchDelete.mock.calls.map((c) => c[0])
    expect(deletedRefs).not.toContain(liveMatch.ref)
    expect(deletedRefs).not.toContain(missingArchived.ref)
    expect(deletedRefs).not.toContain(strTrue.ref)
    expect(deletedRefs).not.toContain(numOne.ref)

    // Batch was committed
    expect(batchCommit).toHaveBeenCalledTimes(1)
    expect(batch).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // 4. confirmCount MISMATCH DELETES NOTHING
  // ------------------------------------------------------------------

  it('confirmCount mismatch in filter mode deletes zero docs — batch never created', async () => {
    const s1 = shipment('s1', { archived: true, status: 'delivered', date: '2024-06-15' })
    const s2 = shipment('s2', { archived: true, status: 'delivered', date: '2024-07-01' })

    const { fakeDb, batch, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      forceCount: 2, // server has 2 matching archived docs
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered' },
        confirmCount: 99, // wildly wrong
      },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'Count mismatch: expected 99 to delete, found 2 archived',
    )

    // Zero deletes — no batch was ever created
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('confirmCount mismatch in filter mode — the server counts, not the caller', async () => {
    // The caller passes a count it did NOT compute (can't enumerate 22k docs).
    // The server must count what IT would delete.  This test proves the server
    // counts independently and refuses a stale number.
    const s1 = shipment('s1', { archived: true, status: 'delivered', date: '2024-06-15' })
    const s2 = shipment('s2', { archived: true, status: 'delivered', date: '2024-07-01' })
    const s3 = shipment('s3', { archived: true, status: 'delivered', date: '2024-08-01' })

    const { fakeDb, batch, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2, s3],
      forceCount: 3,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered', dateFrom: '2024-01-01', dateTo: '2024-12-31' },
        confirmCount: 1, // stale — a new shipment arrived since the UI counted
      },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'Count mismatch: expected 1 to delete, found 3 archived',
    )

    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
  })

  it('confirmCount match allows deletion to proceed in filter mode', async () => {
    const s1 = shipment('s1', { archived: true, status: 'delivered', date: '2024-06-15' })
    const s2 = shipment('s2', { archived: true, status: 'delivered', date: '2024-07-01' })

    const { fakeDb, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      forceCount: 2,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: 'delivered' },
        confirmCount: 2,
      },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.deleted).toBe(2)
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // 5. CATASTROPHIC DEFAULT — empty filter must be REJECTED
  // ------------------------------------------------------------------

  it('rejects empty filter object {} — must not be "match everything"', async () => {
    const s1 = shipment('s1', { archived: true, name: 'Archived' })

    const { fakeDb, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: {} },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'at least one criterion (status, dateFrom, dateTo, search) is required',
    )

    // Nothing was written
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('rejects filter where every field is empty/undefined — all blanks', async () => {
    const s1 = shipment('s1', { archived: true, name: 'Archived' })

    const { fakeDb, batchDelete, batchCommit } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        filter: { status: '', dateFrom: null, dateTo: undefined, search: '  ' },
      },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'at least one criterion (status, dateFrom, dateTo, search) is required',
    )

    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('rejects filter that is null (not an object)', async () => {
    const { fakeDb } = makeDeleteFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: null },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('filter must be an object')
  })

  it('rejects filter that is an array (not a plain object)', async () => {
    const { fakeDb } = makeDeleteFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: ['status', 'delivered'] },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('filter must be an object')
  })

  // ------------------------------------------------------------------
  // 6. dryRun — returns count, writes nothing
  // ------------------------------------------------------------------

  it('dryRun in filter mode returns counts and never creates a batch', async () => {
    const s1 = shipment('s1', { archived: true, status: 'delivered', date: '2024-06-15' })
    const s2 = shipment('s2', { archived: true, status: 'delivered', date: '2024-07-01' })

    const { fakeDb, batch, batchDelete, batchCommit, auditAdd } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' }, dryRun: true },
    }

    const result = await deleteArchivedShipments(request)

    // Batch was never created — structurally impossible to delete
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
    expect(auditAdd).not.toHaveBeenCalled()

    // Counts are still returned
    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)
  })

  it('dryRun in filter mode counts only genuinely archived docs', async () => {
    const arch = shipment('s-arch', { archived: true, status: 'delivered', date: '2024-06-15' })
    const live = shipment('s-live', { archived: false, status: 'delivered', date: '2024-06-15' })

    const { fakeDb, batch, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [arch, live],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' }, dryRun: true },
    }

    const result = await deleteArchivedShipments(request)

    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()

    expect(result.processed).toBe(2) // both in query
    expect(result.deleted).toBe(1) // only the archived one counted
  })

  // ------------------------------------------------------------------
  // 7. CURSOR RESUME
  // ------------------------------------------------------------------

  it('cursor resumes the filter walk rather than restarting from beginning', async () => {
    const s1 = shipment('s1', { archived: true, status: 'delivered', date: '2024-06-01' })
    const s2 = shipment('s2', { archived: true, status: 'delivered', date: '2024-07-01' })
    const s3 = shipment('s3', { archived: true, status: 'delivered', date: '2024-08-01' })

    // First chunk returns s1+s2 (not done)
    const firstChunkSnapshot = {
      docs: [
        { exists: true, id: 's1', ref: s1.ref, data: () => s1.data },
        { exists: true, id: 's2', ref: s2.ref, data: () => s2.data },
      ],
      forEach: (cb) => { cb({ exists: true, id: 's1', ref: s1.ref, data: () => s1.data }); cb({ exists: true, id: 's2', ref: s2.ref, data: () => s2.data }) },
    }

    const { fakeDb, queryGet } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2, s3],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    queryGet.mockResolvedValue(firstChunkSnapshot)

    // First call with limit=2 gets s1+s2
    const request1 = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' }, limit: 2 },
    }

    const result1 = await deleteArchivedShipments(request1)

    expect(result1.deleted).toBe(2)
    expect(result1.done).toBe(false)
    expect(result1.cursor).toBe('s2')

    // Clean up for second call
    vi.clearAllMocks()

    // Second call with cursor='s2' — should resume after s2
    const secondChunkSnapshot = {
      docs: [
        { exists: true, id: 's3', ref: s3.ref, data: () => s3.data },
      ],
      forEach: (cb) => { cb({ exists: true, id: 's3', ref: s3.ref, data: () => s3.data }) },
    }

    const { fakeDb: fakeDb2, queryGet: queryGet2, queryObj: queryObj2, batchDelete: batchDelete2 } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s3],
      cursorDocSnap: { id: 's2', exists: true, ref: s2.ref, data: () => s2.data },
    })
    const { getFirestore: getFirestore2 } = await import('firebase-admin/firestore')
    getFirestore2.mockReturnValue(fakeDb2)
    queryGet2.mockResolvedValue(secondChunkSnapshot)

    const request2 = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', filter: { status: 'delivered' }, cursor: 's2' },
    }

    const result2 = await deleteArchivedShipments(request2)

    // Must have called startAfter with the cursor doc
    expect(queryObj2.startAfter).toHaveBeenCalledTimes(1)

    // The resumed call should process only s3
    expect(result2.processed).toBe(1)
    expect(result2.deleted).toBe(1)
    expect(result2.cursor).toBe('s3')

    const deletedRefs = batchDelete2.mock.calls.map((c) => c[0])
    expect(deletedRefs).toContain(s3.ref)
    expect(deletedRefs).not.toContain(s1.ref)
    expect(deletedRefs).not.toContain(s2.ref)
  })
})

// ==========================================================================
// REGRESSION GUARD — pre-existing ids mode still works
// ==========================================================================

describe('regression: deleteArchivedShipments existing modes', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('ids mode still deletes only archived shipments by id', async () => {
    const s1 = shipment('id1', { name: 'Shipment 1', archived: true })

    const { fakeDb, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['id1'] },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.deleted).toBe(1)
    expect(batchDelete).toHaveBeenCalledWith(s1.ref)
  })

  it('ids mode does NOT delete non-archived docs even when listed explicitly', async () => {
    const arch = shipment('s-arch', { name: 'Archived', archived: true })
    const live = shipment('s-live', { name: 'Live' })

    const { fakeDb, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [arch, live],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s-arch', 's-live'] },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.deleted).toBe(1)
    const deletedRefs = batchDelete.mock.calls.map((c) => c[0])
    expect(deletedRefs).toContain(arch.ref)
    expect(deletedRefs).not.toContain(live.ref)
  })

  it('all-archived mode (no ids, no filter) still deletes all archived docs', async () => {
    const s1 = shipment('s1', { name: 'Old', archived: true })
    const s2 = shipment('s2', { name: 'Old too', archived: true })
    const live = shipment('s3', { name: 'Live', archived: false })

    const { fakeDb, batchDelete } = makeDeleteFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2, live],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await deleteArchivedShipments(request)

    // Only archived docs deleted — the live one survives
    expect(result.deleted).toBe(2)
    const deletedRefs = batchDelete.mock.calls.map((c) => c[0])
    expect(deletedRefs).toContain(s1.ref)
    expect(deletedRefs).toContain(s2.ref)
    expect(deletedRefs).not.toContain(live.ref)
  })
})
