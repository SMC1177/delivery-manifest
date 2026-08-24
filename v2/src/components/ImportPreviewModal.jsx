import { useState, useEffect } from 'react'
import ConflictReviewModal from './ConflictReviewModal'
import { collection, doc, writeBatch, serverTimestamp, setDoc, getDocs, query, orderBy, limit } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'
import { collectFacilityNames, upsertFacilities } from '../utils/facilities'
import { filterWarnedRows, compareHeaders } from '../utils/excelImport'

export default function ImportPreviewModal({ result, onClose, onSuccess, onRemap, filename }) {
  const { user, orgSlug } = useAuth()
  const addToast = useToast()
  const [importing, setImporting] = useState(false)
  const [showConflictReview, setShowConflictReview] = useState(false)
  const [includeWarned, setIncludeWarned] = useState({ repeatedRx: false, blankIdentity: false })

  const { shipments, updates = [], skippedNoTracking, skippedDuplicate, totalRows, preview, unmappedColumns, pendingCreated = 0, trackingMerged = 0, needsReview = 0 } = result
  const { shipments: displayShipments, updates: displayUpdates } = filterWarnedRows(result, includeWarned)
  const [headersChanged, setHeadersChanged] = useState({ added: [], removed: [] })

  useEffect(() => {
    let cancelled = false
    async function loadPrevHeaders() {
      if (!orgSlug) return
      try {
        const q = query(collection(db, 'organizations', orgSlug, 'imports'), orderBy('importedAt', 'desc'), limit(1))
        const snap = await getDocs(q)
        if (cancelled) return
        const prev = snap.docs[0]?.data()
        if (prev && Array.isArray(prev.headers) && prev.headers.length > 0 && Array.isArray(result.headers) && result.headers.length > 0) {
          const diff = compareHeaders(prev.headers, result.headers)
          if (diff.added.length > 0 || diff.removed.length > 0) setHeadersChanged(diff)
        }
      } catch (err) {
        console.warn('Failed to load previous import headers:', err)
      }
    }
    loadPrevHeaders()
    return () => { cancelled = true }
  }, [orgSlug])

  async function handleImport() {
    if (!orgSlug || !user) return
    setImporting(true)
    const { shipments: writeShipments, updates: writeUpdates } = filterWarnedRows(result, includeWarned)

    try {
      const importId = crypto.randomUUID()
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      const BATCH_SIZE = 500
      let imported = 0
      let updated = 0

      // Insert new shipments
      for (let i = 0; i < writeShipments.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = writeShipments.slice(i, i + BATCH_SIZE)
        for (const s of chunk) {
          const ref = doc(colRef)
          batch.set(ref, {
            patientName: s.patientName || '',
            patientNameLower: (s.patientName || '').trim().toLowerCase(),
            phone: s.phone || '',
            dob: s.dateOfBirth || '',
            address: s.address || '',
            rxNumbers: s.rxNumbers || [],
            trackingNumber: s.trackingNumber || '',
            carrier: s.carrier || 'ups',
            date: s.date || '',
            refillNumber: s.refillNumber || '',
            notes: s.notes || '',
            facilityName: s.facilityName ?? '',
            dateWritten: s.dateWritten ?? '',
            dateFilled: s.dateFilled ?? '',
            effectiveDate: s.effectiveDate ?? '',
            refillDate: s.refillDate ?? '',
            drugDescription: s.drugDescription ?? '',
            drugGpi: s.drugGpi ?? '',
            ndc: s.ndc ?? '',
            quantityDispensed: s.quantityDispensed ?? '',
            daysSupply: s.daysSupply ?? '',
            prescriptionLength: s.prescriptionLength ?? '',
            refillsAuthorized: s.refillsAuthorized ?? '',
            refillsRemaining: s.refillsRemaining ?? '',
            awpCost: s.awpCost ?? '',
            copayAmount: s.copayAmount ?? '',
            deliveryMethod: s.deliveryMethod ?? '',
            orderDescription: s.orderDescription ?? '',
            prescriberFirstName: s.prescriberFirstName ?? '',
            prescriberLastName: s.prescriberLastName ?? '',
            prescriberAddress1: s.prescriberAddress1 ?? '',
            prescriberCity: s.prescriberCity ?? '',
            prescriberState: s.prescriberState ?? '',
            status: 'pending',
            redeliver: false,
            deliveredAt: null,
            shippedAt: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            createdBy: user.uid,
            updatedBy: user.uid,
            archived: false,
            importId,
            importedAt: serverTimestamp(),
            importFilename: filename || '',
          })
        }
        await batch.commit()
        imported += chunk.length
      }

      // Update existing shipments with newer dates
      for (let i = 0; i < writeUpdates.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = writeUpdates.slice(i, i + BATCH_SIZE)
        for (const s of chunk) {
          const ref = doc(db, 'organizations', orgSlug, 'shipments', s.shipmentId)
          const updateData = {
            patientName: s.patientName || '',
            patientNameLower: (s.patientName || '').trim().toLowerCase(),
            phone: s.phone || '',
            dob: s.dateOfBirth || '',
            address: s.address || '',
            rxNumbers: s.rxNumbers || [],
            date: s.date || '',
            refillNumber: s.refillNumber || '',
            notes: s.notes || '',
            facilityName: s.facilityName ?? '',
            dateWritten: s.dateWritten ?? '',
            dateFilled: s.dateFilled ?? '',
            effectiveDate: s.effectiveDate ?? '',
            refillDate: s.refillDate ?? '',
            drugDescription: s.drugDescription ?? '',
            drugGpi: s.drugGpi ?? '',
            ndc: s.ndc ?? '',
            quantityDispensed: s.quantityDispensed ?? '',
            daysSupply: s.daysSupply ?? '',
            prescriptionLength: s.prescriptionLength ?? '',
            refillsAuthorized: s.refillsAuthorized ?? '',
            refillsRemaining: s.refillsRemaining ?? '',
            awpCost: s.awpCost ?? '',
            copayAmount: s.copayAmount ?? '',
            deliveryMethod: s.deliveryMethod ?? '',
            orderDescription: s.orderDescription ?? '',
            prescriberFirstName: s.prescriberFirstName ?? '',
            prescriberLastName: s.prescriberLastName ?? '',
            prescriberAddress1: s.prescriberAddress1 ?? '',
            prescriberCity: s.prescriberCity ?? '',
            prescriberState: s.prescriberState ?? '',
            updatedAt: serverTimestamp(),
            updatedBy: user.uid,
          }
          const tracking = s.trackingNumber?.trim()
          if (tracking) {
            updateData.trackingNumber = tracking
            updateData.carrier = s.carrier || 'ups'
          }
          batch.update(ref, updateData)
        }
        await batch.commit()
        updated += chunk.length
      }

      // Write companion import record after shipments succeed
      await setDoc(doc(db, 'organizations', orgSlug, 'imports', importId), {
        filename: filename || '',
        headers: result.headers || [],
        count: imported,
        importedAt: serverTimestamp(),
        importedBy: user.uid,
      })

      // Ensure facilities exist for rows this import processed (new + updated)
      const names = collectFacilityNames([...writeShipments, ...writeUpdates])
      const { failed } = await upsertFacilities(db, orgSlug, names)
      if (failed.length > 0) console.warn('facilities upsert incomplete — will self-heal on next import:', failed)

      const parts = []
      if (imported > 0) parts.push(`${imported} new`)
      if (updated > 0) parts.push(`${updated} updated`)
      addToast(`Import complete: ${parts.join(', ')}`, 'success')
      onSuccess?.()
      onClose()
    } catch (err) {
      console.error('Import error:', err)
      addToast(`Import failed: ${err.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        <div className="p-6 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Import Preview</h2>
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-slate-700">
              Found <span className="font-semibold">{totalRows}</span> rows —{' '}
              <span className="font-semibold text-green-700">{shipments.length}</span> new to import
              {updates.length > 0 && (
                <>, <span className="font-semibold text-blue-700">{updates.length}</span> to update (newer date)</>
              )}
            </p>
            {skippedNoTracking > 0 && (
              <p className="text-amber-600">{skippedNoTracking} skipped (no tracking number)</p>
            )}
            {skippedDuplicate > 0 && (
              <p className="text-amber-600">{skippedDuplicate} skipped (unchanged duplicates)</p>
            )}
            {result.warnings?.repeatedRx?.length > 0 && (
              <p className="text-amber-600">
                {result.warnings.repeatedRx.reduce((n, w) => n + w.rows.length, 0)} rows carry a prescription number repeated across many patients ({result.warnings.repeatedRx.map(w => w.value).join(', ')}) — excluded from this import{' '}
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={includeWarned.repeatedRx} onChange={() => setIncludeWarned(prev => ({ ...prev, repeatedRx: !prev.repeatedRx }))} />
                  Include anyway
                </label>
              </p>
            )}
            {result.warnings?.blankIdentity?.rows?.length > 0 && (
              <p className="text-amber-600">
                {result.warnings.blankIdentity.rows.length} rows missing patient name and DOB — excluded from this import{' '}
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={includeWarned.blankIdentity} onChange={() => setIncludeWarned(prev => ({ ...prev, blankIdentity: !prev.blankIdentity }))} />
                  Include anyway
                </label>
              </p>
            )}
            {pendingCreated > 0 && (
              <p className="text-amber-600">{pendingCreated} awaiting tracking</p>
            )}
            {trackingMerged > 0 && (
              <p className="text-green-700">{trackingMerged} tracking numbers matched to existing deliveries</p>
            )}
            {needsReview > 0 && (
              <>
              <p className="text-red-700 font-semibold">{needsReview} need review — matched more than one delivery</p>
              <button
                type="button"
                onClick={() => setShowConflictReview(true)}
                className="mt-1 text-sm text-blue-600 hover:text-blue-800 underline"
              >
                Review conflicts
              </button>
              </>
            )}
            {(headersChanged.added.length > 0 || headersChanged.removed.length > 0) && (
              <p className="text-slate-500">Columns changed since last import — added: {headersChanged.added.length > 0 ? headersChanged.added.join(', ') : '—'} removed: {headersChanged.removed.length > 0 ? headersChanged.removed.join(', ') : '—'}</p>
            )}
            {unmappedColumns && unmappedColumns.length > 0 && (
              <p className="text-slate-500">{unmappedColumns.length} columns scrubbed (not stored)</p>
            )}
          </div>
          {showConflictReview && (
            <ConflictReviewModal
              slug={orgSlug}
              flagged={[]}
              onClose={() => setShowConflictReview(false)}
              onSaved={() => setShowConflictReview(false)}
            />
          )}
          {onRemap && (
            <button
              onClick={onRemap}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800 underline"
            >
              Re-map Columns
            </button>
          )}
        </div>

        {preview && preview.length > 0 && (
          <div className="flex-1 overflow-auto p-6">
            <p className="text-xs font-medium text-slate-500 uppercase mb-2">
              Preview (first {preview.length} rows)
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 px-2 font-medium text-slate-600">Date</th>
                    <th className="text-left py-2 px-2 font-medium text-slate-600">Patient Name</th>
                    <th className="text-left py-2 px-2 font-medium text-slate-600">RX #</th>
                    <th className="text-left py-2 px-2 font-medium text-slate-600">Tracking #</th>
                    <th className="text-left py-2 px-2 font-medium text-slate-600">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((s, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 px-2 text-slate-700">{s.date || '—'}</td>
                      <td className="py-2 px-2 text-slate-700">{s.patientName || '—'}</td>
                      <td className="py-2 px-2 text-slate-700">{s.rxNumbers?.join(', ') || '—'}</td>
                      <td className="py-2 px-2 text-slate-700 font-mono text-xs">{s.trackingNumber || '—'}</td>
                      <td className="py-2 px-2 text-slate-700 truncate max-w-[200px]">{s.address || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="p-6 border-t border-slate-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={importing}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing || (displayShipments.length === 0 && displayUpdates.length === 0)}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {importing ? 'Importing…' : `Import ${displayShipments.length} Records${displayUpdates.length > 0 ? ` + ${displayUpdates.length} Updates` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
