import { describe, it, expect } from 'vitest'
import {
  MIN_SEARCH_CHARS,
  buildSearchHaystack,
  matchesSearchQuery,
} from '../lib/shipmentSearch'

const shipment = (overrides = {}) => ({
  patientName: 'TRIANA REYES, MARIBEL',
  address: '2880 TRICOM STREET, BONNEAU, SC, 29431',
  trackingNumber: '1ZTRACK9',
  rxNumbers: ['6107113', '6108524'],
  ...overrides,
})

describe('buildSearchHaystack', () => {
  it('covers all four sources, lowercased', () => {
    const hay = buildSearchHaystack(shipment())
    expect(hay).toContain('triana reyes')
    expect(hay).toContain('tricom street')
    expect(hay).toContain('1ztrack9')
    expect(hay).toContain('6107113')
    expect(hay, 'every rx number must be searchable, not just the first').toContain('6108524')
    expect(hay).toBe(hay.toLowerCase())
  })

  it('is a function of the SHIPMENT ALONE — the property that lets it be built once per row', () => {
    // If this ever stops holding, caching the haystack across keystrokes
    // becomes incorrect and the DashboardPage wiring silently breaks.
    const s = shipment()
    expect(buildSearchHaystack(s)).toBe(buildSearchHaystack(s))
  })

  it('survives a missing shipment and a non-array rxNumbers', () => {
    expect(buildSearchHaystack(null)).toBe('')
    expect(buildSearchHaystack(shipment({ rxNumbers: '6107113' }))).not.toContain('6107113')
    expect(buildSearchHaystack(shipment({ patientName: undefined }))).toContain('1ztrack9')
  })
})

describe('matchesSearchQuery', () => {
  const hay = buildSearchHaystack(shipment())

  it('matches EVERYTHING below the threshold — a short query must not blank the table', () => {
    for (const q of ['', ' ', 'a', 'zz']) {
      expect(matchesSearchQuery(hay, q), `query ${JSON.stringify(q)} must hide nothing`).toBe(true)
      expect(matchesSearchQuery('completely unrelated', q)).toBe(true)
    }
    expect(MIN_SEARCH_CHARS).toBe(3)
  })

  it('is a case-insensitive substring match at or above the threshold', () => {
    expect(matchesSearchQuery(hay, 'TRI')).toBe(true)
    expect(matchesSearchQuery(hay, '  tri  ')).toBe(true)
    expect(matchesSearchQuery(hay, '6108524')).toBe(true)
    expect(matchesSearchQuery(hay, 'nobody')).toBe(false)
  })

  it('tolerates a missing haystack', () => {
    expect(matchesSearchQuery(undefined, 'tri')).toBe(false)
    expect(matchesSearchQuery(undefined, 'a')).toBe(true)
  })
})
