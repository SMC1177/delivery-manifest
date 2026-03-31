import { useState } from 'react'
import { collection, doc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'

export default function ImportPreviewModal({ result, onClose, onSuccess, onRemap }) {
  const { user, orgSlug } = useAuth()
  const addToast = useToast()
  const [importing, setImporting] = useState(false)

  const { shipments, updates = [], skippedNoTracking, skippedDuplicate, totalRows, preview, unmappedColumns } = result

  async function handleImport() {
    if (!orgSlug || !user) return
    setImporting(true)

    try {
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      const BATCH_SIZE = 500
      let imported = 0
      let updated = 0

      // Insert new shipments
      for (let i = 0; i < shipments.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = shipments.slice(i, i + BATCH_SIZE)
        for (const s of chunk) {
          const ref = doc(colRef)
          batch.set(ref, {
            patientName: s.patientName || '',
            phone: s.phone || '',
            dob: s.dateOfBirth || '',
            address: s.address || '',
            rxNumbers: s.rxNumbers || [],
            trackingNumber: s.trackingNumber || '',
            carrier: s.carrier || 'ups',
            date: s.date || '',
            refillNumber: s.refillNumber || '',
            notes: s.notes || '',
            status: 'pending',
            redeliver: false,
            deliveredAt: null,
            shippedAt: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            createdBy: user.uid,
            updatedBy: user.uid,
          })
        }
        await batch.commit()
        imported += chunk.length
      }

      // Update existing shipments with newer dates
      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = updates.slice(i, i + BATCH_SIZE)
        for (const s of chunk) {
          const ref = doc(db, 'organizations', orgSlug, 'shipments', s.shipmentId)
          batch.update(ref, {
            patientName: s.patientName || '',
            phone: s.phone || '',
            dob: s.dateOfBirth || '',
            address: s.address || '',
            rxNumbers: s.rxNumbers || [],
            date: s.date || '',
            refillNumber: s.refillNumber || '',
            notes: s.notes || '',
            carrier: s.carrier || 'ups',
            updatedAt: serverTimestamp(),
            updatedBy: user.uid,
          })
        }
        await batch.commit()
        updated += chunk.length
      }

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
            {unmappedColumns && unmappedColumns.length > 0 && (
              <p className="text-slate-500">{unmappedColumns.length} columns scrubbed (not stored)</p>
            )}
          </div>
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
            disabled={importing || shipments.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {importing ? 'Importing…' : `Import ${shipments.length} Records`}
          </button>
        </div>
      </div>
    </div>
  )
}
