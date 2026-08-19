import { describe, it, expect } from 'vitest'
import {
  UNIVERSAL_FIELDS,
  CORE_STORAGE_KEYS,
  SETTABLE_FIELDS,
  FIELD_GROUP_ORDER,
} from '../constants/shipmentFields'

/**
 * The registry is the single source of truth for every field the app can store
 * or display. These tests pin the metadata the display layer needs, so that the
 * shipment table can be DERIVED from this list rather than kept in step with it
 * by hand.
 *
 * Three hand-maintained lists disagree at HEAD: this registry has 33 entries,
 * SettingsPage offers 6 toggles, and ShipmentTable declares 11 columns. The
 * point of the metadata below is that the last two stop being lists at all.
 */
describe('shipment field registry — display metadata', () => {
  const displayable = () => UNIVERSAL_FIELDS.filter((f) => f.displayable)

  it('still holds every one of its 32 entries', () => {
    // Guards the rewrite: deriving the UI from this list is only safe if the
    // list itself is complete. A dropped entry would silently remove a column.
    //
    // 32 ENTRIES, 33 SPREADSHEET COLUMNS — the two numbers are not the same and
    // the difference is deliberate. `address` carries isAddress and absorbs
    // several columns (street, city, state, zip) into one field, so the 33
    // Trident columns land in 32 registry entries. Snippet a1-universal-fields
    // recorded it: 'from 10 to the full set covering all 33 Trident columns,
    // adding 22 new keys' — and 10 + 22 = 32.
    // 33 since createdAt joined as 'Date Added' — the system's own first-insert
    // stamp, surfaced as a column rather than duplicated as a new field. 32 was
    // the count of IMPORTED fields; this one is the first that is not imported.
    expect(UNIVERSAL_FIELDS).toHaveLength(33)
  })

  it('every displayable field declares the key Firestore actually stores it under', () => {
    // Without this guard the loop below iterates an empty array and the test
    // reports green while asserting nothing at all.
    expect(displayable().length, 'no field is marked displayable, so this test would prove nothing').toBeGreaterThan(0)
    for (const f of displayable()) {
      expect(
        typeof f.storageKey,
        `${f.key} is displayable but has no storageKey, so a derived column would read undefined`,
      ).toBe('string')
      expect(f.storageKey.length).toBeGreaterThan(0)
    }
  })

  it('dateOfBirth stores as dob — the one place the registry key and the stored key diverge', () => {
    // ImportPreviewModal persists the field as `dob`, and the table's hand-written
    // COLUMN_DEFS already used `dob`. A derived column keyed on `dateOfBirth`
    // would render undefined for every row.
    const dob = UNIVERSAL_FIELDS.find((f) => f.key === 'dateOfBirth')
    expect(dob).toBeDefined()
    expect(dob.storageKey).toBe('dob')
  })

  it('trackingNumber stores as trackingNumber — the table key `tracking` is the wrong one', () => {
    // COLUMN_DEFS declares `tracking`, but both this registry and Firestore use
    // `trackingNumber`. A derived loop that excluded by exact key match against
    // the old list would emit a SECOND Tracking column.
    const tracking = UNIVERSAL_FIELDS.find((f) => f.key === 'trackingNumber')
    expect(tracking).toBeDefined()
    expect(tracking.storageKey).toBe('trackingNumber')
  })

  it('no two fields share a storage key, so a derived column list cannot duplicate', () => {
    expect(displayable().length, 'an empty set trivially has no duplicates, which proves nothing').toBeGreaterThan(0)
    const keys = displayable().map((f) => f.storageKey)
    expect(
      new Set(keys).size,
      `duplicate storage keys would render the same column twice: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`,
    ).toBe(keys.length)
  })

  it('fields that do not render as plain text declare how they do render', () => {
    // rxNumbers is an array, the date fields need formatting, and address is
    // concatenated from several columns. Everything else is plain text, so the
    // render type is only required where it is not.
    const needsRenderType = ['rxNumbers', 'date', 'dateWritten', 'dateFilled', 'effectiveDate', 'refillDate', 'address']
    for (const key of needsRenderType) {
      const f = UNIVERSAL_FIELDS.find((x) => x.key === key)
      expect(f, `${key} is missing from the registry`).toBeDefined()
      expect(
        typeof f.render,
        `${key} does not render as plain text, so it must say how it renders`,
      ).toBe('string')
    }
  })

  // ---- the derived lists the table and the Settings card both consume ----
  // These live here, not in either consumer, because the exclusion is derived
  // from properties this file owns. Two derivations in two files is how a third
  // one springs up later.

  // The six toggles SettingsPage has always hand-written. A registry field that
  // reused one of these keys would render two toggles for one field.
  const APP_OWNED_TOGGLES = ['address', 'phone', 'dob', 'notes', 'carrier', 'redeliver']

  it('the registry owns the set of storage keys the hand-written columns already render', () => {
    expect(CORE_STORAGE_KEYS).toBeInstanceOf(Set)
    // Eleven: the nine registry-backed columns the table hand-writes, plus
    // 'status' and 'redeliver', which are app-owned and have no registry entry.
    // Dropping any one of these would make that field settable a second time —
    // a duplicate column beside the hand-written one, and for address, phone,
    // dob, notes, carrier and redeliver a second toggle beside SettingsPage's.
    expect([...CORE_STORAGE_KEYS].sort()).toEqual(
      [
        'address', 'carrier', 'date', 'dob', 'notes', 'patientName',
        'phone', 'redeliver', 'rxNumbers', 'status', 'trackingNumber',
      ].sort(),
    )
  })

  it('SETTABLE_FIELDS is every displayable field the core columns do not already cover', () => {
    expect(Array.isArray(SETTABLE_FIELDS)).toBe(true)
    expect(SETTABLE_FIELDS.length, 'an empty list would satisfy every other case here vacuously').toBeGreaterThan(0)

    const keys = SETTABLE_FIELDS.map((f) => f.key)

    // Absent: the core columns own these storage keys, and a second column would
    // duplicate Tracking and render DOB from a field that is not there.
    expect(keys).not.toContain('dateOfBirth')
    expect(keys).not.toContain('trackingNumber')
    expect(keys).not.toContain('patientName')
    expect(keys).not.toContain('notes')

    // Present: naming both directions is what stops this passing by being empty
    // on one side or everything on the other.
    expect(keys).toContain('drugDescription')
    expect(keys).toContain('refillNumber')
    expect(keys).toContain('ndc')

    // 32 registry entries less the 9 whose storage keys the core columns own.
    // 24 = 33 registry entries less the 9 whose storage keys the core columns
    // already own. createdAt is not among those 9, so it became settable the
    // moment it entered the registry — no separate wiring was needed.
    expect(SETTABLE_FIELDS).toHaveLength(24)
  })

  it('no settable field collides with the six toggles SettingsPage already hand-writes', () => {
    expect(SETTABLE_FIELDS.length).toBeGreaterThan(0)
    for (const f of SETTABLE_FIELDS) {
      expect(
        APP_OWNED_TOGGLES,
        `${f.key} would render a second toggle for a field that already has one`,
      ).not.toContain(f.toggleKey)
    }
  })

  it('every field declares a group, and no group is left empty', () => {
    expect(Array.isArray(FIELD_GROUP_ORDER)).toBe(true)
    expect(FIELD_GROUP_ORDER.length).toBeGreaterThan(0)
    expect(new Set(FIELD_GROUP_ORDER).size, 'a repeated group would render its header twice').toBe(FIELD_GROUP_ORDER.length)

    for (const f of UNIVERSAL_FIELDS) {
      expect(FIELD_GROUP_ORDER, `${f.key} has no group, so it would render under no header`).toContain(f.group)
    }

    // The other direction: a group nobody belongs to renders an empty section.
    const used = new Set(UNIVERSAL_FIELDS.map((f) => f.group))
    for (const g of FIELD_GROUP_ORDER) {
      expect(used.has(g), `the group "${g}" has no fields in it`).toBe(true)
    }
  })

  it('every field still carries the key and label it had before', () => {
    // The metadata is additive. If this fails, the rewrite changed what a field
    // IS rather than what the UI knows about it.
    for (const f of UNIVERSAL_FIELDS) {
      expect(typeof f.key).toBe('string')
      expect(typeof f.label).toBe('string')
      expect(f.key.length).toBeGreaterThan(0)
      expect(f.label.length).toBeGreaterThan(0)
    }
  })
})
