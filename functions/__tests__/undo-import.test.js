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

const SERVER_TIMESTAMP = { _methodName: 'serverTimestamp' }

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: {
    serverTimestamp: vi.fn(() => SERVER_TIMESTAMP),
  },
}))

import { undoImport } from '../undo-import.js'

// ── helpers ────────────────────────────────────────────────────────

/**
 * Build a fake Firestore for undo-import tests.
 *
 * @param {Object} opts
 * @param {Object} opts.memberSnap   — snapshot returned for member doc get
 * @param {Array}  opts.shipments    — [{id, data:{importId?,...}, ref?}] all shipment docs
 * @param {string} opts.orgSlug
 * @param {string} opts.importId     — the importId the callable is targeting
 */
function makeFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  orgSlug = 'test-org',
  importId = 'imp-001',
} = {}) {
  // ── shipment docs (by id) ───────────────────────────────────────
  /** @type {Map<string, Object>} */
  const shipmentDocMap = new Map()
  for (const s of shipments) {
    const ref = s.ref || {
      id: s.id,
      path: `organizations/${orgSlug}/shipments/${s.id}`,
    }
    shipmentDocMap.set(s.id, {
      exists: true,
      id: s.id,
      ref,
      data: () => s.data,
    })
  }

  // ── track where clauses for query filtering ────────────────────
  let whereField = null
  let whereValue = null
  let appliedLimit = Infinity

  function matchingDocs() {
    const all = [...shipmentDocMap.values()]
    if (whereField === 'importId') {
      return all.filter((d) => d.data().importId === whereValue)
    }
    return all
  }

  // ── count aggregate ─────────────────────────────────────────────
  const countGet = vi.fn(() => {
    return Promise.resolve({
      data: () => ({ count: matchingDocs().length }),
    })
  })
  const countObj = { get: countGet }

  // ── shipment query ──────────────────────────────────────────────
  const queryGet = vi.fn(() => {
    const docs = matchingDocs().slice(0, appliedLimit)
    return Promise.resolve({
      docs,
      forEach: (cb) => docs.forEach(cb),
    })
  })

  const queryObj = {
    where: vi.fn((field, _op, value) => {
      whereField = field
      whereValue = value
      return queryObj
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn((n) => {
      appliedLimit = n
      return queryObj
    }),
    startAfter: vi.fn().mockReturnThis(),
    count: vi.fn(() => countObj),
    get: queryGet,
  }

  // ── batch ───────────────────────────────────────────────────────
  const batchDelete = vi.fn()
  const batchCommit = vi.fn().mockResolvedValue([])
  const batch = vi.fn(() => ({
    delete: batchDelete,
    commit: batchCommit,
  }))

  // ── audit collection ────────────────────────────────────────────
  const auditAdd = vi.fn().mockResolvedValue({ id: 'audit-1' })

  // ── companion doc delete ────────────────────────────────────────
  const companionDelete = vi.fn().mockResolvedValue(undefined)

  // ── doc routing ─────────────────────────────────────────────────
  const memberGet = vi.fn().mockResolvedValue(memberSnap)
  const memberRef = { get: memberGet }

  function docImpl(path) {
    if (path.includes('/members/')) return memberRef

    const shipmentMatch = path.match(/\/shipments\/([^/]+)$/)
    if (shipmentMatch) {
      const sid = shipmentMatch[1]
      const existing = shipmentDocMap.get(sid)
      if (existing) {
        return { get: vi.fn().mockResolvedValue(existing) }
      }
      return {
        get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      }
    }

    if (path.includes('/imports/')) {
      return {
        delete: companionDelete,
        get: vi.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
      }
    }

    return {
      get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
    }
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
    fakeDb,
    doc,
    collection,
    memberGet,
    queryGet,
    queryObj,
    countGet,
    batchDelete,
    batchCommit,
    batch,
    auditAdd,
    companionDelete,
    shipmentDocMap,
  }
}

/** A convenience: admin member snapshot. */
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

describe('undoImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. ADMIN GUARD
  // ======================================================================

  it('rejects unauthenticated calls — no delete without login', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org', importId: 'imp-001' } }
    expect(request.auth).toBeUndefined()

    await expect(undoImport(request)).rejects.toThrow('Login required')

    // Must not reach Firestore at all
    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated user who is not a member of the org — no delete', async () => {
    const { fakeDb, doc, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    await expect(undoImport(request)).rejects.toThrow('Admin access required')

    // Reached member doc check but NOT the shipments collection
    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user1'),
    )
    expect(fakeDb.collection).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('rejects authenticated member whose role is not admin — no delete', async () => {
    const { fakeDb, doc, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user2', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    await expect(undoImport(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(
      expect.stringContaining('/members/user2'),
    )
    expect(fakeDb.collection).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. THE CRITICAL TEST — importId scope
  // ======================================================================

  it('only deletes docs whose importId matches exactly — different importId and missing importId are NEVER touched', async () => {
    // Three docs: one target, one divergent, one pre-feature (no importId at all).
    // This is the whole safety property — blast radius must be exactly one importId.
    const sTarget = shipment('s-target', {
      patientName: 'Alice',
      importId: 'imp-001',
    })
    const sDifferent = shipment('s-diff', {
      patientName: 'Bob',
      importId: 'imp-999',
    })
    const sNoField = shipment('s-nofield', {
      patientName: 'Pre-feature record',
    })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [sTarget, sDifferent, sNoField],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    // Only the target doc was in the query snapshot
    expect(result.processed).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.done).toBe(true)

    // Exactly one batch.delete call — for the target
    expect(batchDelete).toHaveBeenCalledTimes(1)
    expect(batchDelete).toHaveBeenCalledWith(sTarget.ref)

    // The other two refs were never passed to batch.delete
    const deletedRefs = batchDelete.mock.calls.map((c) => c[0])
    expect(deletedRefs).not.toContain(sDifferent.ref)
    expect(deletedRefs).not.toContain(sNoField.ref)

    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('deletes nothing when no shipment carries the target importId', async () => {
    const s1 = shipment('s1', { importId: 'imp-999' })
    const s2 = shipment('s2', { importId: 'imp-888' })

    const { fakeDb, batchDelete, batchCommit, batch } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    // Zero matching docs → no batch needed
    expect(result.processed).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.done).toBe(true)

    // Batch was never created because docs array was empty
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 3. COMPANION RECORD ORDERING
  // ======================================================================

  it('does NOT delete the imports/{importId} companion record on a non-final chunk', async () => {
    // 5 matching docs, limit=2 → returns 2 docs, done=false (2 < 2 is false)
    const docs = Array.from({ length: 5 }, (_, i) =>
      shipment(`s${i}`, { importId: 'imp-001' }),
    )

    const { fakeDb, companionDelete, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', limit: 2 },
    }

    const result = await undoImport(request)

    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(false)
    expect(result.cursor).toBe('s1')

    // Shipments were deleted
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)

    // Companion record was NOT deleted — that must wait for the final chunk
    expect(companionDelete).not.toHaveBeenCalled()
  })

  it('deletes the imports/{importId} companion record on the final chunk — only after all shipments are gone', async () => {
    // 1 matching doc, default limit=500 → returns 1 doc, done=true (1 < 500)
    const s1 = shipment('s1', { importId: 'imp-001' })

    const { fakeDb, companionDelete, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    expect(result.processed).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.done).toBe(true)

    // Shipment deleted
    expect(batchDelete).toHaveBeenCalledTimes(1)
    expect(batchCommit).toHaveBeenCalledTimes(1)

    // Companion record deleted on final chunk
    expect(companionDelete).toHaveBeenCalledTimes(1)
  })

  it('deletes companion record on final chunk even when zero matching shipments exist (done=true with empty page)', async () => {
    const { fakeDb, companionDelete, batch, batchDelete, batchCommit } =
      makeFakeDb({
        memberSnap: adminMemberSnap(),
        shipments: [],
        importId: 'imp-001',
      })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    expect(result.processed).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.done).toBe(true)

    // No batch needed — zero docs
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()

    // Companion record still deleted — the import record is cleaned up
    expect(companionDelete).toHaveBeenCalledTimes(1)
  })

  // ======================================================================
  // 4. confirmCount MISMATCH DELETES NOTHING
  // ======================================================================

  it('confirmCount mismatch on first chunk deletes zero shipments and surfaces the mismatch', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })
    const s2 = shipment('s2', { importId: 'imp-001' })

    const { fakeDb, batchDelete, batchCommit, batch } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        confirmCount: 99, // server has 2
      },
    }

    await expect(undoImport(request)).rejects.toThrow(
      /Count mismatch: expected 99 to delete, found 2/,
    )

    // Zero deletes — batch was never created
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('confirmCount match on first chunk allows deletion to proceed', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })
    const s2 = shipment('s2', { importId: 'imp-001' })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        confirmCount: 2, // matches
      },
    }

    const result = await undoImport(request)

    expect(result.deleted).toBe(2)
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('confirmCount check is skipped on cursor-resume chunks — only first chunk validates', async () => {
    // When cursor is present, confirmCount is intentionally bypassed.
    const s1 = shipment('s1', { importId: 'imp-001' })
    const s2 = shipment('s2', { importId: 'imp-001' })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        cursor: 's0', // resume chunk
        confirmCount: 999, // would fail on first chunk, but cursor bypasses it
      },
    }

    const result = await undoImport(request)

    // Deletion proceeds despite bogus confirmCount
    expect(result.deleted).toBe(2)
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  // ======================================================================
  // 5. dryRun DELETES NOTHING
  // ======================================================================

  it('dryRun=true never creates a batch — structurally impossible to delete', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })
    const s2 = shipment('s2', { importId: 'imp-001' })

    const { fakeDb, batch, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        dryRun: true,
      },
    }

    const result = await undoImport(request)

    // Batch never created — no mutation path exists
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()

    // Counts still returned
    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)
  })

  it('dryRun=true does not write audit entries', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        dryRun: true,
      },
    }

    await undoImport(request)

    expect(auditAdd).not.toHaveBeenCalled()
  })

  it('dryRun=true does not delete the companion record', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })

    const { fakeDb, companionDelete } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        importId: 'imp-001',
        dryRun: true,
      },
    }

    await undoImport(request)

    // dryRun returns early before companion deletion
    expect(companionDelete).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 6. CAPS — limit clamping
  // ======================================================================

  it('clamps caller-supplied limit above 500 down to 500 — Firestore writeBatch throws above 500', async () => {
    const docs = Array.from({ length: 3 }, (_, i) =>
      shipment(`s${i}`, { importId: 'imp-001' }),
    )

    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', limit: 600 },
    }

    await undoImport(request)

    // query uses the clamped value, not the raw 600
    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('default chunk size is 500 when no limit is supplied', async () => {
    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    await undoImport(request)

    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  // ======================================================================
  // 7. INPUT VALIDATION
  // ======================================================================

  // -- importId ----------------------------------------------------------

  it('rejects missing importId — never falls through to a broad query', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    await expect(undoImport(request)).rejects.toThrow('importId is required')

    // Must not reach admin check — validation is before Firestore access
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  it('rejects null importId', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: null },
    }

    await expect(undoImport(request)).rejects.toThrow('importId is required')
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  it('rejects non-string importId (number)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 12345 },
    }

    await expect(undoImport(request)).rejects.toThrow('importId is required')
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  it('rejects empty string importId', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: '' },
    }

    await expect(undoImport(request)).rejects.toThrow('importId is required')
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only importId', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: '   ' },
    }

    await expect(undoImport(request)).rejects.toThrow('importId is required')
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  it('rejects over-long importId (>256 chars) before any path is built', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'a'.repeat(257) },
    }

    await expect(undoImport(request)).rejects.toThrow('importId too long')
    expect(fakeDb.doc).not.toHaveBeenCalled()
  })

  // -- slug --------------------------------------------------------------

  it('rejects non-string slug (number) — no path constructed', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 123, importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Slug is required')
  })

  it('rejects null slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: null, importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Slug is required')
  })

  it('rejects empty string slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '', importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Slug is required')
  })

  it('rejects whitespace-only slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '   ', importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Slug is required')
  })

  it('rejects over-long slug (>128 chars) before any path is built', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'a'.repeat(129), importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Slug too long')
  })

  it('rejects slug containing forward slash — path traversal guard', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'evil/../other-org', importId: 'imp-001' },
    }
    await expect(undoImport(request)).rejects.toThrow('Invalid slug')
  })

  // -- confirmCount ------------------------------------------------------

  it('rejects confirmCount that is not an integer (float)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', confirmCount: 3.5 },
    }

    await expect(undoImport(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  it('rejects negative confirmCount', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', confirmCount: -1 },
    }

    await expect(undoImport(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  it('rejects non-numeric confirmCount (string)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', confirmCount: 'abc' },
    }

    await expect(undoImport(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  // ======================================================================
  // 8. AUDIT CARRIES NO PATIENT DATA
  // ======================================================================

  it('audit entry contains only counts and identifiers — no patient data fields', async () => {
    const s1 = shipment('s1', {
      importId: 'imp-001',
      patientName: 'John Doe',
      address: '123 Main St',
      phone: '555-1234',
      dob: '1980-01-01',
      rxNumbers: ['RX001', 'RX002'],
    })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: { email: 'admin@test.com' } },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    await undoImport(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const entry = auditAdd.mock.calls[0][0]

    // Must have metadata fields
    expect(entry.actor).toBe('admin1')
    expect(entry.actorEmail).toBe('admin@test.com')
    expect(entry.action).toBe('undo_import')
    expect(entry.orgSlug).toBe('test-org')
    expect(entry.importId).toBe('imp-001')
    expect(entry.deleted).toBe(1)
    expect(entry.at).toBe(SERVER_TIMESTAMP)

    // Must NOT contain any patient data
    expect(entry.patientName).toBeUndefined()
    expect(entry.address).toBeUndefined()
    expect(entry.phone).toBeUndefined()
    expect(entry.dob).toBeUndefined()
    expect(entry.rxNumbers).toBeUndefined()
  })

  it('no audit entry written when zero shipments are deleted', async () => {
    const s1 = shipment('s1', { importId: 'imp-999' }) // different importId

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    expect(result.deleted).toBe(0)
    expect(auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // HAPPY PATH — basic functionality
  // ======================================================================

  it('successfully deletes shipments by importId and returns correct shape', async () => {
    const s1 = shipment('id1', { name: 'Shipment 1', importId: 'imp-001' })
    const s2 = shipment('id2', { name: 'Shipment 2', importId: 'imp-001' })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001' },
    }

    const result = await undoImport(request)

    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)
    expect(result.cursor).toBe('id2')

    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchDelete).toHaveBeenCalledWith(s1.ref)
    expect(batchDelete).toHaveBeenCalledWith(s2.ref)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('returns done=false when more matching docs remain beyond chunk limit', async () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      shipment(`s${i}`, { importId: 'imp-001' }),
    )

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: 'imp-001', limit: 3 },
    }

    const result = await undoImport(request)

    expect(result.processed).toBe(3)
    expect(result.deleted).toBe(3)
    expect(result.done).toBe(false) // more to delete
    expect(result.cursor).toBe('s2')
    expect(batchDelete).toHaveBeenCalledTimes(3)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('trims whitespace from importId before querying', async () => {
    const s1 = shipment('s1', { importId: 'imp-001' })

    const { fakeDb, batchDelete } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
      importId: 'imp-001',
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', importId: '  imp-001  ' },
    }

    const result = await undoImport(request)

    // Trimmed importId matches the doc
    expect(result.deleted).toBe(1)
    expect(batchDelete).toHaveBeenCalledWith(s1.ref)
  })
})
