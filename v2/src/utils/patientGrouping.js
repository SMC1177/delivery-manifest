// Pure derivation helpers over persisted shipment docs (see ImportPreviewModal).
// These functions only READ and derive — they never write to Firestore and never
// mutate their inputs. Dates are ISO YYYY-MM-DD strings, so 'most recent' is the
// lexicographically greatest date string.

export function normalizePatientKey(name) {
  if (name == null) return ''
  return String(name).trim().toLowerCase()
}

// Lexicographic date string compare (ISO YYYY-MM-DD); shipments without a usable
// date sort last. Comparator for NEWEST-first ordering.
function byDateDesc(a, b) {
  return String(b.date || '').localeCompare(String(a.date || ''))
}

// Distinct non-blank string values, preserving first-seen order.
function distinctNonBlank(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (value == null || String(value).trim() === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

// Shipment with the lexicographically greatest date (first after newest-first sort).
function mostRecentShipment(shipments) {
  return [...shipments].sort(byDateDesc)[0]
}

// Composed prescriber address: '<FirstName> <LastName>, <Address1>, <City>, <State>'
// with empty parts skipped.
function composeMDPrescriber(shipment) {
  const name = [shipment.prescriberFirstName, shipment.prescriberLastName]
    .filter((p) => p != null && String(p).trim() !== '')
    .join(' ')
  const parts = [name, shipment.prescriberAddress1, shipment.prescriberCity, shipment.prescriberState]
    .filter((p) => p != null && String(p).trim() !== '')
  return parts.join(', ')
}

// Value for an address section's `default`: the most recent shipment's value,
// or null when that value is blank.
function latestValue(shipments, pick) {
  const latest = mostRecentShipment(shipments)
  if (!latest) return null
  const value = pick(latest)
  return value != null && String(value).trim() !== '' ? value : null
}

// { default, history } for one address section. Input is newest-first ordered, so
// distinctNonBlank preserves that order for the distinct value history.
function addressSection(shipments, pick) {
  return {
    default: latestValue(shipments, pick),
    history: distinctNonBlank(shipments.map((s) => pick(s))),
  }
}

export function groupShipmentsByPatient(list) {
  const byKey = new Map()
  for (const shipment of list) {
    const key = normalizePatientKey(shipment.patientName)
    if (!key) continue
    let group = byKey.get(key)
    if (!group) {
      group = { key, patientName: shipment.patientName, shipments: [] }
      byKey.set(key, group)
    }
    group.shipments.push(shipment)
  }
  const groups = [...byKey.values()]
  for (const group of groups) {
    // Newest-first so the group's patientName reflects the most recent case variant.
    group.shipments.sort(byDateDesc)
    group.patientName = group.shipments[0].patientName
  }
  groups.sort((a, b) => a.key.localeCompare(b.key))
  return groups
}

export function buildPatientRow(group) {
  const { shipments } = group
  const dates = shipments.map((s) => s.date || '').filter(Boolean)
  if (shipments.length === 0) {
    return {
      key: group.key,
      patientName: null,
      phone: null,
      dob: null,
      address: null,
      shipmentCount: 0,
      firstShipped: null,
      lastShipped: null,
    }
  }
  const latest = mostRecentShipment(shipments)
  return {
    key: group.key,
    patientName: latest.patientName,
    phone: latest.phone ?? null,
    dob: latest.dob ?? null,
    address: latest.address ?? null,
    shipmentCount: shipments.length,
    firstShipped: dates.length ? dates.reduce((min, d) => (d < min ? d : min)) : null,
    lastShipped: dates.length ? dates.reduce((max, d) => (d > max ? d : max)) : null,
  }
}

export function buildProfileSections(group) {
  const { shipments } = group
  const emptyAddresses = {
    Facility: { default: null, history: [] },
    Home: { default: null, history: [] },
    MD: { default: null, history: [] },
  }
  if (shipments.length === 0) {
    return {
      prescriptions: [],
      addresses: emptyAddresses,
      insurance: null,
      facilityNames: [],
      notes: [],
    }
  }

  const newestFirst = [...shipments].sort(byDateDesc)
  const latest = newestFirst[0]

  const prescriptions = newestFirst.map((s) => ({
    date: s.date,
    rxNumbers: s.rxNumbers ?? [],
  }))

  const addresses = {
    Facility: addressSection(newestFirst, (s) => s.facilityName),
    Home: addressSection(newestFirst, (s) => s.address),
    MD: addressSection(newestFirst, composeMDPrescriber),
  }

  const insurance = {
    awpCost: latest.awpCost,
    copayAmount: latest.copayAmount,
    ndc: latest.ndc,
    quantityDispensed: latest.quantityDispensed,
    daysSupply: latest.daysSupply,
  }

  return {
    prescriptions,
    addresses,
    insurance,
    facilityNames: distinctNonBlank(newestFirst.map((s) => s.facilityName)),
    notes: distinctNonBlank(newestFirst.map((s) => s.notes)),
  }
}
