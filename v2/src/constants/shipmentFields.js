// Canonical shipment field registry — the single source of truth for every
// field the app can store or display. Moved out of utils/excelImport.js so UI
// code can import the field list without pulling in the xlsx parser: every view
// (settings toggles, shipment table columns, patient profile) derives from this
// one list.
// The order the Settings card renders its sections in. Thirty-two toggles in one
// flat run is a wall nobody can find 'Drug GPI' in, so they are grouped — and the
// grouping lives here, with the fields, rather than as a second list inside the
// page that renders it.
export const FIELD_GROUP_ORDER = ['Patient', 'Prescription', 'Dates', 'Cost', 'Prescriber', 'Delivery']

// Which group each field belongs to. Folded into every entry by the defaults pass
// at the bottom of this file, so the list of fields below stays the only list.
const FIELD_GROUPS = {
  patientName: 'Patient',
  phone: 'Patient',
  dateOfBirth: 'Patient',
  address: 'Patient',

  rxNumbers: 'Prescription',
  refillNumber: 'Prescription',
  drugDescription: 'Prescription',
  drugGpi: 'Prescription',
  ndc: 'Prescription',
  quantityDispensed: 'Prescription',
  daysSupply: 'Prescription',
  prescriptionLength: 'Prescription',
  refillsAuthorized: 'Prescription',
  refillsRemaining: 'Prescription',
  orderDescription: 'Prescription',

  date: 'Dates',
  dateWritten: 'Dates',
  dateFilled: 'Dates',
  effectiveDate: 'Dates',
  refillDate: 'Dates',

  awpCost: 'Cost',
  copayAmount: 'Cost',

  prescriberFirstName: 'Prescriber',
  prescriberLastName: 'Prescriber',
  prescriberAddress1: 'Prescriber',
  prescriberCity: 'Prescriber',
  prescriberState: 'Prescriber',

  trackingNumber: 'Delivery',
  carrier: 'Delivery',
  deliveryMethod: 'Delivery',
  facilityName: 'Delivery',
  notes: 'Delivery',
}

export const UNIVERSAL_FIELDS = [
  { key: 'patientName', label: 'Patient Name', required: true },
  { key: 'phone', label: 'Phone', required: false },
  // The one field whose stored name differs from its registry key: the import
  // preview persists it as `dob`, so a column keyed on `dateOfBirth` would read
  // undefined for every row.
  { key: 'dateOfBirth', label: 'Date of Birth', required: false, storageKey: 'dob' },
  { key: 'rxNumbers', label: 'RX Numbers', required: false, render: 'array' },
  { key: 'trackingNumber', label: 'Tracking #', required: false },
  { key: 'address', label: 'Address', required: false, isAddress: true, render: 'address' },
  { key: 'carrier', label: 'Carrier', required: false },
  { key: 'date', label: 'Date', required: false, render: 'date' },
  { key: 'refillNumber', label: 'Refill #', required: false },
  { key: 'notes', label: 'Notes', required: false },

  // --- Full pharmacy export (33 columns). Every entry below is optional:
  // a pharmacy maps only the columns its own export actually contains. ---
  { key: 'facilityName', label: 'Facility Name', required: false },
  { key: 'dateWritten', label: 'Date Written', required: false, render: 'date' },
  { key: 'dateFilled', label: 'Date Filled', required: false, render: 'date' },
  { key: 'effectiveDate', label: 'Effective Date', required: false, render: 'date' },
  { key: 'refillDate', label: 'Refill Date', required: false, render: 'date' },
  { key: 'drugDescription', label: 'Dispensed Drug Description', required: false },
  { key: 'drugGpi', label: 'Drug GPI', required: false },
  { key: 'ndc', label: 'NDC', required: false },
  { key: 'quantityDispensed', label: 'Quantity Dispensed', required: false },
  { key: 'daysSupply', label: 'Days Supply', required: false },
  { key: 'prescriptionLength', label: 'Prescription Length', required: false },
  { key: 'refillsAuthorized', label: 'Refills Authorized', required: false },
  { key: 'refillsRemaining', label: 'Refills Remaining', required: false },
  { key: 'awpCost', label: 'AWP Cost', required: false },
  { key: 'copayAmount', label: 'Copay Amount', required: false },
  { key: 'deliveryMethod', label: 'Delivery Method Description', required: false },
  { key: 'orderDescription', label: 'Order Description', required: false },
  { key: 'prescriberFirstName', label: 'Prescriber First Name', required: false },
  { key: 'prescriberLastName', label: 'Prescriber Last Name', required: false },
  { key: 'prescriberAddress1', label: 'Prescriber Address1', required: false },
  { key: 'prescriberCity', label: 'Prescriber City', required: false },
  { key: 'prescriberState', label: 'Prescriber State', required: false },
  // Defaults applied to every entry above, so the display layer needs no second
  // list: storageKey falls back to the field's own key, and every imported field
  // is offerable as a column and as a settings toggle.  An entry that declares
  // either value for itself wins, because its own properties spread last.
].map((f) => ({ displayable: true, storageKey: f.key, group: FIELD_GROUPS[f.key], ...f }))

// The storage keys the shipment table's hand-written columns already render.
// Eleven, not nine: 'status' and 'redeliver' are app-owned and have no entry in
// the registry at all. Keyed on where the value LIVES rather than on what the
// column is called — the table says 'tracking' where this file says
// 'trackingNumber', and 'dob' where this file says 'dateOfBirth'.
//
// This lives here because the exclusion is derived from properties this file
// owns. A consumer deriving its own copy is how two lists become three.
export const CORE_STORAGE_KEYS = new Set([
  'date', 'patientName', 'address', 'phone', 'dob', 'rxNumbers',
  'trackingNumber', 'carrier', 'status', 'redeliver', 'notes',
])

// Every imported field the hand-written columns do NOT already show. The table
// renders these as plain columns and the Settings card renders them as toggles;
// both key on toggleKey, which is the STORAGE key. If the two sides ever keyed
// differently, a toggle would read ON above a column that stayed hidden.
export const SETTABLE_FIELDS = UNIVERSAL_FIELDS
  .filter((f) => f.displayable && !CORE_STORAGE_KEYS.has(f.storageKey))
  .map((f) => ({ ...f, toggleKey: f.storageKey }))
