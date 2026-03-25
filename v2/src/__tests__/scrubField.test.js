import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetDocs = vi.fn()
const mockWriteBatch = vi.fn()
const mockBatchUpdate = vi.fn()
const mockBatchCommit = vi.fn()
const mockDeleteField = vi.fn(() => 'FIELD_DELETE_SENTINEL')
const mockDoc = vi.fn((...args) => args.join('/'))
const mockCollection = vi.fn((...args) => args.join('/'))

vi.mock('firebase/firestore', () => ({
  collection: (...args) => mockCollection(...args),
  getDocs: (...args) => mockGetDocs(...args),
  writeBatch: () => mockWriteBatch(),
  deleteField: () => mockDeleteField(),
  doc: (...args) => mockDoc(...args),
}))

vi.mock('../lib/firebase', () => ({
  db: 'mock-db',
}))

const { scrubFieldFromShipments, CORE_FIELDS, SCRUBBABLE_FIELDS } = await import('../lib/scrubField')

describe('scrubFieldFromShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteBatch.mockReturnValue({
      update: mockBatchUpdate,
      commit: mockBatchCommit,
    })
    mockBatchCommit.mockResolvedValue(undefined)
  })

  it('scrubs a field from all shipments that have it', async () => {
    mockGetDocs.mockResolvedValueOnce({
      empty: false,
      size: 3,
      docs: [
        { id: 'doc1', data: () => ({ patientName: 'Alice', phone: '555-1234' }) },
        { id: 'doc2', data: () => ({ patientName: 'Bob', phone: '555-5678' }) },
        { id: 'doc3', data: () => ({ patientName: 'Charlie' }) }, // no phone field
      ],
    })

    const count = await scrubFieldFromShipments('test-org', 'phone')

    expect(count).toBe(2)
    expect(mockBatchUpdate).toHaveBeenCalledTimes(2)
    expect(mockBatchCommit).toHaveBeenCalledTimes(1)
    // Verify deleteField sentinel is used
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { phone: 'FIELD_DELETE_SENTINEL' }
    )
  })

  it('returns 0 when collection is empty', async () => {
    mockGetDocs.mockResolvedValueOnce({ empty: true, size: 0, docs: [] })

    const count = await scrubFieldFromShipments('test-org', 'address')
    expect(count).toBe(0)
    expect(mockWriteBatch).not.toHaveBeenCalled()
  })

  it('splits into multiple batches when >500 docs', async () => {
    // Create 600 docs, all with the 'notes' field
    const docs = Array.from({ length: 600 }, (_, i) => ({
      id: `doc${i}`,
      data: () => ({ patientName: `Patient ${i}`, notes: 'some note' }),
    }))

    mockGetDocs.mockResolvedValueOnce({ empty: false, size: 600, docs })

    const count = await scrubFieldFromShipments('test-org', 'notes')

    expect(count).toBe(600)
    // Should create 2 batches: 500 + 100
    expect(mockWriteBatch).toHaveBeenCalledTimes(2)
    expect(mockBatchCommit).toHaveBeenCalledTimes(2)
  })

  it('throws when trying to scrub a core field', async () => {
    for (const field of CORE_FIELDS) {
      await expect(scrubFieldFromShipments('test-org', field)).rejects.toThrow(
        `Cannot scrub core field: ${field}`
      )
    }
  })

  it('throws for non-scrubbable fields', async () => {
    await expect(scrubFieldFromShipments('test-org', 'unknownField')).rejects.toThrow(
      'Field is not eligible for scrubbing: unknownField'
    )
  })

  it('throws when orgSlug is missing', async () => {
    await expect(scrubFieldFromShipments('', 'phone')).rejects.toThrow(
      'Organization slug is required'
    )
  })

  it('throws when fieldKey is missing', async () => {
    await expect(scrubFieldFromShipments('test-org', '')).rejects.toThrow(
      'Field key is required'
    )
  })

  it('does not commit batch when no docs have the field', async () => {
    mockGetDocs.mockResolvedValueOnce({
      empty: false,
      size: 2,
      docs: [
        { id: 'doc1', data: () => ({ patientName: 'Alice' }) },
        { id: 'doc2', data: () => ({ patientName: 'Bob' }) },
      ],
    })

    const count = await scrubFieldFromShipments('test-org', 'dob')
    expect(count).toBe(0)
    expect(mockBatchCommit).not.toHaveBeenCalled()
  })
})

describe('SCRUBBABLE_FIELDS', () => {
  it('includes address, phone, dob, notes, redeliver', () => {
    expect(SCRUBBABLE_FIELDS).toEqual(['address', 'phone', 'dob', 'notes', 'redeliver'])
  })
})

describe('CORE_FIELDS', () => {
  it('includes patientName, trackingNumber, rxNumbers, date, status, carrier', () => {
    expect(CORE_FIELDS).toEqual(['patientName', 'trackingNumber', 'rxNumbers', 'date', 'status', 'carrier'])
  })
})
