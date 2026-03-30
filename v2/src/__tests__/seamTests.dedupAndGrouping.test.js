/**
 * Seam Tests: Dedup + Grouping Integration
 *
 * Verifies that the 4-tier dedup system and the tracking number grouping
 * work correctly together. These are integration-style tests that verify
 * the seams between useShipments dedup logic and ShipmentTable grouping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ─── Source-level seam tests (verify code structure) ────────────────────────

const useShipmentsSource = readFileSync(
  join(__dirname, '..', 'hooks', 'useShipments.js'), 'utf-8'
)
const shipmentTableSource = readFileSync(
  join(__dirname, '..', 'components', 'ShipmentTable.jsx'), 'utf-8'
)
const functionsSource = readFileSync(
  join(__dirname, '..', '..', '..', 'functions', 'index.js'), 'utf-8'
)

describe('Seam: 4-tier dedup order in useShipments', () => {
  it('tier 1 (tracking match) runs before tier 2 (Rx merge)', () => {
    // Within addShipment: tracking check happens, then arrayUnion merge
    // Find tracking check and Rx merge within addShipment function body
    const addShipmentStart = useShipmentsSource.indexOf('async function addShipment')
    const body = useShipmentsSource.slice(addShipmentStart)
    const trackingCheck = body.indexOf("where('trackingNumber'")
    const rxMerge = body.indexOf('arrayUnion(')
    expect(trackingCheck).toBeGreaterThan(-1)
    expect(rxMerge).toBeGreaterThan(-1)
    expect(trackingCheck).toBeLessThan(rxMerge)
  })

  it('tier 3 (patient+Rx dedup) runs before tier 4 (date+Rx warning)', () => {
    const patientDedup = useShipmentsSource.indexOf("where('patientName', '=='")
    const dateCheck = useShipmentsSource.indexOf("where('date', '=='")
    expect(patientDedup).toBeGreaterThan(-1)
    expect(dateCheck).toBeGreaterThan(-1)
    expect(patientDedup).toBeLessThan(dateCheck)
  })

  it('tier 3 checks allRxExist (all new Rx must exist on existing record)', () => {
    expect(useShipmentsSource).toContain('newRxNumbers.every')
    expect(useShipmentsSource).toContain('allRxExist')
  })

  it('tier 4 checks partial overlap (any Rx match)', () => {
    expect(useShipmentsSource).toContain('newRxNumbers.some')
  })
})

describe('Seam: ShipmentTable grouping logic', () => {
  it('groups by tracking number using case-insensitive key', () => {
    expect(shipmentTableSource).toContain('.trim().toLowerCase()')
  })

  it('uses a trackingMap to group docs', () => {
    expect(shipmentTableSource).toContain('trackingMap')
    expect(shipmentTableSource).toContain('new Map()')
  })

  it('standalone rows (no tracking) are not grouped', () => {
    // No tracking number → trackingKey: null, no grouping
    expect(shipmentTableSource).toContain('trackingKey: null')
  })

  it('getMergedRx deduplicates across primary and children', () => {
    expect(shipmentTableSource).toContain('getMergedRx')
    expect(shipmentTableSource).toContain('new Set()')
    expect(shipmentTableSource).toContain('seen.has')
  })

  it('expandedGroups state drives expand/collapse', () => {
    expect(shipmentTableSource).toContain('expandedGroups')
    expect(shipmentTableSource).toContain('toggleGroup')
  })
})

describe('Seam: Cloud Functions polling dedup', () => {
  it('FedEx sync dedupes tracking numbers before polling', () => {
    // Should group docs by tracking number
    expect(functionsSource).toContain("byTracking = new Map()")
    expect(functionsSource).toContain("uniqueTrackingNumbers")
  })

  it('UPS sync dedupes tracking numbers before polling', () => {
    // Count occurrences of byTracking — should appear in both FedEx and UPS
    const matches = functionsSource.match(/byTracking = new Map\(\)/g)
    expect(matches.length).toBe(2)
  })

  it('FedEx applies result to ALL docs sharing a tracking number', () => {
    expect(functionsSource).toContain("byTracking.get(tn)")
  })

  it('FedEx batches unique TNs in groups of 30', () => {
    expect(functionsSource).toContain("BATCH_SIZE = 30")
    expect(functionsSource).toContain("uniqueTrackingNumbers.slice(i, i + BATCH_SIZE)")
  })

  it('scheduled functions have 540s timeout and 1GiB memory', () => {
    expect(functionsSource).toContain("timeoutSeconds: 540")
    expect(functionsSource).toContain("memory: '1GiB'")
  })

  it('Firestore writes are batched at 500', () => {
    expect(functionsSource).toContain("WRITE_BATCH_SIZE = 500")
  })

  it('FedEx defaults to production API', () => {
    // getFedExBaseUrl returns production by default
    expect(functionsSource).toContain("return 'https://apis.fedex.com'")
    // sandbox is only used when explicitly set
    expect(functionsSource).toContain("fedexMode.value() === 'sandbox'")
  })

  it('logs both total docs and unique tracking number counts', () => {
    expect(functionsSource).toContain('unique tracking numbers')
    expect(functionsSource).toContain('unique TNs')
  })
})

// ─── Mock-based seam tests (verify behavior across tiers) ──────────────────

const mockGetDocs = vi.fn()
const mockAddDoc = vi.fn()
const mockUpdateDoc = vi.fn()

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'mock-col-ref'),
  query: vi.fn((...args) => args),
  where: vi.fn((...args) => args),
  getDocs: (...args) => mockGetDocs(...args),
  onSnapshot: vi.fn((q, onNext) => {
    onNext({ docs: [] })
    return vi.fn()
  }),
  addDoc: (...args) => mockAddDoc(...args),
  updateDoc: (...args) => mockUpdateDoc(...args),
  deleteDoc: vi.fn(),
  doc: vi.fn(() => 'mock-doc-ref'),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP'),
  arrayUnion: vi.fn((...args) => args),
}))

vi.mock('../lib/firebase', () => ({ auth: {}, db: {} }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ orgSlug: 'test-org', user: { uid: 'test-user' } }),
}))

const { useShipments } = await import('../hooks/useShipments')
import { renderHook, act } from '@testing-library/react'

describe('Seam: tier 1 (tracking) → tier 2 (merge) → stops before tier 3', () => {
  beforeEach(() => vi.clearAllMocks())

  it('tracking match with new Rx merges and never reaches patient dedup', async () => {
    // Tier 1: tracking match found with existing Rx
    mockGetDocs.mockResolvedValueOnce({
      empty: false,
      docs: [{
        id: 'existing-1',
        data: () => ({
          patientName: 'Alice',
          rxNumbers: ['RX001'],
          trackingNumber: '1ZSAME',
        }),
      }],
    })
    mockUpdateDoc.mockResolvedValueOnce()

    const { result } = renderHook(() => useShipments('test-org'))
    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Alice',
        trackingNumber: '1ZSAME',
        rxNumbers: ['RX001', 'RX002'],
      })
    })

    // Merged in tier 2 — only 1 getDocs call (tracking check)
    expect(addResult.merged).toBe(true)
    expect(mockGetDocs).toHaveBeenCalledTimes(1)
  })
})

describe('Seam: tier 1 miss → tier 3 (patient+Rx) catches re-import', () => {
  beforeEach(() => vi.clearAllMocks())

  it('different tracking but same patient+Rx is caught by tier 3', async () => {
    // Tier 1: no tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // Tier 3: patient match with all Rx present
    mockGetDocs.mockResolvedValueOnce({
      docs: [{
        id: 'existing-2',
        data: () => ({
          patientName: 'Bob',
          rxNumbers: ['RX100', 'RX101'],
          trackingNumber: '1ZOLD',
        }),
      }],
    })

    const { result } = renderHook(() => useShipments('test-org'))
    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Bob',
        trackingNumber: '1ZNEW',
        rxNumbers: ['RX100'],
      })
    })

    // Caught by tier 3 — 2 getDocs calls (tracking + patient)
    expect(addResult.skipped).toBe(true)
    expect(mockGetDocs).toHaveBeenCalledTimes(2)
    // Never reaches tier 4 (date check)
    expect(mockAddDoc).not.toHaveBeenCalled()
  })
})

describe('Seam: all 4 tiers pass → shipment created', () => {
  beforeEach(() => vi.clearAllMocks())

  it('brand new shipment passes all tiers and is created', async () => {
    // Tier 1: no tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // Tier 3: no patient match
    mockGetDocs.mockResolvedValueOnce({ docs: [] })
    // Tier 4: no date overlap
    mockGetDocs.mockResolvedValueOnce({ empty: false, docs: [] })
    mockAddDoc.mockResolvedValueOnce({ id: 'brand-new' })

    const { result } = renderHook(() => useShipments('test-org'))
    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'New Person',
        trackingNumber: '1ZBRAND',
        rxNumbers: ['RX999'],
      })
    })

    expect(addResult.id).toBe('brand-new')
    expect(addResult.skipped).toBeFalsy()
    expect(addResult.merged).toBe(false)
    // All 3 getDocs calls made (tier 1 + tier 3 + tier 4)
    expect(mockGetDocs).toHaveBeenCalledTimes(3)
    expect(mockAddDoc).toHaveBeenCalledTimes(1)
  })
})
