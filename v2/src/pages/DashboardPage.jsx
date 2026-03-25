import { useState, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useShipments, getCentralTimeDateString, formatCentralTime } from '../hooks/useShipments'
import { useAuditLog } from '../hooks/useAuditLog'
import { useToast } from '../components/Toast'
import ShipmentTable from '../components/ShipmentTable'
import ShipmentModal from '../components/ShipmentModal'
import DeleteModal from '../components/DeleteModal'

const refreshFedExFn = httpsCallable(getFunctions(), 'refreshFedExStatuses')
const refreshUpsFn = httpsCallable(getFunctions(), 'refreshUpsStatuses')

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
]

export default function DashboardPage() {
  const { slug } = useParams()
  const { user } = useAuth()
  const { shipments, loading, error, addShipment, updateShipment, removeShipment } = useShipments(slug)
  const { logAction } = useAuditLog(slug)
  const addToast = useToast()

  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState(() => {
    // Default to 30 days ago
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return getCentralTimeDateString(d)
  })
  const [dateTo, setDateTo] = useState(getCentralTimeDateString())
  const [search, setSearch] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [editShipment, setEditShipment] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  // Shipments matching date + search filters (before status filter applied)
  const dateSearchFiltered = useMemo(() => {
    return shipments.filter((s) => {
      const shipDate = s.date || ''
      if (dateFrom && shipDate < dateFrom) return false
      if (dateTo && shipDate > dateTo) return false
      if (search) {
        const q = search.toLowerCase()
        const haystack = [
          s.patientName,
          s.address,
          s.trackingNumber,
          ...(Array.isArray(s.rxNumbers) ? s.rxNumbers : []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [shipments, dateFrom, dateTo, search])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return dateSearchFiltered
    return dateSearchFiltered.filter((s) => s.status === statusFilter)
  }, [dateSearchFiltered, statusFilter])

  // Counts per status for filter tab badges
  const statusCounts = useMemo(() => {
    const counts = { all: dateSearchFiltered.length }
    for (const s of dateSearchFiltered) {
      counts[s.status] = (counts[s.status] || 0) + 1
    }
    return counts
  }, [dateSearchFiltered])

  async function handleAdd(data) {
    const result = await addShipment(data)

    if (result.duplicate) {
      // Soft duplicate warning — same date + overlapping Rx, different tracking
      const proceed = window.confirm(
        `${result.message}\n\nClick OK to create anyway, or Cancel to skip.`
      )
      if (!proceed) {
        addToast('Shipment skipped')
        return
      }
      // Force create — user confirmed it's a new shipment
      const colRef = collection(db, 'organizations', slug, 'shipments')
      const docRef = await addDoc(colRef, {
        ...data,
        date: data.date || getCentralTimeDateString(),
        carrier: data.carrier || 'ups',
        status: data.status || 'pending',
        deliveredAt: null,
        shippedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: user?.uid,
        updatedBy: user?.uid,
      })
      await logAction('shipment.created', docRef.id, { patientName: data.patientName })
      addToast('Shipment added successfully')
      return
    }

    if (result.skipped) {
      addToast(result.message, 'warning')
      await logAction('shipment.duplicate_skipped', result.id, { trackingNumber: data.trackingNumber })
      return
    }

    if (result.merged) {
      addToast(result.message, 'success')
      await logAction('shipment.rx_merged', result.id, {
        patientName: data.patientName,
        trackingNumber: data.trackingNumber,
      })
      return
    }

    await logAction('shipment.created', result.id, { patientName: data.patientName })
    addToast('Shipment added successfully')
  }

  async function handleEdit(data) {
    const oldStatus = editShipment.status
    await updateShipment(editShipment.id, data)
    if (data.status !== oldStatus) {
      await logAction('shipment.status_changed', editShipment.id, {
        from: oldStatus,
        to: data.status,
        patientName: editShipment.patientName,
      })
    } else {
      await logAction('shipment.updated', editShipment.id, {
        patientName: data.patientName || editShipment.patientName,
      })
    }
    setEditShipment(null)
    addToast('Shipment updated')
  }

  async function handleDelete() {
    if (!deleteTarget) return
    await removeShipment(deleteTarget.id)
    await logAction('shipment.deleted', deleteTarget.id, {
      patientName: deleteTarget.patientName,
    })
    setDeleteTarget(null)
    addToast('Shipment deleted', 'error')
  }

  async function handleStatusChange(id, status) {
    const shipment = shipments.find((s) => s.id === id)
    const oldStatus = shipment?.status
    await updateShipment(id, { status })
    await logAction('shipment.status_changed', id, {
      from: oldStatus,
      to: status,
      patientName: shipment?.patientName,
    })
    addToast(`Status changed to ${status.replace('_', ' ')}`)
  }

  async function handleRefreshTracking() {
    setRefreshing(true)
    let totalChecked = 0
    let totalUpdated = 0
    const errors = []

    // Refresh FedEx
    try {
      const result = await refreshFedExFn({ orgSlug: slug })
      totalChecked += result.data.checked || 0
      totalUpdated += result.data.updated || 0
    } catch (err) {
      console.error('FedEx refresh error:', err)
      errors.push('FedEx')
    }

    // Refresh UPS
    try {
      const result = await refreshUpsFn({ orgSlug: slug })
      totalChecked += result.data.checked || 0
      totalUpdated += result.data.updated || 0
    } catch (err) {
      console.error('UPS refresh error:', err)
      errors.push('UPS')
    }

    if (errors.length > 0 && totalChecked === 0) {
      addToast(`Failed to refresh ${errors.join(' and ')} statuses`, 'error')
    } else if (totalChecked === 0) {
      addToast('No active shipments to check')
    } else {
      const msg = `Checked ${totalChecked} shipment${totalChecked === 1 ? '' : 's'}, updated ${totalUpdated}`
      addToast(errors.length > 0 ? `${msg} (${errors.join(', ')} failed)` : msg, 'success')
    }
    await logAction('tracking.status_refresh', null, { checked: totalChecked, updated: totalUpdated })
    setRefreshing(false)
  }

  function exportCsv() {
    if (!filtered.length) return
    const headers = [
      'Patient Name', 'Address', 'Phone', 'RX Numbers',
      'Tracking Number', 'Carrier', 'Status', 'Ship Date', 'Notes',
    ]
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`
    const rows = filtered.map((s) =>
      [
        esc(s.patientName),
        esc(s.address),
        esc(s.phone),
        esc(Array.isArray(s.rxNumbers) ? s.rxNumbers.join(', ') : ''),
        esc(s.trackingNumber),
        esc(s.carrier || 'ups'),
        esc(s.status),
        esc(s.shippedAt ? formatCentralTime(s.shippedAt) : ''),
        esc(s.notes),
      ].join(',')
    )
    const csv = headers.join(',') + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8,' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shipments_${getCentralTimeDateString()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
        <h2 className="text-lg font-semibold mb-2">Error Loading Shipments</h2>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div>
      {/* Header — Title + Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-2xl font-bold text-slate-900">Shipments</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefreshTracking}
            disabled={refreshing}
            className="px-3 py-1.5 text-sm font-medium text-purple-700 bg-white border border-purple-300 rounded-lg hover:bg-purple-50 disabled:opacity-50 transition-colors"
            title="Check UPS and FedEx for status updates on all active shipments"
          >
            {refreshing ? 'Checking...' : 'Refresh Tracking'}
          </button>
          <button
            onClick={exportCsv}
            className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            + Add Shipment
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search patient, RX, tracking..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
        />
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-slate-500">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-slate-500">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={() => {
            const d = new Date()
            d.setDate(d.getDate() - 30)
            setDateFrom(getCentralTimeDateString(d))
            setDateTo(getCentralTimeDateString())
          }}
          className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
        >
          Last 30 days
        </button>
        <button
          onClick={() => {
            setDateFrom('')
            setDateTo('')
          }}
          className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
        >
          All dates
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-1 mb-4 bg-white rounded-lg border border-slate-200 p-1 w-fit">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              statusFilter === f.value
                ? 'bg-blue-600 text-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            {f.label}
            {statusCounts[f.value] != null && (
              <span className={`ml-1.5 text-xs ${
                statusFilter === f.value ? 'text-blue-200' : 'text-slate-400'
              }`}>
                ({statusCounts[f.value]})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <ShipmentTable
            shipments={filtered}
            onEdit={setEditShipment}
            onDelete={setDeleteTarget}
            onStatusChange={handleStatusChange}
          />
        )}
      </div>

      {/* Count */}
      <p className="mt-3 text-sm text-slate-500">
        {filtered.length} shipment{filtered.length === 1 ? '' : 's'}
        {statusFilter !== 'all' && ` (${statusFilter.replace('_', ' ')})`}
      </p>

      {/* Modals */}
      <ShipmentModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleAdd}
      />

      <ShipmentModal
        isOpen={!!editShipment}
        onClose={() => setEditShipment(null)}
        onSubmit={handleEdit}
        shipment={editShipment}
      />

      <DeleteModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        patientName={deleteTarget?.patientName}
      />
    </div>
  )
}
