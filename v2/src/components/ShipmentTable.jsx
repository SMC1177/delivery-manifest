import { useParams } from 'react-router-dom'
import { useOrgSettings } from '../hooks/useOrgSettings'
import StatusBadge from './StatusBadge'
import { getTrackingUrl, getCarrierName } from '../lib/carriers'

export default function ShipmentTable({ shipments, onEdit, onDelete, onStatusChange, readOnly }) {
  const { slug } = useParams()
  const { isFieldEnabled } = useOrgSettings(slug)
  if (shipments.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <svg className="mx-auto h-12 w-12 text-slate-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
        <p className="text-lg font-medium">No shipments found</p>
        <p className="mt-1">Add your first shipment or adjust your filters.</p>
      </div>
    )
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Patient Name</th>
              {isFieldEnabled('address') && <th className="px-4 py-3 font-medium">Address</th>}
              {isFieldEnabled('phone') && <th className="px-4 py-3 font-medium">Phone</th>}
              {isFieldEnabled('dob') && <th className="px-4 py-3 font-medium">DOB</th>}
              <th className="px-4 py-3 font-medium">Rx Numbers</th>
              <th className="px-4 py-3 font-medium">Tracking #</th>
              {isFieldEnabled('carrier') && <th className="px-4 py-3 font-medium">Carrier</th>}
              <th className="px-4 py-3 font-medium">Status</th>
              {isFieldEnabled('redeliver') && <th className="px-4 py-3 font-medium">Redeliver</th>}
              {isFieldEnabled('notes') && <th className="px-4 py-3 font-medium">Notes</th>}
              {!readOnly && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shipments.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.date || '—'}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{s.patientName}</td>
                {isFieldEnabled('address') && <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate">{s.address || '—'}</td>}
                {isFieldEnabled('phone') && <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.phone || '—'}</td>}
                {isFieldEnabled('dob') && <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.dob || '—'}</td>}
                <td className="px-4 py-3 text-slate-600">
                  {Array.isArray(s.rxNumbers) ? s.rxNumbers.join(', ') : '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {s.trackingNumber ? (
                    <a
                      href={getTrackingUrl(s.carrier || 'ups', s.trackingNumber)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {s.trackingNumber}
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                {isFieldEnabled('carrier') && <td className="px-4 py-3 text-slate-600">{getCarrierName(s.carrier) || '—'}</td>}
                <td className="px-4 py-3">
                  <StatusBadge status={s.status} />
                </td>
                {isFieldEnabled('redeliver') && (
                  <td className="px-4 py-3">
                    {s.redeliver ? <span className="text-orange-600 text-xs font-medium">Yes</span> : <span className="text-slate-400 text-xs">—</span>}
                  </td>
                )}
                {isFieldEnabled('notes') && <td className="px-4 py-3 text-slate-500 text-xs max-w-[150px] truncate">{s.notes || '—'}</td>}
                {!readOnly && (
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <select
                    value={s.status}
                    onChange={(e) => onStatusChange?.(s.id, e.target.value)}
                    className="mr-2 text-xs border border-slate-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="pending">Pending</option>
                    <option value="shipped">Shipped</option>
                    <option value="in_transit">In Transit</option>
                    <option value="delivered">Delivered</option>
                    <option value="exception">Exception</option>
                  </select>
                  <button
                    onClick={() => onEdit?.(s)}
                    className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-50 transition-colors"
                    title="Edit"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onDelete?.(s)}
                    className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50 transition-colors ml-1"
                    title="Delete"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {shipments.map((s) => (
          <div key={s.id} className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="font-medium text-slate-900">{s.patientName}</h3>
                {s.date && <p className="text-xs text-slate-400">{s.date}</p>}
              </div>
              <StatusBadge status={s.status} />
            </div>
            {isFieldEnabled('address') && s.address && <p className="text-sm text-slate-600 mb-1">{s.address}</p>}
            {isFieldEnabled('phone') && s.phone && <p className="text-sm text-slate-600 mb-1">{s.phone}</p>}
            {isFieldEnabled('dob') && s.dob && <p className="text-sm text-slate-600 mb-1">DOB: {s.dob}</p>}
            {s.rxNumbers?.length > 0 && (
              <p className="text-sm text-slate-500 mb-1">
                <span className="font-medium">RX:</span> {s.rxNumbers.join(', ')}
              </p>
            )}
            {s.trackingNumber && (
              <p className="text-sm mb-2">
                <a
                  href={getTrackingUrl(s.carrier || 'ups', s.trackingNumber)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline font-mono text-xs"
                >
                  {s.trackingNumber}
                </a>
              </p>
            )}
            {isFieldEnabled('redeliver') && s.redeliver && (
              <p className="text-xs text-orange-600 font-medium mb-1">⟳ Redeliver</p>
            )}
            {isFieldEnabled('notes') && s.notes && (
              <p className="text-xs text-slate-500 mb-1">{s.notes}</p>
            )}
            {!readOnly && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
              <select
                value={s.status}
                onChange={(e) => onStatusChange?.(s.id, e.target.value)}
                className="text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="pending">Pending</option>
                <option value="shipped">Shipped</option>
                <option value="in_transit">In Transit</option>
                <option value="delivered">Delivered</option>
                <option value="exception">Exception</option>
              </select>
              <div className="flex gap-2">
                <button onClick={() => onEdit?.(s)} className="text-blue-600 hover:text-blue-800 p-1.5 rounded hover:bg-blue-50">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <button onClick={() => onDelete?.(s)} className="text-red-600 hover:text-red-800 p-1.5 rounded hover:bg-red-50">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
