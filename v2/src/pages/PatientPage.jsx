import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useShipments } from '../hooks/useShipments'
import {
  groupShipmentsByPatient,
  buildPatientRow,
} from '../utils/patientGrouping'
import PatientProfile from '../components/PatientProfile'

// Patient list is a PURE VIEW of shipment docs: it reads useShipments and
// derives grouped rows via the patientGrouping utils, then renders the
// PatientProfile master-detail view. It never writes to Firestore.
export default function PatientPage() {
  const { slug } = useParams()
  const { shipments, loading, error } = useShipments(slug, { archived: false })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null) // { row, group }

  // Keys are already normalized (trimmed + lowercased) by the util, so the
  // filter below is a case-insensitive substring match over patient names.
  const groups = useMemo(
    () => groupShipmentsByPatient(shipments ?? []),
    [shipments],
  )
  const trimmed = query.trim().toLowerCase()

  const matched = useMemo(() => {
    if (!trimmed) return []
    return groups
      .filter((group) => group.key.includes(trimmed))
      .map((group) => ({ row: buildPatientRow(group), group }))
  }, [groups, trimmed])

  if (selected) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back to patients
        </button>
        <PatientProfile
          patient={selected.row}
          shipments={selected.group.shipments}
          slug={slug}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Patients</h1>
        <p className="mt-1 text-sm text-slate-600">
          Search by patient name to review shipment history and profile details.
        </p>
      </header>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search patients..."
        aria-label="Search patients"
        className="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
      />

      {loading && shipments.length === 0 ? (
        <p className="text-sm text-slate-500">Loading patients…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !trimmed ? (
        <p className="text-sm text-slate-500">
          Type to search patients to see them here.
        </p>
      ) : matched.length === 0 ? (
        <p className="text-sm text-slate-500">
          No patients match "{query.trim()}".
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {matched.map(({ row, group }) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => setSelected({ row, group })}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">
                  {row.patientName}
                </span>
                <span className="text-sm text-slate-500">
                  {row.shipmentCount} shipment
                  {row.shipmentCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
