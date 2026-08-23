import { describe, it, expect, vi, beforeEach } from 'vitest'
import { doc, setDoc } from 'firebase/firestore'
import { collectFacilityNames, upsertFacilities } from '../utils/facilities'

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  setDoc: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
})

describe('collectFacilityNames', () => {
  it('returns distinct, trimmed facility names (order-insensitive)', () => {
    const rows = [
      { facilityName: ' TRI-OOC ' },
      { facilityName: 'TRI-OOC' },
      { facilityName: '  TRI-HILT  ' },
    ]

    const result = collectFacilityNames(rows)

    expect([...result].sort()).toEqual(['TRI-HILT', 'TRI-OOC'])
  })

  it('treats " TRI-MIA " and "TRI-MIA" as one facility', () => {
    const result = collectFacilityNames([
      { facilityName: ' TRI-MIA ' },
      { facilityName: 'TRI-MIA' },
    ])

    expect([...result].sort()).toEqual(['TRI-MIA'])
  })

  it('excludes undefined, blank, and non-string facility names', () => {
    const rows = [
      { facilityName: undefined },
      { facilityName: '' },
      { facilityName: '   ' },
      { facilityName: null },
      { facilityName: 42 },
      {},
    ]

    expect(collectFacilityNames(rows)).toEqual([])
  })
})

describe('upsertFacilities', () => {
  it('writes one doc per name at organizations/{slug}/facilities with { merge: true }', async () => {
    setDoc.mockResolvedValue(undefined)
    const db = {}
    const slug = 'acme'

    const result = await upsertFacilities(db, slug, ['TRI-OOC', 'TRI-HILT'])

    expect(doc).toHaveBeenCalledTimes(2)
    expect(doc).toHaveBeenCalledWith(
      db,
      'organizations',
      slug,
      'facilities',
      expect.any(String)
    )
    expect(setDoc).toHaveBeenCalledTimes(2)
    const writtenNames = setDoc.mock.calls
      .map(([, payload]) => payload.name)
      .sort()
    expect(writtenNames).toEqual(['TRI-HILT', 'TRI-OOC'])
    for (const [, payload, options] of setDoc.mock.calls) {
      expect(payload).toMatchObject({ name: expect.any(String) })
      expect(options).toEqual({ merge: true })
    }
    expect(result).toEqual({ failed: [] })
  })

  it('never throws: one rejected write yields { failed: [name] }, remaining names still written', async () => {
    setDoc
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)

    await expect(
      upsertFacilities({}, 'acme', ['TRI-OOC', 'TRI-HILT'])
    ).resolves.toEqual({ failed: ['TRI-OOC'] })

    expect(setDoc).toHaveBeenCalledTimes(2)
  })

  it('resolves { failed: [] } for an empty names list without touching the db', async () => {
    await expect(upsertFacilities({}, 'acme', [])).resolves.toEqual({
      failed: [],
    })

    expect(doc).not.toHaveBeenCalled()
    expect(setDoc).not.toHaveBeenCalled()
  })
})
