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

const DELETE_SENTINEL = { _methodName: 'delete' }
const SERVER_TIMESTAMP = { _methodName: 'serverTimestamp' }

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: {
    serverTimestamp: vi.fn(() => SERVER_TIMESTAMP),
    delete: vi.fn(() => DELETE_SENTINEL),
  },
}))

import { deleteArchivedShipments } from '../delete-archived.js'

// ── helpers ────────────────────────────────────────────────────────

/**
 * Build a fake Firestore for delete-archived tests.
 *
 * @param {Object} opts
 * @param {Object} opts.memberSnap              — snapshot returned for member doc get
 * @param {Array}  opts.shipments               — [{id, data, ref?}] all shipment docs
 * @param {string} opts.orgSlug
 * @param {number} opts.totalArchivedCount      — override for .count() aggregate result in all-archived mode
 */
function makeFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  orgSlug = 'test-org',
  totalArchivedCount = null,
} = {}) {
  // ── shipment docs (by id) ───────────────────────────────────────
  /** @type {Map<string, Object>} */
  const shipmentDocMap = new Map()
  for (const s of shipments) {
    const ref = s.ref || { id: s.id, path: `organizations/${orgSlug}/shipments/${s.id}` }
    shipmentDocMap.set(s.id, { exists: true, id: s.id, ref, data: () => s.data })
  }

  // ── archived docs for all-archived query ────────────────────────
  const archivedDocs = [...shipmentDocMap.values()].filter(
    (d) => d.data().archived === true,
  )

  // ── count aggregate ─────────────────────────────────────────────
  const computedCount = archivedDocs.length
  const countGet = vi.fn().mockResolvedValue({
    data: () => ({ count: totalArchivedCount !== null ? totalArchivedCount : computedCount }),
  })
  const countObj = { get: countGet }

  // ── shipment query (all-archived mode) ──────────────────────────
  let appliedLimit = Infinity
  const queryGet = vi.fn(() => {
    const docs = archivedDocs.slice(0, appliedLimit)
    return Promise.resolve({
      docs,
      forEach: (cb) => docs.forEach(cb),
    })
  })

  const queryObj = {
    where: vi.fn().mockReturnThis(),
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

describe('deleteArchivedShipments', () => {
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

    const request = { data: { slug: 'test-org' } }
    expect(request.auth).toBeUndefined()

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Login required')

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
      data: { slug: 'test-org', ids: ['s1'] },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Admin access required')

    // Reached member doc check but NOT the shipments collection
    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user1'))
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
      data: { slug: 'test-org', ids: ['s1'] },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user2'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. THE CRITICAL TEST — archived-only guard
  // ======================================================================

  it('only deletes docs where archived is strictly true — never false, missing, or truthy-but-not-true', async () => {
    // Five docs: four dangerous shapes + one genuinely archived sibling.
    // The genuinely archived one must be deleted while all others survive.
    const idArchived = shipment('id-archived', { name: 'Safe to delete', archived: true })
    const idFalse = shipment('id-false', { name: 'Live — explicit false', archived: false })
    const idMissing = shipment('id-missing', { name: 'Live — no archived field' })
    const idStrTrue = shipment('id-strtrue', { name: 'Live — string true', archived: 'true' })
    const idNumOne = shipment('id-numone', { name: 'Live — number 1', archived: 1 })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [idArchived, idFalse, idMissing, idStrTrue, idNumOne],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        ids: ['id-archived', 'id-false', 'id-missing', 'id-strtrue', 'id-numone'],
      },
    }

    const result = await deleteArchivedShipments(request)

    // processed = all 5 exist → 5; deleted = only the true one → 1
    expect(result.processed).toBe(5)
    expect(result.deleted).toBe(1)
    expect(result.done).toBe(true)

    // Exactly one batch.delete call — for the archived:true doc
    expect(batchDelete).toHaveBeenCalledTimes(1)
    expect(batchDelete).toHaveBeenCalledWith(idArchived.ref)

    // None of the dangerous shapes were passed to batch.delete
    const deletedRefs = batchDelete.mock.calls.map((c) => c[0])
    expect(deletedRefs).not.toContain(idFalse.ref)
    expect(deletedRefs).not.toContain(idMissing.ref)
    expect(deletedRefs).not.toContain(idStrTrue.ref)
    expect(deletedRefs).not.toContain(idNumOne.ref)

    // Batch was committed
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  // ======================================================================
  // 3. confirmCount MISMATCH DELETES NOTHING
  // ======================================================================

  it('confirmCount mismatch in ids mode deletes zero docs and surfaces the mismatch', async () => {
    const s1 = shipment('s1', { name: 'Archived A', archived: true })
    const s2 = shipment('s2', { name: 'Archived B', archived: true })
    const s3 = shipment('s3', { name: 'Live — not archived' })

    const { fakeDb, batchDelete, batchCommit, batch } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2, s3],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    // Server has 2 archived docs, but caller claims 3
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        ids: ['s1', 's2', 's3'],
        confirmCount: 3, // mismatch — only 2 are archived
      },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      /Count mismatch: expected 3 to delete, found 2 archived/,
    )

    // Zero deletes — no batch was ever created
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('confirmCount mismatch in all-archived mode deletes zero docs and surfaces the mismatch', async () => {
    const s1 = shipment('s1', { name: 'Archived', archived: true })
    const s2 = shipment('s2', { name: 'Also Archived', archived: true })

    const { fakeDb, batchDelete, batchCommit, batch } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
      totalArchivedCount: 2, // server count
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        confirmCount: 99, // wildly wrong — server has 2
      },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      /Count mismatch: expected 99 to delete, found 2 archived/,
    )

    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  it('confirmCount check is skipped on cursor-resume chunks — only first chunk validates', async () => {
    // When cursor is present, the confirmCount guard is intentionally bypassed.
    // This is the implementation's explicit design choice.
    const s1 = shipment('s1', { name: 'Archived', archived: true })
    const s2 = shipment('s2', { name: 'Archived', archived: true })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        ids: ['s1', 's2'],
        cursor: 's0', // resume chunk — confirmCount check skipped
        confirmCount: 999, // would fail on first chunk, but cursor bypasses it
      },
    }

    const result = await deleteArchivedShipments(request)

    // Deletion proceeds normally despite bogus confirmCount
    expect(result.deleted).toBe(2)
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('confirmCount match on first chunk allows deletion to proceed (ids mode)', async () => {
    const s1 = shipment('s1', { name: 'Archived', archived: true })
    const s2 = shipment('s2', { name: 'Archived', archived: true })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        ids: ['s1', 's2'],
        confirmCount: 2, // correct — both are archived
      },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.deleted).toBe(2)
    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  // ======================================================================
  // 4. dryRun DELETES NOTHING
  // ======================================================================

  it('dryRun=true never creates a batch — structurally impossible to delete', async () => {
    const s1 = shipment('s1', { name: 'Archived A', archived: true })
    const s2 = shipment('s2', { name: 'Archived B', archived: true })

    const { fakeDb, batch, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s1', 's2'], dryRun: true },
    }

    const result = await deleteArchivedShipments(request)

    // Batch was never created — no mutation path exists
    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()

    // Counts are still returned
    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)
  })

  it('dryRun=true counts only genuinely archived docs, not non-archived ones', async () => {
    const archived = shipment('s-arch', { name: 'Archived', archived: true })
    const live = shipment('s-live', { name: 'Live' })

    const { fakeDb, batch, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [archived, live],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s-arch', 's-live'], dryRun: true },
    }

    const result = await deleteArchivedShipments(request)

    expect(batch).not.toHaveBeenCalled()
    expect(batchDelete).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()

    expect(result.processed).toBe(2) // both exist
    expect(result.deleted).toBe(1) // only the archived one counted
  })

  it('dryRun=true does not write audit entries', async () => {
    const s1 = shipment('s1', { name: 'Archived', archived: true })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s1'], dryRun: true },
    }

    await deleteArchivedShipments(request)

    expect(auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 5. CAPS
  // ======================================================================

  it('rejects ids array longer than 500 — never silently truncate', async () => {
    const { fakeDb } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const tooManyIds = Array.from({ length: 501 }, (_, i) => `id-${i}`)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: tooManyIds },
    }

    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'ids array must not exceed 500 entries (got 501)',
    )
  })

  it('clamps caller-supplied limit above 500 down to 500 — Firestore writeBatch throws above 500', async () => {
    const s1 = shipment('s1', { name: 'Archived', archived: true })

    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 600 },
    }

    await deleteArchivedShipments(request)

    // query uses the clamped value, not the raw 600
    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  // ======================================================================
  // 6. INPUT VALIDATION
  // ======================================================================

  it('rejects non-string slug (number) — no path constructed', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 123 },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects null slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: null },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects empty string slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '' },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects whitespace-only slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '   ' },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects over-long slug (>128 chars) before any path is built', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'a'.repeat(129) },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Slug too long')
  })

  it('rejects slug containing forward slash — path traversal guard', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'evil/../other-org' },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('Invalid slug')
  })

  it('rejects ids that is not an array (string)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: 'not-an-array' },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('ids array must not be empty')
  })

  it('rejects ids that is null', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: null },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('ids array must not be empty')
  })

  it('rejects empty ids array', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: [] },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow('ids array must not be empty')
  })

  it('rejects confirmCount that is not an integer (float)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', confirmCount: 3.5 },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  it('rejects negative confirmCount', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', confirmCount: -1 },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  it('rejects non-numeric confirmCount (string)', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', confirmCount: 'abc' },
    }
    await expect(deleteArchivedShipments(request)).rejects.toThrow(
      'confirmCount must be a non-negative integer',
    )
  })

  // ======================================================================
  // 7. AUDIT CARRIES NO PATIENT DATA
  // ======================================================================

  it('audit entry in ids mode contains only counts and identifiers — no patient data', async () => {
    const s1 = shipment('s1', {
      archived: true,
      patientName: 'John Doe',
      address: '123 Main St',
      phone: '555-1234',
      dob: '1980-01-01',
      rxNumbers: ['RX001', 'RX002'],
    })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: { email: 'admin@test.com' } },
      data: { slug: 'test-org', ids: ['s1'] },
    }

    await deleteArchivedShipments(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const entry = auditAdd.mock.calls[0][0]

    // Must have metadata fields
    expect(entry.actor).toBe('admin1')
    expect(entry.actorEmail).toBe('admin@test.com')
    expect(entry.action).toBe('delete_archived_shipments')
    expect(entry.orgSlug).toBe('test-org')
    expect(entry.deleted).toBe(1)
    expect(entry.at).toBe(SERVER_TIMESTAMP)
    expect(entry.mode).toBe('ids')
    expect(entry.idsCount).toBe(1)

    // Must NOT contain any patient data
    expect(entry.patientName).toBeUndefined()
    expect(entry.address).toBeUndefined()
    expect(entry.phone).toBeUndefined()
    expect(entry.dob).toBeUndefined()
    expect(entry.rxNumbers).toBeUndefined()
  })

  it('audit entry in all-archived mode contains only counts and identifiers — no patient data', async () => {
    const s1 = shipment('s1', {
      archived: true,
      patientName: 'Jane Smith',
      address: '456 Oak Ave',
      phone: '555-5678',
      dob: '1975-06-15',
      rxNumbers: ['RX003'],
    })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: { email: 'admin@test.com' } },
      data: { slug: 'test-org' },
    }

    await deleteArchivedShipments(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const entry = auditAdd.mock.calls[0][0]

    expect(entry.actor).toBe('admin1')
    expect(entry.actorEmail).toBe('admin@test.com')
    expect(entry.action).toBe('delete_archived_shipments')
    expect(entry.orgSlug).toBe('test-org')
    expect(entry.deleted).toBe(1)
    expect(entry.at).toBe(SERVER_TIMESTAMP)
    expect(entry.mode).toBe('all')

    // Must NOT contain any patient data
    expect(entry.patientName).toBeUndefined()
    expect(entry.address).toBeUndefined()
    expect(entry.phone).toBeUndefined()
    expect(entry.dob).toBeUndefined()
    expect(entry.rxNumbers).toBeUndefined()
  })

  it('no audit entry written when zero docs are deleted (real mode, not dryRun)', async () => {
    // All docs are non-archived, so deleted === 0 → no audit
    const live = shipment('s-live', { name: 'Live' })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [live],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s-live'] },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.deleted).toBe(0)
    expect(auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // HAPPY PATH — basic functionality
  // ======================================================================

  it('successfully deletes archived shipments by id list and returns correct shape', async () => {
    const s1 = shipment('id1', { name: 'Shipment 1', archived: true })
    const s2 = shipment('id2', { name: 'Shipment 2', archived: true })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['id1', 'id2'] },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)
    expect(result.cursor).toBe('id2')

    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchDelete).toHaveBeenCalledWith(s1.ref)
    expect(batchDelete).toHaveBeenCalledWith(s2.ref)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('successfully deletes all archived shipments in all-archived mode', async () => {
    const s1 = shipment('s1', { name: 'Old', archived: true })
    const s2 = shipment('s2', { name: 'Old too', archived: true })

    const { fakeDb, batchDelete, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }

    const result = await deleteArchivedShipments(request)

    expect(result.processed).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.done).toBe(true)

    expect(batchDelete).toHaveBeenCalledTimes(2)
    expect(batchDelete).toHaveBeenCalledWith(s1.ref)
    expect(batchDelete).toHaveBeenCalledWith(s2.ref)
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })

  it('returns done=false when chunk is smaller than total deletable docs (all-archived)', async () => {
    const archivedDocs = Array.from({ length: 5 }, (_, i) =>
      shipment(`s${i}`, { archived: true }),
    )

    const { fakeDb } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: archivedDocs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', limit: 3 },
    }

    const result = await deleteArchivedShipments(request)

    // With limit=3 and 5 archived docs, only 3 processed
    expect(result.processed).toBe(3)
    expect(result.deleted).toBe(3)
    expect(result.done).toBe(false) // more to delete
    expect(result.cursor).toBe('s2')
  })
})
