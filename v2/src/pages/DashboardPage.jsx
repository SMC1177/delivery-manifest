import { useState, useRef, useMemo, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { collection, addDoc, serverTimestamp, getDocs, writeBatch, doc, getDoc } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth'
import { db, auth } from '../lib/firebase'
import { buildSearchHaystack, matchesSearchQuery } from '../lib/shipmentSearch'
import { useAuth } from '../contexts/AuthContext'
import { useShipments, getCentralTimeDateString, formatCentralTime } from '../hooks/useShipments'
import { useAuditLog } from '../hooks/useAuditLog'
import { useToast } from '../components/Toast'
import { useOrganization } from '../hooks/useOrganization'
import { useArchiveActions } from '../hooks/useArchiveActions'
import ShipmentTable from '../components/ShipmentTable'
import ShipmentModal from '../components/ShipmentModal'
import DeleteModal from '../components/DeleteModal'

const refreshFedExFn = httpsCallable(getFunctions(), 'refreshFedExStatuses')
const refreshUpsFn = httpsCallable(getFunctions(), 'refreshUpsStatuses')
const backfillTrackAlertFn = httpsCallable(getFunctions(), 'backfillTrackAlertSubscriptions')

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
]

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100, 200, 300]
const DEFAULT_ROWS_PER_PAGE = 100

function restoreRowsPerPage(slug) {
  try {
    const raw = localStorage.getItem(`dashboard_rowsPerPage_${slug}`)
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n >= 10 && n <= 300) return n
  } catch (e) {
    console.error('Failed to read rowsPerPage from localStorage:', e)
  }
  return DEFAULT_ROWS_PER_PAGE
}

export default function DashboardPage() {
  const { slug } = useParams()
  const { user, userData } = useAuth()
  const isViewer = userData?.role === 'viewer'
  const { org } = useOrganization()
  const backfillComplete = org?.archiveBackfillComplete === true
  const {
    shipments, loading, error, refresh,
    addShipment, updateShipment, removeShipment,
  } = useShipments(slug, { archived: false, backfillComplete })
  const isAdmin = userData?.role === 'admin'
  const {
    archiveShipments,
    error: archiveHookError,
  } = useArchiveActions(slug)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveProcessed, setArchiveProcessed] = useState(0)
  const [archiveTotal, setArchiveTotal] = useState(0)
  const [archiveErr, setArchiveErr] = useState(null)
  const archiveHookErrRef = useRef(null)
  useEffect(() => {
    archiveHookErrRef.current = archiveHookError
  }, [archiveHookError])
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
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(() => restoreRowsPerPage(slug))
  const effectivePageSize = Math.max(10, Math.min(300, pageSize))

  // Persist rows-per-page choice
  useEffect(() => {
    try {
      localStorage.setItem(`dashboard_rowsPerPage_${slug}`, pageSize)
    } catch (e) {
      console.error('Failed to save rowsPerPage to localStorage:', e)
    }
  }, [pageSize, slug])

  // Reset to first page when page size changes
  useEffect(() => {
    setPage(0)
  }, [pageSize])

  // Secret clear-all: triple-click title → password modal → re-auth against org owner
  const [showClearAll, setShowClearAll] = useState(false)
  const [showClearPrompt, setShowClearPrompt] = useState(false)
  const [clearPassword, setClearPassword] = useState('')
  const [clearingAll, setClearingAll] = useState(false)
  const [clearError, setClearError] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const clickCountRef = useRef(0)
  const clickTimerRef = useRef(null)

  async function handleTitleClick() {
    clickCountRef.current++
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => { clickCountRef.current = 0 }, 600)
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0
      // Look up the org owner's email
      try {
        const orgDoc = await getDoc(doc(db, 'organizations', slug))
        const ownerId = orgDoc.data()?.createdBy
        if (!ownerId) { addToast('No org owner found', 'error'); return }
        const ownerProfile = await getDoc(doc(db, 'userProfiles', ownerId))
        const email = ownerProfile.data()?.email
        if (!email) { addToast('Owner email not found', 'error'); return }
        setOwnerEmail(email)
        setClearPassword('')
        setClearError('')
        setShowClearPrompt(true)
      } catch {
        addToast('Failed to look up org owner', 'error')
      }
    }
  }

  async function handleClearAuth(e) {
    e.preventDefault()
    setClearError('')
    try {
      const credential = EmailAuthProvider.credential(ownerEmail, clearPassword)
      await reauthenticateWithCredential(auth.currentUser, credential)
      setShowClearPrompt(false)
      setClearPassword('')
      setShowClearAll(true)
      addToast('Clear All unlocked', 'info')
    } catch (err) {
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setClearError('Incorrect password.')
      } else if (err.code === 'auth/user-mismatch') {
        setClearError('You must be logged in as the account holder to clear data.')
      } else {
        setClearError(err.message)
      }
    }
  }

  async function handleClearAll() {
    if (!window.confirm(`Delete ALL ${shipments.length} shipments? This cannot be undone.`)) return
    setClearingAll(true)
    try {
      const colRef = collection(db, 'organizations', slug, 'shipments')
      const snap = await getDocs(colRef)
      for (let i = 0; i < snap.docs.length; i += 500) {
        const batch = writeBatch(db)
        snap.docs.slice(i, i + 500).forEach((d) => batch.delete(doc(db, 'organizations', slug, 'shipments', d.id)))
        await batch.commit()
      }
      await logAction('shipment.clear_all', null, { count: snap.size })
      addToast(`Cleared ${snap.size} shipments`)
      setShowClearAll(false)
    } catch (err) {
      addToast('Clear failed: ' + err.message, 'error')
    } finally {
      setClearingAll(false)
    }
  }
  const [refreshing, setRefreshing] = useState(false)

  // Shipments matching date + search filters (before status filter applied)
  // The haystack depends on the SHIPMENT ALONE, never on the query, so it is
  // built once per row here rather than rebuilt for every row on every
  // keystroke. That distinction is the whole fix: the search itself then costs
  // one String.includes per row instead of an array, a filter, a join and a
  // toLowerCase. Keyed on [shipments] deliberately - adding `search` here
  // would silently restore the old cost.
  const shipmentsWithHaystack = useMemo(
    () => shipments.map((s) => ({ s, haystack: buildSearchHaystack(s) })),
    [shipments],
  )

  const dateSearchFiltered = useMemo(() => {
    return shipmentsWithHaystack
      .filter(({ s, haystack }) => {
        const shipDate = s.date || ''
        if (dateFrom && shipDate < dateFrom) return false
        if (dateTo && shipDate > dateTo) return false
        return matchesSearchQuery(haystack, search)
      })
      .map(({ s }) => s)
  }, [shipmentsWithHaystack, dateFrom, dateTo, search])

  const filtered = useMemo(() => {
    const result = statusFilter === 'all' ? dateSearchFiltered : dateSearchFiltered.filter((s) => s.status === statusFilter)
    setPage(0) // reset to first page when filters change
    return result
  }, [dateSearchFiltered, statusFilter])

  const totalPages = Math.ceil(filtered.length / effectivePageSize)
  const paginatedShipments = filtered.slice(page * effectivePageSize, (page + 1) * effectivePageSize)

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

    // Subscribe active UPS tracking numbers to Track Alert
    try {
      await backfillTrackAlertFn({})
    } catch (err) {
      console.error('Track Alert backfill error:', err)
    }

    await refresh()

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

  async function handleBulkArchive() {
    const ids = [...selectedIds]
    setArchiveBusy(true)
    setArchiveProcessed(0)
    setArchiveTotal(ids.length)
    setArchiveErr(null)

    const CHUNK = 500
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        await archiveShipments({ mode: 'ids', ids: chunk })
        if (archiveHookErrRef.current) {
          setArchiveErr(archiveHookErrRef.current)
          addToast('Archive failed: ' + archiveHookErrRef.current, 'error')
          return
        }
        const processed = Math.min(i + CHUNK, ids.length)
        setArchiveProcessed(processed)
      }
      setSelectedIds(new Set())
      await refresh()
      addToast(`Archived ${ids.length} shipment${ids.length === 1 ? '' : 's'}`)
      await logAction('shipment.bulk_archive', null, { count: ids.length })
    } catch (err) {
      const msg = err.message || 'Archive failed'
      setArchiveErr(msg)
      addToast('Archive failed: ' + msg, 'error')
    } finally {
      setArchiveBusy(false)
    }
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
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      {/* Header — Title + Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1
          className="text-2xl font-bold text-slate-900 select-none cursor-default"
          onClick={handleTitleClick}
        >
          Shipments
        </h1>
        <div className="flex items-center gap-3">
          {showClearAll && (
            <button
              onClick={handleClearAll}
              disabled={clearingAll || shipments.length === 0}
              className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {clearingAll ? 'Clearing...' : `Clear All (${shipments.length})`}
            </button>
          )}
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
          {!isViewer && (
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              + Add Shipment
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4 shrink-0">
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
      <div className="flex flex-wrap gap-1 mb-4 bg-white rounded-lg border border-slate-200 p-1 w-fit shrink-0">
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

      {/* Bulk action bar — admins only */}
      {isAdmin && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm shrink-0">
          <span className="font-medium text-blue-800">
            {selectedIds.size} selected
          </span>
          {filtered.length > 0 && selectedIds.size < filtered.length && (
            <button
              onClick={() => setSelectedIds(new Set(filtered.map(s => s.id)))}
              className="text-blue-600 hover:text-blue-800 underline font-medium"
            >
              {selectedIds.size <= effectivePageSize && filtered.length > effectivePageSize
                ? `Select all ${filtered.length} matching current filters`
                : `Select all ${filtered.length} matching`}
            </button>
          )}
          {filtered.length > 0 && selectedIds.size === filtered.length && selectedIds.size > effectivePageSize && (
            <span className="text-blue-600 text-xs">(all matching)</span>
          )}
          <span className="flex-1" />
          {archiveErr && (
            <span className="text-red-600 text-xs shrink-0">{archiveErr}</span>
          )}
          {archiveBusy ? (
            <span className="text-blue-700 font-medium text-xs shrink-0">
              Archiving... {archiveProcessed} of {archiveTotal}
            </span>
          ) : (
            <button
              onClick={() => {
                if (window.confirm(
                  `Archive ${selectedIds.size} shipment${selectedIds.size === 1 ? '' : 's'}?\n\n` +
                  `This hides them from the dashboard. They can be restored from the Archive page.`
                )) {
                  handleBulkArchive()
                }
              }}
              className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shrink-0"
            >
              Archive {selectedIds.size}
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <ShipmentTable
            shipments={paginatedShipments}
            onEdit={isViewer ? undefined : setEditShipment}
            onDelete={isViewer ? undefined : setDeleteTarget}
            onStatusChange={isViewer ? undefined : handleStatusChange}
            readOnly={isViewer}
            selectedIds={isAdmin ? selectedIds : undefined}
            onSelectionChange={isAdmin ? setSelectedIds : undefined}
          />
        )}
      </div>

      {/* Pagination + Count */}
      <div className="mt-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <p className="text-sm text-slate-500">
            {filtered.length > effectivePageSize
              ? `Showing ${page * effectivePageSize + 1}–${Math.min((page + 1) * effectivePageSize, filtered.length)} of ${filtered.length}`
              : `${filtered.length} shipment${filtered.length === 1 ? '' : 's'}`}
            {statusFilter !== 'all' && ` (${statusFilter.replace('_', ' ')})`}
          </p>
          <div className="flex items-center gap-1.5">
            <label htmlFor="rows-per-page" className="text-xs text-slate-500">Rows</label>
            <select
              id="rows-per-page"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="px-2 py-1 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {ROWS_PER_PAGE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
            >
              ← Back
            </button>
            <span className="text-sm text-slate-500">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
            >
              Next →
            </button>
          </div>
        )}
      </div>

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

      {/* Clear All Auth Modal */}
      {showClearPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-lg font-semibold text-red-700 mb-2">Clear All Shipments</h2>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-700 font-medium">Warning: This action is permanent.</p>
              <p className="text-sm text-red-600 mt-1">
                Only the account holder ({ownerEmail}) can authorize clearing all shipment data.
                Enter the account holder&apos;s password to proceed.
              </p>
            </div>
            {clearError && (
              <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                {clearError}
              </div>
            )}
            <form onSubmit={handleClearAuth}>
              <label className="block text-sm font-medium text-slate-700 mb-1">Account Holder Password</label>
              <input
                type="password"
                value={clearPassword}
                onChange={(e) => setClearPassword(e.target.value)}
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 mb-4"
                placeholder="Enter password"
                autoFocus
              />
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => { setShowClearPrompt(false); setClearPassword(''); setClearError('') }}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!clearPassword}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  Authenticate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
