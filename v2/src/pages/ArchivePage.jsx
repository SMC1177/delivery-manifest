import { useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useOrganization } from '../hooks/useOrganization'
import { useImports } from '../hooks/useImports'
import { useShipments } from '../hooks/useShipments'
import { useArchiveActions } from '../hooks/useArchiveActions'
import { useToast } from '../components/Toast'

function formatImportTimestamp(ts) {
  if (!ts) return '—'
  try {
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)
    return date.toLocaleString()
  } catch {
    return '—'
  }
}

export default function ArchivePage() {
  const { slug } = useParams()
  const { userData } = useAuth()
  const { org } = useOrganization()
  const {
    shipments: archivedShipments,
    loading: shipmentsLoading,
    error: shipmentsError,
    refresh,
  } = useShipments(slug, { archived: true })
  const {
    busy,
    progress,
    error: archiveError,
    archiveShipments,
    restoreShipments,
    backfillArchivedFlag,
    backfillSearchFields,
    deleteArchivedShipments,
    countArchiveTargets,
    countDeleteTargets,
    clearError,
  } = useArchiveActions(slug)
  const {
    imports,
    loading: importsLoading,
    error: importsError,
    refresh: refreshImports,
    busy: importsBusy,
    progress: importsProgress,
    undoImport,
    countUndoTargets,
  } = useImports(slug)
  const addToast = useToast()

  const [cutoffDate, setCutoffDate] = useState('')
  const [eligibleCount, setEligibleCount] = useState(null)
  const [counting, setCounting] = useState(false)
  const [restoringId, setRestoringId] = useState(null)

  // ── Permanent deletion state ──────────────────────────────────
  const [deleteCount, setDeleteCount] = useState(null)
  const [deleteConfirmPhrase, setDeleteConfirmPhrase] = useState('')
  const [deletePhase, setDeletePhase] = useState('idle')
  const [undoImportId, setUndoImportId] = useState(null)
  const [undoCount, setUndoCount] = useState(null)
  const [undoPhase, setUndoPhase] = useState('idle')

  // ── Admin gate ────────────────────────────────────────────────
  const isAdmin = userData?.role === 'admin'

  // ── Backfill handlers ─────────────────────────────────────────
  const handleBackfill = useCallback(async () => {
    try {
      await backfillArchivedFlag()
      addToast('Archive backfill complete. The page will now reflect the updated state.')
      refresh()
    } catch (err) {
      addToast(err.message || 'Backfill failed', 'error')
    }
  }, [backfillArchivedFlag, addToast, refresh])

  const handleSearchBackfill = useCallback(async () => {
    try {
      await backfillSearchFields()
      addToast('Search preparation complete. Faster list loading is now active.')
      refresh()
    } catch (err) {
      addToast(err.message || 'Search preparation failed', 'error')
    }
  }, [backfillSearchFields, addToast, refresh])

  // ── Cutoff handlers ───────────────────────────────────────────
  const handleCountTargets = useCallback(async () => {
    if (!cutoffDate) {
      addToast('Please select a cutoff date first', 'error')
      return
    }
    setCounting(true)
    try {
      const result = await countArchiveTargets({ mode: 'cutoff', cutoffDate })
      setEligibleCount(result.count)
    } catch (err) {
      addToast(err.message || 'Failed to count eligible records', 'error')
    } finally {
      setCounting(false)
    }
  }, [cutoffDate, countArchiveTargets, addToast])

  const handleConfirmArchive = useCallback(async () => {
    if (!cutoffDate) return
    try {
      await archiveShipments({ mode: 'cutoff', cutoffDate })
      addToast('Archiving complete')
      setEligibleCount(null)
      setCutoffDate('')
      refresh()
    } catch (err) {
      addToast(err.message || 'Archiving failed', 'error')
    }
  }, [cutoffDate, archiveShipments, addToast, refresh])

  // Cancel the two-phase flow
  const handleCancelArchive = useCallback(() => {
    setEligibleCount(null)
  }, [])

  // ── Restore handler ───────────────────────────────────────────
  const handleRestore = useCallback(
    async (shipmentId) => {
      setRestoringId(shipmentId)
      try {
        await restoreShipments({ ids: [shipmentId] })
        addToast('Shipment restored')
        refresh()
      } catch (err) {
        addToast(err.message || 'Restore failed', 'error')
      } finally {
        setRestoringId(null)
      }
    },
    [restoreShipments, addToast, refresh],
  )

  // ── Permanent deletion handlers ───────────────────────────────
  const handleDeleteCount = useCallback(async () => {
    setDeletePhase('counting')
    try {
      const count = await countDeleteTargets({})
      setDeleteCount(count)
      setDeletePhase('confirming')
    } catch (err) {
      addToast(err.message || 'Failed to count archived records', 'error')
      setDeletePhase('idle')
    }
  }, [countDeleteTargets, addToast])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteConfirmPhrase !== 'DELETE') return
    setDeletePhase('deleting')
    try {
      await deleteArchivedShipments({ confirmCount: deleteCount })
      addToast(`Permanently deleted ${deleteCount} archived shipment${deleteCount !== 1 ? 's' : ''}`)
      setDeleteCount(null)
      setDeleteConfirmPhrase('')
      setDeletePhase('idle')
      refresh()
    } catch {
      // Count mismatch or other error — reset the flow so the admin must re-count and re-confirm.
      addToast('Deletion failed. The archive may have changed — please re-count and re-confirm.', 'error')
      setDeleteCount(null)
      setDeleteConfirmPhrase('')
      setDeletePhase('idle')
    }
  }, [deleteConfirmPhrase, deleteCount, deleteArchivedShipments, addToast, refresh])

  const handleDeleteCancel = useCallback(() => {
    setDeleteCount(null)
    setDeleteConfirmPhrase('')
    setDeletePhase('idle')
  }, [])

  // ── Undo import handlers ──────────────────────────────────────
  const handleUndoCount = useCallback(async (importId) => {
    setUndoImportId(importId)
    setUndoPhase('counting')
    try {
      const count = await countUndoTargets(importId)
      setUndoCount(count)
      setUndoPhase('confirming')
    } catch (err) {
      addToast(err.message || 'Failed to count records for undo', 'error')
      setUndoPhase('idle')
      setUndoImportId(null)
    }
  }, [countUndoTargets, addToast])

  const handleUndoConfirm = useCallback(async () => {
    setUndoPhase('undoing')
    try {
      await undoImport({ importId: undoImportId, confirmCount: undoCount })
      addToast(`Undo complete: ${undoCount} shipment${undoCount !== 1 ? 's' : ''} removed`)
      setUndoPhase('idle')
      setUndoImportId(null)
      setUndoCount(null)
      refreshImports()
      refresh()
    } catch (err) {
      addToast(err.message || 'Undo failed', 'error')
      setUndoPhase('idle')
      setUndoImportId(null)
      setUndoCount(null)
    }
  }, [undoImportId, undoCount, undoImport, addToast, refreshImports, refresh])

  const handleUndoCancel = useCallback(() => {
    setUndoPhase('idle')
    setUndoImportId(null)
    setUndoCount(null)
  }, [])

  // ── Admin gate ────────────────────────────────────────────────
  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            Admin access required
          </h1>
          <p className="text-slate-600">
            Only organization administrators can manage the archive. Please contact
            your admin if you need access to this feature.
          </p>
        </div>
      </div>
    )
  }

  // ── Error display ─────────────────────────────────────────────
  const displayError = archiveError || shipmentsError || importsError

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Archive Management</h1>

      {/* ── Prepare archiving banner ─────────────────────────── */}
      {org?.archiveBackfillComplete !== true && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-amber-900 mb-1">
                One-time archive preparation needed
              </h2>
              <p className="text-amber-800 text-sm leading-relaxed">
                Records created before the archive feature was added need a
                one-time indexing pass. This will mark existing records with
                their archive status so the archive tools can work correctly.
                This is safe to run and only needs to be done once.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleBackfill}
              disabled={busy}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium
                         hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              {busy ? 'Running…' : 'Run Indexing Pass'}
            </button>
            {busy && progress && progress.processed != null && (
              <span className="text-sm text-amber-700">
                {progress.processed} records processed
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Search preparation banner ────────────────────────── */}
      {org?.searchBackfillComplete !== true && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-amber-900 mb-1">
                Faster delivery list loading — one-time preparation needed
              </h2>
              <p className="text-amber-800 text-sm leading-relaxed">
                Before faster loading for large delivery lists can be turned on,
                existing delivery records need a one-time preparation pass. This
                is safe to run and can be re-run if interrupted. Once complete,
                the delivery list and archive views will load significantly
                faster, especially for organizations with many records.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleSearchBackfill}
              disabled={busy}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium
                         hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              {busy ? 'Running…' : 'Run Preparation Pass'}
            </button>
            {busy && progress && progress.processed != null && (
              <span className="text-sm text-amber-700">
                {progress.processed} records processed
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Error display ────────────────────────────────────── */}
      {displayError && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-4 flex items-start justify-between">
          <div>
            <p className="text-red-800 text-sm font-medium mb-1">Error</p>
            <p className="text-red-700 text-sm">{displayError}</p>
          </div>
          <button
            onClick={clearError}
            className="text-red-500 hover:text-red-700 text-sm font-medium ml-4 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Archive by cutoff ────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Archive by cutoff date
        </h2>
        <p className="text-sm text-slate-600 mb-4">
          Move shipments older than the selected date into the archive. Archived
          shipments are hidden from the main dashboard but can be restored here.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Cutoff date
            </label>
            <input
              type="date"
              value={cutoffDate}
              onChange={(e) => {
                setCutoffDate(e.target.value)
                setEligibleCount(null)
              }}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {eligibleCount === null ? (
            <button
              onClick={handleCountTargets}
              disabled={!cutoffDate || counting || busy}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium
                         hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              {counting ? 'Counting…' : 'Count eligible'}
            </button>
          ) : eligibleCount === 0 ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-600 py-2">
                No shipments match this cutoff date.
              </span>
              <button
                onClick={handleCancelArchive}
                className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
              >
                Reset
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-700 py-2 font-medium">
                {eligibleCount} shipment{eligibleCount !== 1 ? 's' : ''} will be
                archived.
              </span>
              <button
                onClick={handleConfirmArchive}
                disabled={busy}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium
                           hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed
                           transition-colors"
              >
                {busy ? 'Archiving…' : `Archive ${eligibleCount} records`}
              </button>
              <button
                onClick={handleCancelArchive}
                disabled={busy}
                className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700
                           disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent imports ──────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Recent imports
        </h2>
        <p className="text-sm text-slate-600 mb-4">
          Import runs shown here can be undone in full — all shipments created
          by the run will be permanently removed. Only imports performed since
          this feature was added carry the tracking data needed to appear here.
          If you need to remove shipments from an older import, use the bulk
          selection tools on the dashboard instead.
        </p>

        {importsLoading ? (
          <p className="text-sm text-slate-500 py-4">Loading imports…</p>
        ) : imports.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">
            No recent imports found. Import runs will appear here after you
            upload a CSV from the dashboard.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-2 pr-4 font-medium text-slate-500">File</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Records</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Imported</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => {
                  const isThisUndo = undoImportId === imp.id
                  return (
                    <tr key={imp.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 pr-4 text-slate-900 font-medium">
                        {imp.filename || '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-700">
                        {imp.count != null ? imp.count : '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-600 whitespace-nowrap">
                        {formatImportTimestamp(imp.importedAt)}
                      </td>
                      <td className="py-2 pr-4">
                        {isThisUndo && undoPhase === 'counting' ? (
                          <span className="text-xs text-slate-500">Counting…</span>
                        ) : isThisUndo && undoPhase === 'confirming' && undoCount !== null ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-red-700">
                              {undoCount} record{undoCount !== 1 ? 's' : ''} will be removed.
                            </span>
                            <button
                              onClick={handleUndoConfirm}
                              disabled={importsBusy}
                              className="px-2 py-1 text-xs font-medium text-white bg-red-600
                                         rounded hover:bg-red-700 disabled:opacity-50
                                         disabled:cursor-not-allowed transition-colors"
                            >
                              Confirm undo
                            </button>
                            <button
                              onClick={handleUndoCancel}
                              disabled={importsBusy}
                              className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700
                                         disabled:opacity-50 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : isThisUndo && undoPhase === 'undoing' ? (
                          <span className="text-xs text-red-600">
                            Removing…{' '}
                            {importsProgress.processed != null
                              ? `${importsProgress.processed} processed`
                              : ''}
                            {importsProgress.deleted != null
                              ? `, ${importsProgress.deleted} deleted`
                              : ''}
                          </span>
                        ) : (
                          <button
                            onClick={() => handleUndoCount(imp.id)}
                            disabled={importsBusy || undoPhase !== 'idle'}
                            className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50
                                       border border-red-200 rounded
                                       hover:bg-red-100 disabled:opacity-50
                                       disabled:cursor-not-allowed transition-colors"
                          >
                            Undo
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Archived shipments list ──────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">
          Archived shipments
        </h2>

        {shipmentsLoading ? (
          <p className="text-sm text-slate-500 py-4">Loading archived shipments…</p>
        ) : archivedShipments.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">
            No archived shipments. Use the cutoff date tool above to archive
            older records.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-2 pr-4 font-medium text-slate-500">Date</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Patient</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Tracking</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="py-2 pr-4 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {archivedShipments.map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2 pr-4 text-slate-700 whitespace-nowrap">
                      {s.date || '—'}
                    </td>
                    <td className="py-2 pr-4 text-slate-900">{s.patientName || '—'}</td>
                    <td className="py-2 pr-4 text-slate-700 font-mono text-xs">
                      {s.trackingNumber || '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium
                          ${s.status === 'delivered' ? 'bg-green-100 text-green-800' : ''}
                          ${s.status === 'shipped' ? 'bg-blue-100 text-blue-800' : ''}
                          ${s.status === 'pending' ? 'bg-slate-100 text-slate-700' : ''}
                          ${!s.status || s.status === 'unknown' ? 'bg-slate-100 text-slate-500' : ''}
                        `}
                      >
                        {s.status || 'unknown'}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <button
                        onClick={() => handleRestore(s.id)}
                        disabled={restoringId === s.id || busy}
                        className="px-3 py-1 text-xs font-medium text-green-700 bg-green-50
                                   border border-green-200 rounded-lg
                                   hover:bg-green-100 disabled:opacity-50
                                   disabled:cursor-not-allowed transition-colors"
                      >
                        {restoringId === s.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Permanent deletion (danger zone) ─────────────────── */}
        {archivedShipments.length > 0 && !shipmentsLoading && (
          <div className="bg-red-50 border-2 border-red-400 rounded-xl p-6 mt-10">
            <h2 className="text-lg font-semibold text-red-900 mb-2 flex items-center gap-2">
              <span className="text-lg">⚠️</span> Danger Zone — Permanent Deletion
            </h2>
            <p className="text-sm text-red-800 mb-5">
              Permanently delete all archived shipments. This action <strong>cannot be undone</strong>.
              Deleted records are irretrievable. Shipments must be archived before they can be deleted.
            </p>

            {deletePhase === 'idle' && (
              <button
                type="button"
                onClick={handleDeleteCount}
                disabled={busy}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium
                           hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed
                           transition-colors"
              >
                Count archived records for deletion
              </button>
            )}

            {deletePhase === 'counting' && (
              <p className="text-sm text-red-700 animate-pulse">Counting archived records…</p>
            )}

            {(deletePhase === 'confirming' || deletePhase === 'deleting') && deleteCount !== null && (
              <div className="space-y-4">
                {deleteCount === 0 ? (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-red-700">
                      No archived records to delete.
                    </span>
                    <button
                      type="button"
                      onClick={handleDeleteCancel}
                      className="px-3 py-1.5 text-sm text-red-500 hover:text-red-700
                                 border border-red-200 rounded-lg transition-colors"
                    >
                      Reset
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-sm text-red-800 font-medium mb-3">
                        {deleteCount} archived shipment{deleteCount !== 1 ? 's' : ''} will be
                        permanently deleted. <strong>This cannot be undone.</strong>
                      </p>
                    </div>
                    <div>
                      <label
                        htmlFor="delete-confirm-input"
                        className="block text-sm font-medium text-red-800 mb-1"
                      >
                        Type <code className="bg-red-100 px-1.5 py-0.5 rounded text-red-900">DELETE</code> to confirm:
                      </label>
                      <input
                        id="delete-confirm-input"
                        type="text"
                        value={deleteConfirmPhrase}
                        onChange={(e) => setDeleteConfirmPhrase(e.target.value)}
                        placeholder="Type DELETE here"
                        className="border border-red-300 rounded-lg px-3 py-2 text-sm w-64
                                   focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
                        disabled={deletePhase === 'deleting'}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleDeleteConfirm}
                        disabled={deleteConfirmPhrase !== 'DELETE' || deletePhase === 'deleting'}
                        className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-medium
                                   hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed
                                   transition-colors"
                      >
                        {deletePhase === 'deleting'
                          ? 'Deleting…'
                          : `Permanently delete ${deleteCount} record${deleteCount !== 1 ? 's' : ''}`}
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteCancel}
                        disabled={deletePhase === 'deleting'}
                        className="px-3 py-1.5 text-sm text-red-500 hover:text-red-700
                                   disabled:opacity-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
                {deletePhase === 'deleting' && (
                  <p className="text-sm text-red-700">
                    {progress.processed != null ? `${progress.processed} records processed` : 'Working…'}
                    {progress.changed != null ? `, ${progress.changed} deleted` : ''}…
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
