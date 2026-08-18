// RED spec for v2/src/components/PatientProfile.jsx — acceptance contract.
// Built on the patientGrouping contract: buildPatientRow -> { key, patientName,
// phone, dob, address, shipmentCount, firstShipped, lastShipped };
// buildProfileSections -> { prescriptions, addresses: { Facility, Home, MD },
// insurance, facilityNames, notes }. PatientProfile renders the identity header
// + tabs and is a PURE VIEW (never writes; Messaging & Consent reads smsContacts
// via useSmsContact).
//
// ADVERSARIAL CONTRACT: the Prescriptions tab MUST show one row PER SHIPMENT
// with that shipment's OWN drugDescription/status. Two failure modes are pinned:
//   (1) same-date shipments (two Rx dispensed the same day) must not collapse —
//       rows keyed by DATE are wrong;
//   (2) same-rx refills (rxNumbers repeat across refill shipments, cf.
//       refillNumber/refillsRemaining) must not collapse — rows keyed by RX are
//       wrong. The unit of display is the shipment doc itself, newest-first.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PatientProfile from '../components/PatientProfile'

vi.mock('../hooks/useSmsContact', () => ({
  useSmsContact: () => ({
    contact: { language: 'es', optIn: true },
    loading: false,
    derivedState: 'opted_in',
    normalizedPhone: '+15550100',
  }),
}))

const PATIENT = {
  key: 'jane smith',
  patientName: 'jane SMITH',
  phone: '+1-555-0100',
  dob: '1980-01-01',
  address: '200 Maple Blvd',
  shipmentCount: 4,
  firstShipped: '2025-03-10',
  lastShipped: '2025-06-15',
}

// Four shipments exercising both adversarial cases:
//  - s2 + s2b SHARE date 2025-05-01 (different rx) -> date-collapse case
//  - s1 + s3 SHARE rx RX-300 (refill pattern) -> rx-collapse case
const SHIPMENTS = [
  { id: 's1', patientName: 'jane smith', date: '2025-03-10', rxNumbers: ['RX-300'], drugDescription: 'Metformin 500mg', refillNumber: '0', status: 'pending', trackingNumber: '', facilityName: 'Dr. Chen Office', awpCost: '100.00', copayAmount: '10.00', ndc: 'N1', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Bob', prescriberLastName: 'Zhu', prescriberAddress1: '2 Care Ln', prescriberCity: 'Dallas', prescriberState: 'TX', notes: 'Call before delivery' },
  { id: 's2', patientName: 'jane smith', date: '2025-05-01', rxNumbers: ['RX-200'], drugDescription: 'Lisinopril 10mg', refillNumber: '1', status: 'delivered', trackingNumber: '', facilityName: 'Dr. Chen Office', awpCost: '250.00', copayAmount: '25.00', ndc: 'N2', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Bob', prescriberLastName: 'Zhu', prescriberAddress1: '2 Care Ln', prescriberCity: 'Dallas', prescriberState: 'TX', notes: '' },
  { id: 's2b', patientName: 'jane smith', date: '2025-05-01', rxNumbers: ['RX-201'], drugDescription: 'Atorvastatin 20mg', refillNumber: '1', status: 'shipped', trackingNumber: '', facilityName: 'Dr. Chen Office', awpCost: '260.00', copayAmount: '26.00', ndc: 'N2B', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Bob', prescriberLastName: 'Zhu', prescriberAddress1: '2 Care Ln', prescriberCity: 'Dallas', prescriberState: 'TX', notes: '' },
  { id: 's3', patientName: 'jane SMITH', date: '2025-06-15', rxNumbers: ['RX-300'], drugDescription: 'Atorvastatin 40mg', refillNumber: '1', status: 'delivered', trackingNumber: '1Z999AA1', facilityName: 'Northside Pharmacy', awpCost: '300.00', copayAmount: '30.00', ndc: 'N3', quantityDispensed: '90', daysSupply: '30', prescriberFirstName: 'Ann', prescriberLastName: 'Lee', prescriberAddress1: '1 Med Dr', prescriberCity: 'Austin', prescriberState: 'TX', notes: '' },
]

const SECTIONS = {
  prescriptions: [
    { date: '2025-06-15', rxNumbers: ['RX-300'] },
    { date: '2025-05-01', rxNumbers: ['RX-200'] },
    { date: '2025-05-01', rxNumbers: ['RX-201'] },
    { date: '2025-03-10', rxNumbers: ['RX-300'] },
  ],
  addresses: {
    Facility: { default: 'Northside Pharmacy', history: ['Northside Pharmacy', 'Dr. Chen Office'] },
    Home: { default: '200 Maple Blvd', history: ['200 Maple Blvd', '55 Oak Ave'] },
    MD: { default: 'Ann Lee, 1 Med Dr, Austin, TX', history: ['Ann Lee, 1 Med Dr, Austin, TX', 'Bob Zhu, 2 Care Ln, Dallas, TX'] },
  },
  insurance: { awpCost: '300.00', copayAmount: '30.00', ndc: 'N3', quantityDispensed: '90', daysSupply: '30' },
  facilityNames: ['Northside Pharmacy', 'Dr. Chen Office'],
  notes: ['Call before delivery'],
}

vi.mock('../utils/patientGrouping', () => ({
  buildProfileSections: () => SECTIONS,
}))

function renderProfile() {
  return render(<PatientProfile patient={PATIENT} shipments={SHIPMENTS} slug="woodlandsrx" />)
}

describe('PatientProfile', () => {
  it('renders the identity header', () => {
    renderProfile()
    expect(screen.getByRole('heading', { name: 'jane SMITH' })).toBeInTheDocument()
    expect(screen.getByText('+1-555-0100')).toBeInTheDocument()
    expect(screen.getByText('1980-01-01')).toBeInTheDocument()
    expect(screen.getByText('200 Maple Blvd')).toBeInTheDocument()
  })

  it('renders the tab bar with all six tabs', () => {
    renderProfile()
    for (const label of ['Prescriptions & Shipments', 'Addresses', 'Insurance', 'Facility', 'Messaging & Consent', 'Notes']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('defaults to the Prescriptions tab listing shipment rows', () => {
    renderProfile()
    expect(screen.getByText('Metformin 500mg')).toBeInTheDocument()
    expect(screen.getByText('Lisinopril 10mg')).toBeInTheDocument()
    expect(screen.getByText('Atorvastatin 20mg')).toBeInTheDocument()
    expect(screen.getByText('Atorvastatin 40mg')).toBeInTheDocument()
  })

  it('shows one row per same-day shipment with its OWN drug/status (no date collapse)', () => {
    renderProfile()
    // Both same-date shipments must render with their own labels
    expect(screen.getByText('Lisinopril 10mg')).toBeInTheDocument()
    expect(screen.getByText('Atorvastatin 20mg')).toBeInTheDocument()
    expect(screen.getAllByText(/RX-20[01]/).length).toBe(2)
    const lisinoprilRow = screen.getByText('Lisinopril 10mg').closest('li')
    expect(lisinoprilRow).toHaveTextContent(/Status: delivered/i)
    const atorvastatinRow = screen.getByText('Atorvastatin 20mg').closest('li')
    expect(atorvastatinRow).toHaveTextContent(/Status: shipped/i)
  })

  it('shows one row per refill shipment sharing an rx number (no rx collapse)', () => {
    renderProfile()
    // RX-300 appears in TWO shipments (Metformin 500mg pending + Atorvastatin 40mg delivered)
    expect(screen.getAllByText(/RX-300/).length).toBe(2)
    expect(screen.getByText('Metformin 500mg')).toBeInTheDocument()
    expect(screen.getByText('Atorvastatin 40mg')).toBeInTheDocument()
    const metforminRow = screen.getByText('Metformin 500mg').closest('li')
    expect(metforminRow).toHaveTextContent(/Status: pending/i)
    const atorvastatin40Row = screen.getByText('Atorvastatin 40mg').closest('li')
    expect(atorvastatin40Row).toHaveTextContent(/Status: delivered/i)
  })

  it('shows the Addresses tab with Facility/Home/MD sections', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: 'Addresses' }))
    expect(screen.getAllByText('Facility').length).toBeGreaterThan(0)
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('MD / Prescriber')).toBeInTheDocument()
    expect(screen.getAllByText('200 Maple Blvd').length).toBeGreaterThan(0)
    expect(screen.getByText('Ann Lee, 1 Med Dr, Austin, TX')).toBeInTheDocument()
  })

  it('shows the Insurance stub tab', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: 'Insurance' }))
    expect(screen.getByText('300.00')).toBeInTheDocument()
    expect(screen.getByText('30.00')).toBeInTheDocument()
  })

  it('shows the Facility tab', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: 'Facility' }))
    expect(screen.getByText('Northside Pharmacy')).toBeInTheDocument()
  })

  it('shows Messaging & Consent from the sms contact', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: 'Messaging & Consent' }))
    expect(screen.getByText(/Spanish/i)).toBeInTheDocument()
    expect(screen.getByText(/Opted in/i)).toBeInTheDocument()
  })

  it('shows the Notes tab', () => {
    renderProfile()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByText('Call before delivery')).toBeInTheDocument()
  })
})

// Tracking numbers on the patient profile. Fixtures mirror production: PatientPage
// passes whole shipment docs through, and trackingNumber + carrier are present on
// 200/200 sampled documents at both organisations.
describe('<PatientProfile /> tracking number is visible and clickable', () => {
  const TRACKED = [
    {
      id: 'ship-fedex',
      date: '2026-06-04',
      rxNumbers: ['1289900'],
      status: 'delivered',
      carrier: 'fedex',
      trackingNumber: '535650304919',
    },
    {
      id: 'ship-ups',
      date: '2026-05-01',
      rxNumbers: ['1233900'],
      status: 'shipped',
      carrier: 'ups',
      trackingNumber: '1Z0K1J03A433959948',
    },
    {
      // 42 of 900 sampled Trident rows are exactly this: carrier 'other', no number.
      id: 'ship-untracked',
      date: '2026-04-01',
      rxNumbers: ['1214000'],
      status: 'shipped',
      carrier: 'other',
      trackingNumber: '',
    },
  ]

  function renderTracked() {
    return render(<PatientProfile patient={PATIENT} shipments={TRACKED} slug="acme" />)
  }

  function carrierLinks() {
    return screen
      .getAllByRole('link')
      .filter((a) => /ups\.com|fedex\.com/.test(a.getAttribute('href') || ''))
  }

  it('shows a FedEx tracking number as a link that opens FedEx', () => {
    renderTracked()
    const link = screen.getByRole('link', { name: /535650304919/ })
    expect(link.getAttribute('href')).toContain('fedex.com')
    expect(link.getAttribute('href')).toContain('535650304919')
  })

  // The URL must come from the row's carrier. DeliveryTable.jsx hardcodes ups.com
  // for every carrier and produces broken FedEx links; this row must not repeat it.
  it('derives the URL from the row carrier — a UPS row opens UPS, not FedEx', () => {
    renderTracked()
    const link = screen.getByRole('link', { name: /1Z0K1J03A433959948/ })
    expect(link.getAttribute('href')).toContain('ups.com')
    expect(link.getAttribute('href')).not.toContain('fedex.com')
  })

  // A dead link is worse than no link: the operator clicks it, gets nothing, and
  // concludes the parcel is untraceable.
  it('renders no link for a shipment with no tracking number', () => {
    renderTracked()
    expect(carrierLinks()).toHaveLength(2)
    expect(screen.queryByRole('link', { name: /1214000/ })).toBeNull()
  })
})
