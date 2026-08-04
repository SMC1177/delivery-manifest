import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// Adversarial breaker for the refill-number-aware Rx duplicate check in
// addShipment (v2/src/hooks/useShipments.js). The dedup previously matched on
// patientName + rxNumbers only (date explicitly ignored), so a pharmacy
// refilling the same prescription was REFUSED as a duplicate. It now also
// requires refillNumber to match, compared as a trimmed lowercased string.
// All assertions target ONLY the object addShipment returns
// ({ skipped, merged, id, message }) plus the mock call records that prove
// whether a document was really created/merged.

// Mock firebase/firestore with all functions used by the hook (same shape as
// the sibling useShipments.test.jsx)
vi.mock('firebase/firestore', () => {
  const getDocs = vi.fn()
  const collection = vi.fn()
  const query = vi.fn()
  const where = vi.fn()
  const doc = vi.fn()
  const updateDoc = vi.fn()
  const deleteDoc = vi.fn()
  const addDoc = vi.fn()
  const serverTimestamp = vi.fn(() => new Date())
  const arrayUnion = vi.fn((...args) => args)
  return { getDocs, collection, query, where, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, arrayUnion }
})

vi.mock('../lib/firebase', () => ({
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, orgSlug: 'acme' }),
}))

import { useShipments } from '../hooks/useShipments'
import { getDocs, addDoc, updateDoc, arrayUnion } from 'firebase/firestore'

describe('useShipments.addShipment — refill-number duplicate detection (s5-refill-breaker)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocs.mockReset()
    getDocs.mockResolvedValue({ docs: [] })
    addDoc.mockReset()
    addDoc.mockResolvedValue({ id: 'created-1' })
    updateDoc.mockReset()
    updateDoc.mockResolvedValue()
  })

  // Mount the hook and let its initial fetch settle, then forget the mount
  // call so per-test mockResolvedValueOnce chains only feed addShipment.
  async function mountHook() {
    const utils = renderHook(() => useShipments('acme'))
    await waitFor(() => expect(utils.result.current.loading).toBe(false))
    getDocs.mockClear()
    return utils
  }

  it('1. THE DEFECT: a refill with a DIFFERENT refillNumber is accepted and creates a document', async () => {
    const existing = {
      id: 'existing-1',
      data: () => ({ patientName: 'Alice Smith', rxNumbers: ['13245'], refillNumber: '1', date: '2026-06-01' }),
    }
    const { result } = await mountHook()

    // patientName dedup query returns the existing fill (refill "1") ...
    getDocs.mockResolvedValueOnce({ docs: [existing] })
    // ... and the date-overlap query finds nothing on the new date.
    getDocs.mockResolvedValueOnce({ docs: [] })

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Alice Smith',
        rxNumbers: ['13245'],
        refillNumber: '2',
        date: '2026-07-01',
      })
    })

    // Refill "2" must NOT be treated as a duplicate of refill "1".
    expect(res.skipped).toBe(false)
    expect(res.merged).toBe(false)
    expect(res.id).toBe('created-1')
    expect(addDoc).toHaveBeenCalledTimes(1)
    // The new record keeps its own refill number. (The first addDoc argument
    // is the mocked collection() return, so assert on the payload argument.)
    expect(addDoc.mock.calls[0][1]).toMatchObject({ refillNumber: '2' })
  })

  it('2. same patient, same Rx, SAME refill number is still skipped', async () => {
    const existing = {
      id: 'existing-1',
      data: () => ({ patientName: 'Alice Smith', rxNumbers: ['13245'], refillNumber: '1', date: '2026-06-01' }),
    }
    const { result } = await mountHook()

    getDocs.mockResolvedValueOnce({ docs: [existing] })

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Alice Smith',
        rxNumbers: ['13245'],
        refillNumber: '1',
        date: '2026-07-01',
      })
    })

    expect(res.skipped).toBe(true)
    expect(res.merged).toBe(false)
    expect(res.id).toBe('existing-1')
    expect(res.message).toContain('Duplicate skipped')
    expect(addDoc).not.toHaveBeenCalled()
  })

  it('3. a DIFFERENT patient with the same Rx and same refill is unaffected by this rule', async () => {
    // The DB holds Alice's record with Rx ["13245"] refill "1", but the dedup
    // query is scoped to the NEW shipment's patient name (Bob Jones), so
    // Alice's record is never returned — the rule keys on patient and must
    // not block a different patient with identical Rx + refill.
    const { result } = await mountHook()

    getDocs.mockResolvedValueOnce({ docs: [] }) // patientQuery for Bob's name finds nothing
    getDocs.mockResolvedValueOnce({ docs: [] }) // date-overlap query

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Bob Jones',
        rxNumbers: ['13245'],
        refillNumber: '1',
        date: '2026-07-01',
      })
    })

    expect(res.skipped).toBe(false)
    expect(res.merged).toBe(false)
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'undefined', refill: undefined },
    { label: 'null', refill: null },
    { label: 'empty string', refill: '' },
  ])('4. both records lacking a refill number ($label) still dedup — skipped: true', async ({ refill }) => {
    // Existing record has NO refillNumber at all (pharmacy that does not record them).
    const existing = {
      id: 'existing-1',
      data: () => ({ patientName: 'Alice Smith', rxNumbers: ['13245'], date: '2026-06-01' }),
    }
    const { result } = await mountHook()

    getDocs.mockResolvedValueOnce({ docs: [existing] })

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Alice Smith',
        rxNumbers: ['13245'],
        refillNumber: refill,
        date: '2026-07-01',
      })
    })

    // A missing refill must NOT mean "never a duplicate".
    expect(res.skipped).toBe(true)
    expect(res.merged).toBe(false)
    expect(addDoc).not.toHaveBeenCalled()
  })

  it('5. EDGE: existing refillNumber 0 (numeric zero) vs incoming NO refill number are DIFFERENT fills', async () => {
    // Numeric 0 is an original fill, distinct from an incoming record that
    // carries no refill number at all. The implementation normalises with
    // String(x || '') which turns 0 into '' — if that makes this case collide,
    // this test FAILS and that defect must be reported, not papered over.
    const existing = {
      id: 'existing-1',
      data: () => ({ patientName: 'Alice Smith', rxNumbers: ['13245'], refillNumber: 0, date: '2026-06-01' }),
    }
    const { result } = await mountHook()

    getDocs.mockResolvedValueOnce({ docs: [existing] })
    getDocs.mockResolvedValueOnce({ docs: [] })

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Alice Smith',
        rxNumbers: ['13245'],
        date: '2026-07-01',
      })
    })

    expect(res.skipped).toBe(false)
    expect(res.merged).toBe(false)
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('6. REGRESSION GUARD: tracking-number layer still merges new Rx numbers via arrayUnion and returns merged: true', async () => {
    const existing = {
      id: 'existing-1',
      data: () => ({ patientName: 'Bob Jones', rxNumbers: ['13245'], trackingNumber: 'TN123', date: '2026-06-01' }),
    }
    const { result } = await mountHook()

    getDocs.mockResolvedValueOnce({ docs: [existing] }) // tracking-number query

    let res
    await act(async () => {
      res = await result.current.addShipment({
        patientName: 'Bob Jones',
        rxNumbers: ['13245', '67890'],
        trackingNumber: 'TN123',
        date: '2026-07-01',
      })
    })

    expect(res.merged).toBe(true)
    expect(res.skipped).toBe(false)
    expect(res.id).toBe('existing-1')
    expect(updateDoc).toHaveBeenCalledTimes(1)
    // The new Rx number is merged into the existing record via arrayUnion.
    expect(arrayUnion).toHaveBeenCalledWith('67890')
    // (The first updateDoc argument is the mocked doc() return, so assert on
    // the payload argument directly.)
    expect(updateDoc.mock.calls[0][1]).toMatchObject({ rxNumbers: ['67890'] })
    expect(addDoc).not.toHaveBeenCalled()
  })
})
