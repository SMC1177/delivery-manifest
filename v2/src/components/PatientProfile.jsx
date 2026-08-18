import { useState } from 'react'
import { buildProfileSections } from '../utils/patientGrouping'
import { useSmsContact } from '../hooks/useSmsContact'
import { getTrackingUrl } from '../lib/carriers'

// Language spoken by the patient, from their sms contact record.
const LANGUAGE_LABELS = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
}

// Human labels for useSmsContact derivedState. Messaging & Consent is a pure
// VIEW of the sms contact record — client rules deny writes to smsContacts.
const STATUS_LABELS = {
  unknown: 'No opt-in recorded yet',
  pending: 'Invitation sent — awaiting reply',
  opted_in: 'Opted in to text messages',
  opted_out: 'Opted out of text messages',
  no_phone: 'No valid phone number entered',
}

// Display titles for the address sections built by buildProfileSections.
const SECTION_TITLES = {
  Facility: 'Facility',
  Home: 'Home',
  MD: 'MD / Prescriber',
}

const TABS = [
  { id: 'prescriptions', label: 'Prescriptions & Shipments' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'facility', label: 'Facility' },
  { id: 'messaging', label: 'Messaging & Consent' },
  { id: 'notes', label: 'Notes' },
]

// Tracking line for a shipment row. getTrackingUrl returns null when the
// carrier is unknown OR the number is empty — a dead link is worse than none,
// so a null URL renders the number as plain text (or nothing at all when the
// number is empty). The URL always comes from getTrackingUrl, never hardcoded.
function renderTracking(shipment) {
  const trackingNumber = shipment.trackingNumber
  const url = getTrackingUrl(shipment.carrier, trackingNumber)
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-slate-600 underline"
      >
        {trackingNumber}
      </a>
    )
  }
  if (trackingNumber) {
    return <p className="text-sm text-slate-600">{trackingNumber}</p>
  }
  return null
}

export default function PatientProfile({ patient, shipments, slug }) {
  const [activeTab, setActiveTab] = useState('prescriptions')
  const sections = buildProfileSections({ shipments }) ?? {}
  const { contact, loading, derivedState, normalizedPhone } = useSmsContact(slug, patient.phone)

  // The prescriptions tab renders each shipment as its own row (newest-first).
  // Shipments are the unit of display — never key by date (same-day shipments
  // must stay distinct) and never key by rx (refills share rx numbers).
  const rows = [...(shipments ?? [])].sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || ''))
  )

  const addresses = sections.addresses ?? {}
  const insurance = sections.insurance

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">{patient.patientName}</h1>
        <dl className="mt-2 space-y-0.5 text-sm text-slate-600">
          <div>
            <dt className="inline font-medium text-slate-700">Phone: </dt>
            <dd className="inline">{patient.phone}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">DOB: </dt>
            <dd className="inline">{patient.dob}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">Address: </dt>
            <dd className="inline">{patient.address}</dd>
          </div>
        </dl>
      </header>

      <nav className="mb-6 flex flex-wrap gap-1" aria-label="Patient sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'prescriptions' && (
        <ul className="divide-y divide-slate-200">
          {rows.map((shipment, index) => (
            <li key={shipment.id ?? index} className="py-3">
              <p className="font-medium text-slate-900">
                {shipment.drugDescription ?? 'Unknown medication'}
              </p>
              <p className="text-sm text-slate-500">
                {(shipment.rxNumbers ?? []).join(', ')} · {shipment.date ?? '—'}
              </p>
              <p className="text-sm text-slate-600">Status: {shipment.status ?? 'unknown'}</p>
              {renderTracking(shipment)}
            </li>
          ))}
        </ul>
      )}

      {activeTab === 'addresses' && (
        <div className="space-y-6">
          {Object.entries(addresses).map(([section, data]) => (
            <section key={section}>
              <h3 className="font-semibold text-slate-900">{SECTION_TITLES[section] ?? section}</h3>
              <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">Default</p>
              <p className="text-sm text-slate-700">{data?.default}</p>
              <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">History</p>
              <ul className="list-disc pl-5 text-sm text-slate-600">
                {(data?.history ?? [])
                  .filter((value) => value !== data?.default)
                  .map((value) => (
                    <li key={value}>{value}</li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {activeTab === 'insurance' && insurance && (
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="inline font-medium text-slate-700">AWP Cost: </dt>
            <dd className="inline">{insurance.awpCost}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">Copay: </dt>
            <dd className="inline">{insurance.copayAmount}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">NDC: </dt>
            <dd className="inline">{insurance.ndc}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">Quantity: </dt>
            <dd className="inline">{insurance.quantityDispensed}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-700">Days Supply: </dt>
            <dd className="inline">{insurance.daysSupply}</dd>
          </div>
        </dl>
      )}

      {activeTab === 'facility' && (
        <ul className="list-disc pl-5 text-sm text-slate-700">
          {(sections.facilityNames ?? []).map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}

      {activeTab === 'messaging' && (
        <div className="space-y-1 text-sm text-slate-700">
          <p>Phone: {normalizedPhone ?? '—'}</p>
          <p>Language: {LANGUAGE_LABELS[contact?.language] ?? contact?.language ?? 'Unknown'}</p>
          {loading ? <p>Loading consent…</p> : <p>{STATUS_LABELS[derivedState] ?? derivedState}</p>}
        </div>
      )}

      {activeTab === 'notes' && (
        <ul className="list-disc pl-5 text-sm text-slate-700">
          {(sections.notes ?? []).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
