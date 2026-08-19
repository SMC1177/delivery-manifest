// The shipment field registry is the single source of truth for every field the
// app can display. The operator's rule: all display fields are pulled from
// UNIVERSAL_FIELDS, and imported spreadsheet data is never overwritten by
// display configuration.
//
// UNIVERSAL_FIELDS used to live inside utils/excelImport.js, whose first line is
// `import * as XLSX from 'xlsx'`. Any UI component importing the field list from
// there would pull the whole spreadsheet parser into its bundle, making a render
// change depend on the import library loading. So the array moves into this
// dependency-free module and excelImport imports it back.
import { describe, it, expect } from 'vitest'
import { UNIVERSAL_FIELDS as REGISTRY } from '../constants/shipmentFields'
import { UNIVERSAL_FIELDS as VIA_IMPORTER } from '../utils/excelImport'

describe('shipment field registry', () => {
  it('exports every field with a usable key and label', () => {
    expect(Array.isArray(REGISTRY)).toBe(true)
    // 32 because c0ddad0b extended the list from 10 to cover all 33 export
    // columns, the five Ship To columns collapsing into one address entry.
    // 33 = the 32 IMPORTED fields above, plus one that is not imported at all:
    // createdAt, exposed as 'Date Added'. It is the system's own first-insert
    // stamp — already on every one of the 21,078 live rows and never rewritten —
    // so it is surfaced as a column rather than duplicated as a new field, and
    // nothing can map a spreadsheet column onto it because autoMapColumns builds
    // mappings from FUZZY_RULES, never from this registry.
    expect(REGISTRY).toHaveLength(33)
    for (const field of REGISTRY) {
      expect(typeof field.key).toBe('string')
      expect(field.key.length).toBeGreaterThan(0)
      expect(typeof field.label).toBe('string')
      expect(field.label.length).toBeGreaterThan(0)
    }
  })

  // THE ASSERTION THAT MATTERS. excelImport must READ this list, not keep a copy.
  // Four field lists in this codebase have already drifted out of agreement; a
  // copy here would make it five, and the next field added would be missed in one
  // of them without anything failing.
  it('is the same data excelImport exposes — a move, never a copy', () => {
    expect(VIA_IMPORTER).toEqual(REGISTRY)
    expect(VIA_IMPORTER).toHaveLength(REGISTRY.length)
    // Deep equality passes for a COPY. Identity is the only assertion that
    // proves excelImport re-exports the registry instead of holding a rival
    // literal that can silently drift from it.
    expect(VIA_IMPORTER).toBe(REGISTRY)
  })

  it('has no duplicate keys, which is what makes deriving other lists from it safe', () => {
    const keys = REGISTRY.map((field) => field.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // A botched move that silently drops entries must fail loudly rather than
  // quietly shrinking the set of fields the UI is able to address.
  it('still contains every key the existing UI depends on', () => {
    const keys = REGISTRY.map((field) => field.key)
    for (const required of [
      'patientName',
      'phone',
      'dateOfBirth',
      'address',
      'rxNumbers',
      'trackingNumber',
      'carrier',
      'date',
      'refillNumber',
      'notes',
    ]) {
      expect(keys).toContain(required)
    }
  })
})
