// Canonical shipment field registry — the single source of truth for every
// field the app can store or display. Moved out of utils/excelImport.js so UI
// code can import the field list without pulling in the xlsx parser: every view
// (settings toggles, shipment table columns, patient profile) derives from this
// one list.
export const UNIVERSAL_FIELDS = [
  { key: 'patientName', label: 'Patient Name', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'dateOfBirth', label: 'Date of Birth', required: false },
  { key: 'rxNumbers', label: 'RX Numbers', required: false },
  { key: 'trackingNumber', label: 'Tracking #', required: false },
  { key: 'address', label: 'Address', required: false, isAddress: true },
  { key: 'carrier', label: 'Carrier', required: false },
  { key: 'date', label: 'Date', required: false },
  { key: 'refillNumber', label: 'Refill #', required: false },
  { key: 'notes', label: 'Notes', required: false },

  // --- Full pharmacy export (33 columns). Every entry below is optional:
  // a pharmacy maps only the columns its own export actually contains. ---
  { key: 'facilityName', label: 'Facility Name', required: false },
  { key: 'dateWritten', label: 'Date Written', required: false },
  { key: 'dateFilled', label: 'Date Filled', required: false },
  { key: 'effectiveDate', label: 'Effective Date', required: false },
  { key: 'refillDate', label: 'Refill Date', required: false },
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
]
