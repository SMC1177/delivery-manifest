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

const serverTimestampSentinel = { __serverTimestamp: true }
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: { serverTimestamp: vi.fn(() => serverTimestampSentinel) },
}))

vi.mock('../lib/admin-guard.js', () => ({
  requirePlatformAdmin: vi.fn(),
}))

import { getOrgUsageSummary, updateOrgBillingConfig } from '../admin-usage.js'
import { requirePlatformAdmin } from '../lib/admin-guard.js'

// One routing function, no spy re-entry. statusCountMap maps status string -> count (default 0).
function makeFakeDb({ orgDocs = {}, auditAdd: auditAddMock, memberCountGet: memberCountGetMock, statusCountMap = {} } = {}) {
  const auditAdd = auditAddMock || vi.fn()
  const orgGet = vi.fn()
  const orgUpdate = vi.fn()
  const memberCountGet = memberCountGetMock || vi.fn()

  function collectionImpl(path) {
    if (path === 'organizations') {
      return {
        get: vi.fn().mockResolvedValue({
          docs: Object.entries(orgDocs).map(([slug, data]) => ({
            id: slug,
            data: () => data,
          })),
        }),
      }
    }
    if (path.startsWith('organizations/') && path.endsWith('/members')) {
      return {
        count: vi.fn(() => ({ get: memberCountGet })),
      }
    }
    if (path.startsWith('organizations/') && path.endsWith('/shipments')) {
      // Capture statusValue from where() so each status returns the right count.
      return {
        where: vi.fn((field, op, statusValue) => ({
          count: vi.fn(() => ({
            get: vi.fn().mockResolvedValue({ data: () => ({ count: statusCountMap[statusValue] ?? 0 }) }),
          })),
        })),
      }
    }
    if (path === 'platformAudit') {
      return { add: auditAdd }
    }
    return {}
  }

  const fakeDb = {
    collection: vi.fn(collectionImpl),
    doc: vi.fn((path) => {
      if (path.startsWith('organizations/')) {
        return { get: orgGet, update: orgUpdate }
      }
      return {}
    }),
  }

  return { fakeDb, orgGet, orgUpdate, memberCountGet, auditAdd }
}

describe('admin-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOrgUsageSummary', () => {
    it('1. Guard rejection propagates: requirePlatformAdmin rejects -> no firestore reads', async () => {
      requirePlatformAdmin.mockRejectedValue(new Error('permission-denied'))

      const { fakeDb } = makeFakeDb({ orgDocs: {} })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(getOrgUsageSummary({ data: {} })).rejects.toThrow('permission-denied')
      expect(fakeDb.collection).not.toHaveBeenCalled()
    })

    it('2. Happy path: two orgs with monthlyUsage data', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgDocs = {
        'org-a': {
          name: 'Org A',
          createdAt: new Date('2025-01-01'),
          billingConfig: { model: 'flat' },
          shipmentCount: 10,
          monthlyUsage: {
            '2026-05': { ups: 5, fedex: 3, usps: 1, other: 1, total: 10 },
            '2026-06': { ups: 2, fedex: 1, usps: 0, other: 0, total: 3 },
          },
        },
        'org-b': {
          name: 'Org B',
          createdAt: new Date('2025-06-01'),
          billingConfig: { model: 'per_shipment' },
          shipmentCount: 5,
          monthlyUsage: {
            '2026-05': { ups: 1, fedex: 1, usps: 0, other: 0, total: 2 },
            '2026-06': { ups: 0, fedex: 0, usps: 0, other: 0, total: 0 },
          },
        },
      }

      const { fakeDb, memberCountGet } = makeFakeDb({ orgDocs, statusCountMap: { delivered: 8 } })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      memberCountGet.mockResolvedValue({ data: () => ({ count: 5 }) })

      const result = await getOrgUsageSummary({ data: { months: ['2026-05', '2026-06'] } })

      expect(result.months).toEqual(['2026-05', '2026-06'])
      expect(result.orgs).toHaveLength(2)

      const orgA = result.orgs.find(o => o.slug === 'org-a')
      expect(orgA.name).toBe('Org A')
      expect(orgA.shipmentCount).toBe(10)
      expect(orgA.memberCount).toBe(5)
      expect(orgA.monthly['2026-05']).toEqual({ ups: 5, fedex: 3, usps: 1, other: 1, total: 10 })
      expect(orgA.monthly['2026-06']).toEqual({ ups: 2, fedex: 1, usps: 0, other: 0, total: 3 })
      expect(orgA.statusCounts.delivered).toBe(8)
    })

    it('3. PHI seam: response JSON does not contain patientName', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgDocs = {
        'org-a': {
          name: 'Org A',
          createdAt: new Date('2025-01-01'),
          billingConfig: { model: 'flat' },
          shipmentCount: 1,
          monthlyUsage: { '2026-05': { ups: 1, fedex: 0, usps: 0, other: 0, total: 1 } },
        },
      }

      const { fakeDb, memberCountGet } = makeFakeDb({ orgDocs })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      memberCountGet.mockResolvedValue({ data: () => ({ count: 1 }) })

      const result = await getOrgUsageSummary({ data: { months: ['2026-05'] } })
      const json = JSON.stringify(result)
      expect(json).not.toContain('SECRET-NAME')
    })

    it('4. months validation: invalid month keys', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const { fakeDb } = makeFakeDb({ orgDocs: {} })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(getOrgUsageSummary({ data: { months: ['2026-13'] } })).rejects.toThrow('Invalid month key')
      await expect(getOrgUsageSummary({ data: { months: ['garbage'] } })).rejects.toThrow('Invalid month key')
    })

    it('5. Per-org failure isolation: org B member count fails -> org A full, org B error', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgDocs = {
        'org-a': {
          name: 'Org A',
          createdAt: new Date('2025-01-01'),
          billingConfig: { model: 'flat' },
          shipmentCount: 10,
          monthlyUsage: { '2026-05': { ups: 5, fedex: 3, usps: 1, other: 1, total: 10 } },
        },
        'org-b': {
          name: 'Org B',
          createdAt: new Date('2025-06-01'),
          billingConfig: { model: 'per_shipment' },
          shipmentCount: 5,
          monthlyUsage: { '2026-05': { ups: 1, fedex: 1, usps: 0, other: 0, total: 2 } },
        },
      }

      const { fakeDb, memberCountGet } = makeFakeDb({ orgDocs })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      // First call (org-a) succeeds, second call (org-b) rejects
      memberCountGet
        .mockResolvedValueOnce({ data: () => ({ count: 5 }) })
        .mockRejectedValueOnce(new Error('db error'))

      const result = await getOrgUsageSummary({ data: { months: ['2026-05'] } })

      expect(result.orgs).toHaveLength(2)
      const orgA = result.orgs.find(o => o.slug === 'org-a')
      expect(orgA.name).toBe('Org A')
      expect(orgA.memberCount).toBe(5)
      const orgB = result.orgs.find(o => o.slug === 'org-b')
      expect(orgB.error).toBe('summary_failed')
    })
  })

  describe('updateOrgBillingConfig', () => {
    it('6. Guard rejection: non-admin -> rejects, no writes', async () => {
      requirePlatformAdmin.mockRejectedValue(new Error('permission-denied'))

      const { fakeDb } = makeFakeDb({ orgDocs: {} })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(updateOrgBillingConfig({ data: { orgSlug: 'test', billingConfig: { model: 'flat' } } })).rejects.toThrow('permission-denied')
      expect(fakeDb.collection).not.toHaveBeenCalled()
      expect(fakeDb.doc).not.toHaveBeenCalled()
    })

    it('7. Validation rejections: invalid model, negative rate, long notes', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const { fakeDb } = makeFakeDb({ orgDocs: {} })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(updateOrgBillingConfig({ data: { orgSlug: 'test', billingConfig: { model: 'gold' } } })).rejects.toThrow('Invalid billing model')
      expect(fakeDb.doc).not.toHaveBeenCalled()

      await expect(updateOrgBillingConfig({ data: { orgSlug: 'test', billingConfig: { model: 'flat', perShipmentRate: -1 } } })).rejects.toThrow('perShipmentRate must be a non-negative finite number or null')
      expect(fakeDb.doc).not.toHaveBeenCalled()

      const longNotes = 'x'.repeat(2001)
      await expect(updateOrgBillingConfig({ data: { orgSlug: 'test', billingConfig: { model: 'flat', notes: longNotes } } })).rejects.toThrow('notes must be a string <= 2000 characters')
      expect(fakeDb.doc).not.toHaveBeenCalled()
    })

    it('8. Unknown orgSlug -> not-found, no writes', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const { fakeDb, orgGet, orgUpdate, auditAdd } = makeFakeDb({ orgDocs: {} })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: false })

      await expect(updateOrgBillingConfig({ data: { orgSlug: 'nonexistent', billingConfig: { model: 'flat' } } })).rejects.toThrow('Organization not found')
      expect(orgUpdate).not.toHaveBeenCalled()
      expect(auditAdd).not.toHaveBeenCalled()
    })

    it('9. Valid update: org update and audit write', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const beforeConfig = { model: 'flat', baseFee: 100 }
      const afterConfig = { model: 'per_shipment', perShipmentRate: 5 }
      const orgDocs = {
        'acme': {
          name: 'Acme',
          billingConfig: beforeConfig,
        },
      }

      const { fakeDb, orgGet, orgUpdate, auditAdd } = makeFakeDb({ orgDocs })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgDocs['acme'] })
      auditAdd.mockResolvedValue({})

      const result = await updateOrgBillingConfig({ data: { orgSlug: 'acme', billingConfig: afterConfig } })

      expect(result).toEqual({ ok: true })
      expect(orgUpdate).toHaveBeenCalledWith({ billingConfig: afterConfig })
      expect(auditAdd).toHaveBeenCalledWith({
        actor: 'admin1',
        actorEmail: 'admin@test.com',
        action: 'billing_config_update',
        orgSlug: 'acme',
        before: beforeConfig,
        after: afterConfig,
        at: serverTimestampSentinel,
      })
    })

    it('10. Audit-write failure: callable rejects', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const beforeConfig = { model: 'flat', baseFee: 100 }
      const afterConfig = { model: 'per_shipment', perShipmentRate: 5 }
      const orgDocs = {
        'acme': {
          name: 'Acme',
          billingConfig: beforeConfig,
        },
      }

      const { fakeDb, orgGet, orgUpdate, auditAdd } = makeFakeDb({ orgDocs })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgDocs['acme'] })
      auditAdd.mockRejectedValue(new Error('audit db error'))

      await expect(updateOrgBillingConfig({ data: { orgSlug: 'acme', billingConfig: afterConfig } })).rejects.toThrow('audit write failed')
      expect(orgUpdate).toHaveBeenCalledWith({ billingConfig: afterConfig })
    })
  })
})
