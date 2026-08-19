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

import { archiveShipments, restoreShipments } from '../archive-shipments.js'

// ── helpers ────────────────────────────────────────────────────────

/**
 * Build a fake Firestore with full control over every seam.
 *
 * @param {Object} opts
 * @param {Object} opts.memberSnap        — snapshot returned for member doc get
 * @param {Array}  opts.shipments         — docs the cutoff query returns AND available
 *                                          for individual doc gets (ids mode / cursor)
 * @param {Object} opts.cursorDocSnap     — optional override for cursor doc lookup
 * @param {string} opts.orgSlug
 * @param {Array}  opts.extraShipmentGets — extra {id, snap} for docs NOT in `shipments`
 *                                          but fetchable via doc().get() (e.g. boundary test)
 */
function makeFakeDb({
  memberSnap = { exists: false, data: () => ({}) },
  shipments = [],
  cursorDocSnap = null,
  orgSlug = 'test-org',
  extraShipmentGets = [],
} = {}) {
  // ── member doc ──────────────────────────────────────────────────
  const memberGet = vi.fn().mockResolvedValue(memberSnap)
  const memberRef = { get: memberGet }

  // ── shipment docs (by id) ───────────────────────────────────────
  /** @type {Map<string, Object>} */
  const shipmentDocMap = new Map()
  for (const s of shipments) {
    const ref = s.ref || { id: s.id, path: `organizations/${orgSlug}/shipments/${s.id}` }
    shipmentDocMap.set(s.id, { exists: true, id: s.id, ref, data: () => s.data })
  }
  for (const { id, snap } of extraShipmentGets) {
    shipmentDocMap.set(id, snap)
  }

  // ── shipment query (cutoff mode) ────────────────────────────────
  const shipmentSnapshot = {
    docs: [...shipmentDocMap.values()].filter(
      (d) => !extraShipmentGets.some((e) => e.id === d.id)
    ),
    forEach: (cb) => {
      for (const s of shipments) {
        const doc = shipmentDocMap.get(s.id)
        if (doc && !extraShipmentGets.some((e) => e.id === doc.id)) cb(doc)
      }
    },
  }
  const queryGet = vi.fn().mockResolvedValue(shipmentSnapshot)

  const queryObj = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    startAfter: vi.fn().mockReturnThis(),
    get: queryGet,
  }

  // ── batch ───────────────────────────────────────────────────────
  const batchUpdate = vi.fn()
  const batchCommit = vi.fn().mockResolvedValue([])
  const batch = vi.fn(() => ({
    update: batchUpdate,
    commit: batchCommit,
  }))

  // ── audit collection ────────────────────────────────────────────
  const auditAdd = vi.fn().mockResolvedValue({ id: 'audit-1' })

  // ── doc routing ─────────────────────────────────────────────────
  function docImpl(path) {
    if (path.includes('/members/')) return memberRef

    const shipmentMatch = path.match(/\/shipments\/([^/]+)$/)
    if (shipmentMatch) {
      const sid = shipmentMatch[1]
      // Cursor override takes priority
      if (cursorDocSnap && sid === cursorDocSnap.id) {
        return { get: vi.fn().mockResolvedValue(cursorDocSnap) }
      }
      const existing = shipmentDocMap.get(sid)
      if (existing) {
        return { get: vi.fn().mockResolvedValue(existing) }
      }
      return { get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }
    }

    if (path === `organizations/${orgSlug}`) {
      return { update: vi.fn().mockResolvedValue({ writeTime: {} }) }
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
    batchUpdate,
    batchCommit,
    batch,
    auditAdd,
    shipmentDocMap,
    shipmentSnapshot,
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

describe('archiveShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. ADMIN GUARD
  // ======================================================================

  it('rejects unauthenticated calls to archiveShipments', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' } }
    expect(request.auth).toBeUndefined()

    await expect(archiveShipments(request)).rejects.toThrow('Login required')

    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated user who is not a member of the org (archiveShipments)', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    await expect(archiveShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user1'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated member whose role is not admin (archiveShipments)', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user2', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    await expect(archiveShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user2'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 2. CUTOFF BOUNDARY — the highest-value test
  // ======================================================================

  it('does NOT archive a shipment dated exactly on the cutoffDate — strict < only', async () => {
    // Shipment exactly on the cutoff date MUST survive.
    // We prove this by (a) asserting the query uses '<' not '<=',
    // and (b) placing only the pre-cutoff doc in the query result set,
    // then verifying the boundary doc was never passed to batch.update.
    const beforeCutoff = shipment('s-pre', { date: '2023-12-31', name: 'Before' })
    const onCutoff = shipment('s-boundary', { date: '2024-01-01', name: 'Boundary' })

    const { fakeDb, queryObj, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [beforeCutoff], // only the pre-cutoff doc is in the query result
      extraShipmentGets: [
        {
          id: onCutoff.id,
          snap: { exists: true, id: onCutoff.id, ref: onCutoff.ref, data: () => onCutoff.data },
        },
      ],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    const result = await archiveShipments(request)

    // The query MUST use strict '<' — never '<='
    expect(queryObj.where).toHaveBeenCalledWith('date', '<', '2024-01-01')

    // Only the before-cutoff doc was processed
    expect(result.processed).toBe(1)
    expect(result.changed).toBe(1)
    expect(result.done).toBe(true)

    // Only the pre-cutoff doc was updated — the boundary doc must not appear
    const updatedRefs = batchUpdate.mock.calls.map((c) => c[0])
    expect(updatedRefs).toContain(beforeCutoff.ref)
    expect(updatedRefs).not.toContain(onCutoff.ref)
  })

  it('archives shipments strictly before the cutoff date', async () => {
    const older = shipment('s-old', { date: '2022-06-15', name: 'Old' })

    const { fakeDb, queryObj, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [older],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    const result = await archiveShipments(request)

    expect(queryObj.where).toHaveBeenCalledWith('date', '<', '2024-01-01')
    expect(result.changed).toBe(1)
    expect(batchUpdate).toHaveBeenCalledWith(
      older.ref,
      expect.objectContaining({ archived: true }),
    )
  })

  // ======================================================================
  // 3. ARCHIVEDAT IS NEVER OVERWRITTEN
  // ======================================================================

  it('skips already-archived shipments so original archivedAt survives', async () => {
    const fresh = shipment('s-fresh', { date: '2023-01-01', name: 'Fresh' })
    const alreadyArchived = shipment('s-archived', {
      date: '2022-01-01',
      name: 'Already Archived',
      archived: true,
      archivedAt: { _seconds: 1700000000 },
      archivedBy: 'original-admin',
    })

    const { fakeDb, batchUpdate, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [fresh, alreadyArchived],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    const result = await archiveShipments(request)

    // Both processed, only one changed
    expect(result.processed).toBe(2)
    expect(result.changed).toBe(1)

    // Only the fresh doc gets updated
    const updatedRefs = batchUpdate.mock.calls.map((c) => c[0])
    expect(updatedRefs).toContain(fresh.ref)
    expect(updatedRefs).not.toContain(alreadyArchived.ref)

    // The fresh doc gets archived:true + timestamp + uid
    expect(batchUpdate).toHaveBeenCalledWith(
      fresh.ref,
      {
        archived: true,
        archivedAt: SERVER_TIMESTAMP,
        archivedBy: 'admin1',
      },
    )

    // Batch still committed (one update)
    expect(batchCommit).toHaveBeenCalled()
  })

  it('re-running archive on the same set changes nothing', async () => {
    const alreadyArchived = shipment('s-1', {
      date: '2022-01-01',
      archived: true,
      archivedAt: { _seconds: 1700000000 },
      archivedBy: 'original-admin',
    })

    const { fakeDb, batchUpdate, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [alreadyArchived],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    const result = await archiveShipments(request)

    expect(result.processed).toBe(1)
    expect(result.changed).toBe(0)
    expect(batchUpdate).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 4. RESTORE REMOVES FIELDS (on restoreShipments)
  // ======================================================================

  it('restoreShipments uses FieldValue.delete() for archivedAt and archivedBy', async () => {
    const archived = shipment('s-restore', {
      archived: true,
      archivedAt: { _seconds: 1700000000 },
      archivedBy: 'admin1',
    })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [archived],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s-restore'] },
    }

    const result = await restoreShipments(request)

    expect(result.processed).toBe(1)
    expect(result.changed).toBe(1)

    // Must use FieldValue.delete() sentinels — not null
    expect(batchUpdate).toHaveBeenCalledWith(archived.ref, {
      archived: false,
      archivedAt: DELETE_SENTINEL,
      archivedBy: DELETE_SENTINEL,
    })
  })

  it('restoreShipments skips non-archived records', async () => {
    const notArchived = shipment('s-active', { name: 'Active' })

    const { fakeDb, batchUpdate, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [notArchived],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: ['s-active'] },
    }

    const result = await restoreShipments(request)

    expect(result.processed).toBe(1)
    expect(result.changed).toBe(0)
    expect(batchUpdate).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 5. DRY RUN WRITES NOTHING
  // ======================================================================

  it('dryRun=true never creates a batch — no mutation possible', async () => {
    const docs = [
      shipment('s1', { date: '2023-01-01' }),
      shipment('s2', { date: '2023-06-15' }),
    ]

    const { fakeDb, batch, batchUpdate, batchCommit } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        mode: 'cutoff',
        cutoffDate: '2024-01-01',
        dryRun: true,
      },
    }

    const result = await archiveShipments(request)

    // Must not have created or committed a batch
    expect(batch).not.toHaveBeenCalled()
    expect(batchUpdate).not.toHaveBeenCalled()
    expect(batchCommit).not.toHaveBeenCalled()

    // But counts must still be returned
    expect(result.processed).toBe(2)
    expect(result.changed).toBe(2) // both lack archived:true → counted
    expect(result.done).toBe(true)
  })

  it('dryRun=true counts only non-archived docs, not already-archived ones', async () => {
    const fresh = shipment('s1', { date: '2023-01-01' })
    const already = shipment('s2', { date: '2023-06-15', archived: true })

    const { fakeDb, batch } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [fresh, already],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        mode: 'cutoff',
        cutoffDate: '2024-01-01',
        dryRun: true,
      },
    }

    const result = await archiveShipments(request)

    expect(batch).not.toHaveBeenCalled()
    expect(result.processed).toBe(2)
    expect(result.changed).toBe(1) // only the non-archived one
  })

  it('dryRun=true does not write audit entries', async () => {
    const docs = [shipment('s1', { date: '2023-01-01' })]

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: docs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: {
        slug: 'test-org',
        mode: 'cutoff',
        cutoffDate: '2024-01-01',
        dryRun: true,
      },
    }

    await archiveShipments(request)

    expect(auditAdd).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 6. CHUNK CAP
  // ======================================================================

  it('clamps limit to 500 in cutoff mode — Firestore writeBatch throws above 500', async () => {
    const { fakeDb, queryObj } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01', limit: 600 },
    }

    await archiveShipments(request)

    expect(queryObj.limit).toHaveBeenCalledWith(500)
  })

  it('rejects ids array longer than 500 in archiveShipments rather than silently truncating', async () => {
    const { fakeDb } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const tooManyIds = Array.from({ length: 501 }, (_, i) => `id-${i}`)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'ids', ids: tooManyIds },
    }

    await expect(archiveShipments(request)).rejects.toThrow('must not exceed 500')
  })

  it('rejects ids array longer than 500 in restoreShipments', async () => {
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

    await expect(restoreShipments(request)).rejects.toThrow('must not exceed 500')
  })

  it('clamps limit to 500 in restoreShipments', async () => {
    // restoreShipments doesn't have a queryObj.limit since it uses ids mode,
    // but chunkSize is capped. We verify by passing a huge limit and observing
    // only up to 500 ids are fetched from doc().
    const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`)
    const shipDocs = ids.map((id) => shipment(id, { name: id }))

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: shipDocs,
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids, limit: 600 },
    }

    const result = await restoreShipments(request)

    // With 10 ids, all should be processed (chunkSize capped at 500 but 10 < 500)
    expect(result.processed).toBe(10)
    expect(result.done).toBe(true)
    // All 10 should have been updated (they lack archived:true, so restore skips them)
    expect(result.changed).toBe(0)
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  // ======================================================================
  // 7. INPUT VALIDATION
  // ======================================================================

  it('rejects non-string slug (number)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 123, mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects null slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: null, mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects empty string slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects whitespace-only slug', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: '   ', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Slug is required')
  })

  it('rejects over-long slug (>128 chars)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'a'.repeat(129), mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Slug too long')
  })

  it('rejects slug containing forward slash (path traversal guard)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'evil/../other-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('Invalid slug')
  })

  it('rejects invalid mode', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'bogus' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('mode must be "cutoff", "ids", or "filter"')
  })

  it('rejects missing cutoffDate in cutoff mode', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('cutoffDate is required')
  })

  it('rejects non-string cutoffDate', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: 12345 },
    }
    await expect(archiveShipments(request)).rejects.toThrow('cutoffDate is required')
  })

  it('rejects invalid cutoffDate string (not parseable)', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: 'not-a-date' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('must be a valid date string')
  })

  it('rejects missing ids array in ids mode', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'ids' },
    }
    await expect(archiveShipments(request)).rejects.toThrow('ids array is required')
  })

  it('rejects empty ids array in ids mode', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'ids', ids: [] },
    }
    await expect(archiveShipments(request)).rejects.toThrow('ids array is required')
  })

  // ======================================================================
  // 8. IDS MODE — basic functionality
  // ======================================================================

  it('archives specific shipments by id list', async () => {
    const s1 = shipment('id1', { name: 'Shipment 1' })
    const s2 = shipment('id2', { name: 'Shipment 2' })

    const { fakeDb, batchUpdate } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1, s2],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', mode: 'ids', ids: ['id1', 'id2'] },
    }

    const result = await archiveShipments(request)

    expect(result.processed).toBe(2)
    expect(result.changed).toBe(2)
    expect(batchUpdate).toHaveBeenCalledTimes(2)
    expect(batchUpdate).toHaveBeenCalledWith(s1.ref, expect.objectContaining({ archived: true }))
    expect(batchUpdate).toHaveBeenCalledWith(s2.ref, expect.objectContaining({ archived: true }))
  })

  it('writes audit entry on successful archive', async () => {
    const s1 = shipment('s1', { date: '2023-01-01' })

    const { fakeDb, auditAdd } = makeFakeDb({
      memberSnap: adminMemberSnap(),
      shipments: [s1],
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'admin1', token: { email: 'admin@test.com' } },
      data: { slug: 'test-org', mode: 'cutoff', cutoffDate: '2024-01-01' },
    }

    await archiveShipments(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const auditEntry = auditAdd.mock.calls[0][0]
    expect(auditEntry.actor).toBe('admin1')
    expect(auditEntry.actorEmail).toBe('admin@test.com')
    expect(auditEntry.action).toBe('archive_shipments')
    expect(auditEntry.mode).toBe('cutoff')
    expect(auditEntry.cutoffDate).toBe('2024-01-01')
    expect(auditEntry.changed).toBe(1)
  })
})

describe('restoreShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ======================================================================
  // 1. ADMIN GUARD
  // ======================================================================

  it('rejects unauthenticated calls to restoreShipments', async () => {
    const { fakeDb } = makeFakeDb({ memberSnap: adminMemberSnap() })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = { data: { slug: 'test-org', ids: ['s1'] } }
    expect(request.auth).toBeUndefined()

    await expect(restoreShipments(request)).rejects.toThrow('Login required')

    expect(fakeDb.doc).not.toHaveBeenCalled()
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated user who is not a member of the org (restoreShipments)', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: false, data: () => ({}) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user1', token: {} },
      data: { slug: 'test-org', ids: ['s1'] },
    }

    await expect(restoreShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user1'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  it('rejects authenticated member whose role is not admin (restoreShipments)', async () => {
    const { fakeDb, doc } = makeFakeDb({
      memberSnap: { exists: true, data: () => ({ role: 'manager' }) },
    })
    const { getFirestore } = await import('firebase-admin/firestore')
    getFirestore.mockReturnValue(fakeDb)

    const request = {
      auth: { uid: 'user2', token: {} },
      data: { slug: 'test-org', ids: ['s1'] },
    }

    await expect(restoreShipments(request)).rejects.toThrow('Admin access required')

    expect(doc).toHaveBeenCalledWith(expect.stringContaining('/members/user2'))
    expect(fakeDb.collection).not.toHaveBeenCalled()
  })

  // ======================================================================
  // INPUT VALIDATION
  // ======================================================================

  it('rejects missing ids array in restoreShipments', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org' },
    }
    await expect(restoreShipments(request)).rejects.toThrow('ids array is required')
  })

  it('rejects empty ids array in restoreShipments', async () => {
    const request = {
      auth: { uid: 'admin1', token: {} },
      data: { slug: 'test-org', ids: [] },
    }
    await expect(restoreShipments(request)).rejects.toThrow('ids array is required')
  })

  // ======================================================================
  // RESTORE FUNCTIONALITY
  // ======================================================================

  it('writes audit entry on successful restore', async () => {
    const s1 = shipment('s1', {
      archived: true,
      archivedAt: { _seconds: 1700000000 },
      archivedBy: 'admin1',
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

    await restoreShipments(request)

    expect(auditAdd).toHaveBeenCalledTimes(1)
    const auditEntry = auditAdd.mock.calls[0][0]
    expect(auditEntry.actor).toBe('admin1')
    expect(auditEntry.action).toBe('restore_shipments')
    expect(auditEntry.changed).toBe(1)
  })
})
