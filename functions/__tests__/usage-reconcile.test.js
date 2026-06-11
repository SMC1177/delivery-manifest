import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: vi.fn((opts, handler) => ({ opts, handler })),
}))

const serverTimestampSentinel = { __serverTimestamp: true }
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: { serverTimestamp: vi.fn(() => serverTimestampSentinel) },
  Timestamp: {
    fromDate: vi.fn((d) => ({ toDate: () => d, __fromDate: true })),
  },
}))

import { emptyBucket, recountOrgMonth, reconcileUsageMonthly } from '../usage-reconcile.js'

function makeFakeDb({ orgData, shipments, auditAdd: auditAddMock }) {
  const auditAdd = auditAddMock || vi.fn()
  const orgUpdate = vi.fn()
  const orgGet = vi.fn()
  const shipmentsWhere = vi.fn()
  const shipmentsSelect = vi.fn()
  const shipmentsGet = vi.fn()
  const countGet = vi.fn()

  const shipmentsQuery = {
    where: vi.fn(() => shipmentsQuery),
    select: vi.fn(() => shipmentsQuery),
    get: shipmentsGet,
    count: vi.fn(() => ({
      get: countGet,
    })),
  }

  const fakeDb = {
    collection: vi.fn((path) => {
      if (path.startsWith('organizations/')) {
        return {
          doc: vi.fn((id) => ({
            get: orgGet,
            update: orgUpdate,
          })),
          where: shipmentsQuery.where,
          select: shipmentsQuery.select,
          get: shipmentsQuery.get,
          count: shipmentsQuery.count,
        }
      }
      if (path === 'platformAudit') {
        return {
          doc: vi.fn(() => ({
            set: auditAdd,
          })),
        }
      }
      return {}
    }),
    doc: vi.fn((path) => {
      if (path.startsWith('organizations/')) {
        return {
          get: orgGet,
          update: orgUpdate,
        }
      }
      return {}
    }),
  }

  return { fakeDb, orgGet, orgUpdate, shipmentsWhere, shipmentsSelect, shipmentsGet, countGet, auditAdd }
}

describe('usage-reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('emptyBucket()', () => {
    it('returns { ups:0, fedex:0, usps:0, other:0, total:0 }', () => {
      const b = emptyBucket()
      expect(b).toEqual({ ups: 0, fedex: 0, usps: 0, other: 0, total: 0 })
    })

    it('returns a FRESH object each call', () => {
      const b1 = emptyBucket()
      const b2 = emptyBucket()
      b1.ups = 99
      expect(b2.ups).toBe(0)
    })
  })

  describe('recountOrgMonth', () => {
    it('1. DRIFT OVERWRITE: stored values differ from recount -> writes full bucket, audit, changed:true', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsWhere, shipmentsSelect, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      // Stored org data
      orgGet.mockResolvedValue({
        data: () => ({
          monthlyUsage: {
            '2026-05': { ups: 3, fedex: 1, usps: 0, other: 0, total: 4 },
          },
          shipmentCount: 4,
        }),
      })

      // Shipment docs in window
      const shipmentDocs = [
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') } }) },
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-20T12:00:00Z') } }) },
        { data: () => ({ carrier: 'fedex', createdAt: { toDate: () => new Date('2026-05-25T12:00:00Z') } }) },
      ]
      shipmentsGet.mockResolvedValue({ docs: shipmentDocs })
      countGet.mockResolvedValue({ data: () => ({ count: 3 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(true)
      expect(result.before.monthlyUsage['2026-05']).toEqual({ ups: 3, fedex: 1, usps: 0, other: 0, total: 4 })
      expect(result.before.shipmentCount).toBe(4)
      expect(result.after.monthlyUsage['2026-05']).toEqual({ ups: 2, fedex: 1, usps: 0, other: 0, total: 3 })
      expect(result.after.shipmentCount).toBe(3)

      expect(orgUpdate).toHaveBeenCalledTimes(1)
      expect(orgUpdate).toHaveBeenCalledWith({
        'monthlyUsage.2026-05': { ups: 2, fedex: 1, usps: 0, other: 0, total: 3 },
        shipmentCount: 3,
      })

      expect(auditAdd).toHaveBeenCalledTimes(1)
      const auditCall = auditAdd.mock.calls[0][0]
      expect(auditCall.actor).toBe('system:reconcile')
      expect(auditCall.orgSlug).toBe('acme')
      expect(auditCall.monthKey).toBe('2026-05')
      expect(auditCall.before.monthlyUsage['2026-05']).toEqual({ ups: 3, fedex: 1, usps: 0, other: 0, total: 4 })
      expect(auditCall.after.monthlyUsage['2026-05']).toEqual({ ups: 2, fedex: 1, usps: 0, other: 0, total: 3 })
    })

    it('2. NO-CHANGE = NO WRITES: stored values match recount -> no org update, no audit, changed:false', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      orgGet.mockResolvedValue({
        data: () => ({
          monthlyUsage: {
            '2026-05': { ups: 2, fedex: 1, usps: 0, other: 0, total: 3 },
          },
          shipmentCount: 3,
        }),
      })

      const shipmentDocs = [
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') } }) },
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-20T12:00:00Z') } }) },
        { data: () => ({ carrier: 'fedex', createdAt: { toDate: () => new Date('2026-05-25T12:00:00Z') } }) },
      ]
      shipmentsGet.mockResolvedValue({ docs: shipmentDocs })
      countGet.mockResolvedValue({ data: () => ({ count: 3 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(false)
      expect(orgUpdate).not.toHaveBeenCalled()
      expect(auditAdd).not.toHaveBeenCalled()
    })

    it('3. LEGACY UPPERCASE: carrier UPS and FedEx -> bucket ups/fedex', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      orgGet.mockResolvedValue({
        data: () => ({
          monthlyUsage: {},
          shipmentCount: 0,
        }),
      })

      const shipmentDocs = [
        { data: () => ({ carrier: 'UPS', createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') } }) },
        { data: () => ({ carrier: 'FedEx', createdAt: { toDate: () => new Date('2026-05-20T12:00:00Z') } }) },
      ]
      shipmentsGet.mockResolvedValue({ docs: shipmentDocs })
      countGet.mockResolvedValue({ data: () => ({ count: 2 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(true)
      expect(result.after.monthlyUsage['2026-05']).toEqual({ ups: 1, fedex: 1, usps: 0, other: 0, total: 2 })
    })

    it('4. WINDOW-EDGE FILTER: doc inside padded window but neighboring CT month excluded', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      orgGet.mockResolvedValue({
        data: () => ({
          monthlyUsage: {},
          shipmentCount: 0,
        }),
      })

      // Doc at 2026-06-01T06:00:00Z = 1am CT June 1, should be excluded from May recount
      const shipmentDocs = [
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-06-01T06:00:00Z') } }) },
      ]
      shipmentsGet.mockResolvedValue({ docs: shipmentDocs })
      countGet.mockResolvedValue({ data: () => ({ count: 1 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(true)
      expect(result.after.monthlyUsage['2026-05']).toEqual({ ups: 0, fedex: 0, usps: 0, other: 0, total: 0 })
      expect(result.after.shipmentCount).toBe(1)
    })

    it('5. EMPTY MONTH: no docs, stored missing -> treat as empty, no change', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      orgGet.mockResolvedValue({
        data: () => ({}),
      })

      shipmentsGet.mockResolvedValue({ docs: [] })
      countGet.mockResolvedValue({ data: () => ({ count: 0 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(false)
      expect(orgUpdate).not.toHaveBeenCalled()
      expect(auditAdd).not.toHaveBeenCalled()
    })

    it('6. PHI NEVER ENTERS AUDIT: patientName not in audit payload', async () => {
      const auditAdd = vi.fn()
      const { fakeDb, orgGet, orgUpdate, shipmentsGet, countGet } = makeFakeDb({ auditAdd })

      orgGet.mockResolvedValue({
        data: () => ({
          monthlyUsage: {
            '2026-05': { ups: 3, fedex: 1, usps: 0, other: 0, total: 4 },
          },
          shipmentCount: 4,
        }),
      })

      const shipmentDocs = [
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, patientName: 'SECRET-NAME' }) },
        { data: () => ({ carrier: 'ups', createdAt: { toDate: () => new Date('2026-05-20T12:00:00Z') }, patientName: 'SECRET-NAME' }) },
        { data: () => ({ carrier: 'fedex', createdAt: { toDate: () => new Date('2026-05-25T12:00:00Z') }, patientName: 'SECRET-NAME' }) },
      ]
      shipmentsGet.mockResolvedValue({ docs: shipmentDocs })
      countGet.mockResolvedValue({ data: () => ({ count: 3 }) })

      const result = await recountOrgMonth(fakeDb, 'acme', '2026-05')

      expect(result.changed).toBe(true)
      expect(auditAdd).toHaveBeenCalledTimes(1)
      const auditPayload = JSON.stringify(auditAdd.mock.calls[0][0])
      expect(auditPayload).not.toContain('SECRET-NAME')
    })

    it('7. emptyBucket() returns fresh object each call (already tested above)', () => {
      // Already covered in describe('emptyBucket')
    })
  })

  describe('reconcileUsageMonthly', () => {
    it('8. is exported and carries schedule options with timeZone America/Chicago', () => {
      expect(reconcileUsageMonthly).toBeDefined()
      expect(reconcileUsageMonthly.opts).toBeDefined()
      expect(reconcileUsageMonthly.opts.schedule).toBe('0 4 1 * *')
      expect(reconcileUsageMonthly.opts.timeZone).toBe('America/Chicago')
    })
  })
})
