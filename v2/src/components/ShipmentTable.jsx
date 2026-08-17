import { useState, Fragment, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useOrgSettings } from '../hooks/useOrgSettings'
import StatusBadge from './StatusBadge'
import { getTrackingUrl, getCarrierName } from '../lib/carriers'
import OptInDot from './OptInDot'
import SendTextModal from './SendTextModal'
import ShipmentModal from './ShipmentModal'
import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'

const COLUMN_DEFS = [
  { key: 'date', label: 'Date' },
  { key: 'patientName', label: 'Patient Name' },
  { key: 'address', label: 'Address' },
  { key: 'phone', label: 'Phone' },
  { key: 'dob', label: 'DOB' },
  { key: 'rxNumbers', label: 'Rx Numbers' },
  { key: 'tracking', label: 'Tracking #' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'status', label: 'Status' },
  { key: 'redeliver', label: 'Redeliver' },
  { key: 'notes', label: 'Notes' },
]

// Columns that are also gated by the org's enabledFields setting
const ORG_GATED_COLUMNS = ['address', 'phone', 'dob', 'carrier', 'redeliver', 'notes']

const DEFAULT_VISIBLE_COLUMNS = COLUMN_DEFS.map((c) => c.key)

// Frozen anchor columns (pinned while the table scrolls). Widths are fixed so
// the sticky left offsets line up; they must match the w-* classes on the cells.
const FROZEN_DEFS = [
  { key: 'date', width: 112 }, // w-28
  { key: 'patientName', width: 160 }, // w-40
  { key: 'tracking', width: 176 }, // w-44
  { key: 'status', width: 160 }, // w-40
]

export default function ShipmentTable({ shipments, onEdit, onDelete, onStatusChange, readOnly, selectedIds, onSelectionChange, queueStates }) {
  const { slug } = useParams()
  const { settings, isFieldEnabled } = useOrgSettings(slug)
  const [expandedGroups, setExpandedGroups] = useState(new Set())
  const [smsModalShipment, setSmsModalShipment] = useState(null)
  const [settingsModalShipment, setSettingsModalShipment] = useState(null)
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [columnOverride, setColumnOverride] = useState(null)
  const { data: smsSettings } = useTextMessagingSettings(slug)
  const smsEnabled = smsSettings?.enabled === true

  const selectionEnabled = selectedIds !== undefined && onSelectionChange !== undefined

  // Column visibility: local toggle first, saved per-org preference second
  const savedVisibleColumns = settings?.visibleColumns
  const visibleColumns = columnOverride
    ?? (Array.isArray(savedVisibleColumns) && savedVisibleColumns.length > 0 ? savedVisibleColumns : DEFAULT_VISIBLE_COLUMNS)

  const isColumnVisible = (key) =>
    visibleColumns.includes(key) && (!ORG_GATED_COLUMNS.includes(key) || isFieldEnabled(key))

  const toggleColumn = (key) => {
    const next = visibleColumns.includes(key)
      ? visibleColumns.filter((k) => k !== key)
      : [...visibleColumns, key]
    setColumnOverride(next)
    if (slug) {
      updateDoc(doc(db, 'organizations', slug), {
        'settings.visibleColumns': next,
        updatedAt: serverTimestamp(),
      }).catch((err) => console.warn(`Failed to save column visibility for org ${slug}:`, err))
    }
  }

  // Sticky left offsets for the frozen anchor columns (checkbox col shifts them)
  const frozenLeft = {}
  let cursor = selectionEnabled ? 40 : 0
  for (const def of FROZEN_DEFS) {
    if (visibleColumns.includes(def.key)) {
      frozenLeft[def.key] = cursor
      cursor += def.width
    }
  }

  const isSelected = (id) => {
    if (!selectionEnabled) return false
    if (selectedIds instanceof Set) return selectedIds.has(id)
    return Array.isArray(selectedIds) ? selectedIds.includes(id) : false
  }

  const allVisibleSelected = selectionEnabled && shipments.length > 0 && shipments.every(s => isSelected(s.id))
  const someVisibleSelected = selectionEnabled && shipments.some(s => isSelected(s.id))

  const headerCheckboxRef = useRef(null)

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected && !allVisibleSelected
    }
  }, [someVisibleSelected, allVisibleSelected])

  const toggleGroup = (trackingNumber) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(trackingNumber)) next.delete(trackingNumber)
      else next.add(trackingNumber)
      return next
    })
  }

  // Group shipments by tracking number
  const grouped = []
  const trackingMap = new Map()
  for (const s of shipments) {
    const key = s.trackingNumber?.trim().toLowerCase()
    if (key && trackingMap.has(key)) {
      trackingMap.get(key).children.push(s)
    } else if (key) {
      const group = { primary: s, children: [], trackingKey: key }
      trackingMap.set(key, group)
      grouped.push(group)
    } else {
      // No tracking number — standalone row
      grouped.push({ primary: s, children: [], trackingKey: null })
    }
  }

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

  // Merge all Rx numbers from primary + children
  const getMergedRx = (group) => {
    const allRx = []
    const seen = new Set()
    const addRx = (rxArr) => {
      if (!Array.isArray(rxArr)) return
      for (const rx of rxArr) {
        if (!seen.has(rx)) {
          seen.add(rx)
          allRx.push(rx)
        }
      }
    }
    addRx(group.primary.rxNumbers)
    for (const child of group.children) {
      addRx(child.rxNumbers)
    }
    return allRx
  }

  // Render a single row for the desktop table
  const renderDesktopRow = (s, { isChild = false, groupHasChildren = false, childCount = 0, trackingKey = null, mergedRx = null } = {}) => (
    <tr
      key={s.id}
      className={`group ${isChild ? 'bg-slate-50' : 'hover:bg-slate-50'} transition-colors ${groupHasChildren && !isChild ? 'cursor-pointer' : ''}`}
      onClick={groupHasChildren && !isChild ? () => toggleGroup(trackingKey) : undefined}
    >
      {selectionEnabled && (
        <td className="px-2 py-3 w-10" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="rounded border-slate-300"
            checked={isSelected(s.id)}
            onChange={() => {
              if (selectedIds instanceof Set) {
                const next = new Set(selectedIds)
                if (next.has(s.id)) next.delete(s.id)
                else next.add(s.id)
                onSelectionChange(next)
              } else {
                const arr = Array.isArray(selectedIds) ? selectedIds : []
                if (arr.includes(s.id)) {
                  onSelectionChange(arr.filter(id => id !== s.id))
                } else {
                  onSelectionChange([...arr, s.id])
                }
              }
            }}
          />
        </td>
      )}
      {isColumnVisible('date') && (
        <td className={`px-4 py-3 text-slate-600 whitespace-nowrap w-28 sticky ${isChild ? 'bg-slate-50' : 'bg-white group-hover:bg-slate-50'}`} style={{ left: frozenLeft.date }}>
          {s.date || '\u2014'}
        </td>
      )}
      {isColumnVisible('patientName') && (
        <td className={`px-4 py-3 font-medium text-slate-900 w-40 sticky ${isChild ? 'bg-slate-50 pl-8' : 'bg-white group-hover:bg-slate-50'}`} style={{ left: frozenLeft.patientName }}>
          <span className="inline-flex items-center gap-1.5">
            <OptInDot slug={slug} phone={s.phone} enabled={smsEnabled} />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSettingsModalShipment(s) }}
              className="text-blue-700 hover:underline cursor-pointer text-left"
              title="Click to open patient settings"
            >
              {s.patientName}
            </button>
          </span>
          {groupHasChildren && !isChild && (
            <span className="ml-2 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-700">
              +{childCount}
            </span>
          )}
          {groupHasChildren && !isChild && (
            <span className="ml-1 text-slate-400 text-xs">
              {expandedGroups.has(trackingKey) ? '\u25B2' : '\u25BC'}
            </span>
          )}
        </td>
      )}
      {isColumnVisible('address') && <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate">{s.address || '\u2014'}</td>}
      {isColumnVisible('phone') && <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.phone || '\u2014'}</td>}
      {isColumnVisible('dob') && <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.dob || '\u2014'}</td>}
      {isColumnVisible('rxNumbers') && (
        <td className="px-4 py-3 text-slate-600">
          {isChild
            ? (Array.isArray(s.rxNumbers) ? s.rxNumbers.join(', ') : '\u2014')
            : (mergedRx && mergedRx.length > 0 ? mergedRx.join(', ') : (Array.isArray(s.rxNumbers) ? s.rxNumbers.join(', ') : '\u2014'))
          }
        </td>
      )}
      {isColumnVisible('tracking') && (
        <td className={`px-4 py-3 font-mono text-xs w-44 sticky ${isChild ? 'bg-slate-50' : 'bg-white group-hover:bg-slate-50'}`} style={{ left: frozenLeft.tracking }}>
          {s.trackingNumber ? (
            <a
              href={getTrackingUrl(s.carrier || 'ups', s.trackingNumber)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {s.trackingNumber}
            </a>
          ) : (
            <span className="text-slate-400">{'\u2014'}</span>
          )}
        </td>
      )}
      {isColumnVisible('carrier') && <td className="px-4 py-3 text-slate-600">{getCarrierName(s.carrier) || '\u2014'}</td>}
      {isColumnVisible('status') && (
        <td className={`px-4 py-3 w-40 sticky ${isChild ? 'bg-slate-50' : 'bg-white group-hover:bg-slate-50'}`} style={{ left: frozenLeft.status }}>
          <StatusBadge status={s.status} />
          {s.status === 'exception' && (s.upsStatus || s.fedexStatus) ? (
            <div
              className="mt-1 text-xs text-red-700 whitespace-normal"
              title={s.upsStatus || s.fedexStatus}
            >
              {s.upsStatus || s.fedexStatus}
            </div>
          ) : null}
          {queueStates && queueStates[s.trackingNumber] ? (
            <div className="mt-1">
              <span className="inline-flex items-center px-1.5 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-700 whitespace-nowrap">
                {queueStates[s.trackingNumber]}
              </span>
            </div>
          ) : null}
        </td>
      )}
      {isColumnVisible('redeliver') && (
        <td className="px-4 py-3">
          {s.redeliver ? <span className="text-orange-600 text-xs font-medium">Yes</span> : <span className="text-slate-400 text-xs">{'\u2014'}</span>}
        </td>
      )}
      {isColumnVisible('notes') && <td className="px-4 py-3 text-slate-500 text-xs max-w-[150px] truncate">{s.notes || '\u2014'}</td>}
      {!readOnly && (
      <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
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
  )

  // Render a single mobile card
  const renderMobileCard = (s, { isChild = false } = {}) => (
    <div key={s.id} className={`bg-white border border-slate-200 rounded-lg p-4 ${isChild ? 'ml-4 border-l-2 border-l-blue-200' : ''}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-medium text-slate-900">
            <span className="inline-flex items-center gap-1.5">
              <OptInDot slug={slug} phone={s.phone} enabled={smsEnabled} />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setSettingsModalShipment(s) }}
                className="text-blue-700 hover:underline cursor-pointer text-left"
                title="Click to open patient settings"
              >
                {s.patientName}
              </button>
            </span>
          </h3>
          {s.date && <p className="text-xs text-slate-400">{s.date}</p>}
        </div>
        <StatusBadge status={s.status} />
      </div>
      {s.status === 'exception' && (s.upsStatus || s.fedexStatus) ? (
        <p className="text-sm text-red-700 mb-1">{s.upsStatus || s.fedexStatus}</p>
      ) : null}
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
        <p className="text-xs text-orange-600 font-medium mb-1">{'\u27F3'} Redeliver</p>
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
  )

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="flex items-center justify-end mb-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setColumnMenuOpen((open) => !open)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded px-2.5 py-1.5 hover:bg-slate-50"
            >
              Columns
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {columnMenuOpen && (
              <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg p-2">
                {COLUMN_DEFS.map((c) => (
                  <label
                    key={c.key}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-slate-700 rounded hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={isColumnVisible(c.key)}
                      disabled={ORG_GATED_COLUMNS.includes(c.key) && !isFieldEnabled(c.key)}
                      onChange={() => toggleColumn(c.key)}
                      title={ORG_GATED_COLUMNS.includes(c.key) && !isFieldEnabled(c.key) ? 'Disabled by organization settings' : undefined}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm text-left">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider sticky top-0 bg-white z-10">
              {selectionEnabled && (
                <th className="px-2 py-3 font-medium w-10">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={allVisibleSelected}
                    ref={headerCheckboxRef}
                    onChange={() => {
                      if (allVisibleSelected) {
                        onSelectionChange(selectedIds instanceof Set ? new Set() : [])
                      } else {
                        const ids = shipments.map(s => s.id)
                        onSelectionChange(selectedIds instanceof Set ? new Set(ids) : ids)
                      }
                    }}
                    title={allVisibleSelected ? 'Deselect all shipments on this page' : 'Select all shipments on this page'}
                  />
                </th>
              )}
              {isColumnVisible('date') && <th className="px-4 py-3 font-medium w-28 sticky top-0 bg-white z-10" style={{ left: frozenLeft.date }}>Date</th>}
              {isColumnVisible('patientName') && <th className="px-4 py-3 font-medium w-40 sticky top-0 bg-white z-10" style={{ left: frozenLeft.patientName }}>Patient Name</th>}
              {isColumnVisible('address') && <th className="px-4 py-3 font-medium">Address</th>}
              {isColumnVisible('phone') && <th className="px-4 py-3 font-medium">Phone</th>}
              {isColumnVisible('dob') && <th className="px-4 py-3 font-medium">DOB</th>}
              {isColumnVisible('rxNumbers') && <th className="px-4 py-3 font-medium">Rx Numbers</th>}
              {isColumnVisible('tracking') && <th className="px-4 py-3 font-medium w-44 sticky top-0 bg-white z-10" style={{ left: frozenLeft.tracking }}>Tracking #</th>}
              {isColumnVisible('carrier') && <th className="px-4 py-3 font-medium">Carrier</th>}
              {isColumnVisible('status') && <th className="px-4 py-3 font-medium w-40 sticky top-0 bg-white z-10" style={{ left: frozenLeft.status }}>Status</th>}
              {isColumnVisible('redeliver') && <th className="px-4 py-3 font-medium">Redeliver</th>}
              {isColumnVisible('notes') && <th className="px-4 py-3 font-medium">Notes</th>}
              {!readOnly && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {grouped.map((group) => {
              const hasChildren = group.children.length > 0
              const isExpanded = group.trackingKey && expandedGroups.has(group.trackingKey)
              const mergedRx = hasChildren ? getMergedRx(group) : null

              return (
                <Fragment key={group.primary.id}>
                  {renderDesktopRow(group.primary, {
                    isChild: false,
                    groupHasChildren: hasChildren,
                    childCount: group.children.length,
                    trackingKey: group.trackingKey,
                    mergedRx,
                  })}
                  {hasChildren && isExpanded && group.children.map((child) =>
                    renderDesktopRow(child, { isChild: true })
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {grouped.map((group) => {
          const hasChildren = group.children.length > 0
          const isExpanded = group.trackingKey && expandedGroups.has(group.trackingKey)

          return (
            <div key={group.primary.id}>
              {renderMobileCard(group.primary)}
              {hasChildren && !isExpanded && (
                <button
                  onClick={() => toggleGroup(group.trackingKey)}
                  className="mt-1 ml-4 text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  View {group.children.length} more {group.children.length === 1 ? 'entry' : 'entries'}
                </button>
              )}
              {hasChildren && isExpanded && (
                <>
                  <div className="mt-2 space-y-2">
                    {group.children.map((child) => renderMobileCard(child, { isChild: true }))}
                  </div>
                  <button
                    onClick={() => toggleGroup(group.trackingKey)}
                    className="mt-1 ml-4 text-xs text-slate-500 hover:text-slate-700 font-medium"
                  >
                    Collapse
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {smsModalShipment && (
        <SendTextModal
          slug={slug}
          shipment={smsModalShipment}
          onClose={() => setSmsModalShipment(null)}
        />
      )}
      {settingsModalShipment && (
        <ShipmentModal
          isOpen
          onClose={() => setSettingsModalShipment(null)}
          onSubmit={onEdit}
          shipment={settingsModalShipment}
        />
      )}
    </>
  )
}
