import { useState } from 'react'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { applyDecision } from '../utils/conflictReview'

const DECISION_OPTIONS = [
  { value: 'keepBoth', label: 'Keep both' },
  { value: 'keepOriginal', label: 'Keep original' },
  { value: 'keepMostRecent', label: 'Keep most recent' },
]

// Curation-only conflict review: records operator decisions to
// organizations/{slug}/settings/conflictReview (merge). NEVER writes shipment docs.
export default function ConflictReviewModal({ slug, flagged, onClose, onSaved }) {
  const [decisions, setDecisions] = useState(() => {
    const initial = {}
    for (const row of flagged) {
      initial[`${row.patientKey}\u0000${row.field}`] = 'keepBoth'
    }
    return initial
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function rowKey(row) {
    return `${row.patientKey}\u0000${row.field}`
  }

  function handleDecision(row, decision) {
    setDecisions((prev) => ({ ...prev, [rowKey(row)]: decision }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const conflicts = flagged.map((row) =>
        applyDecision(row, decisions[rowKey(row)] || 'keepBoth'),
      )
      await setDoc(
        doc(db, 'organizations', slug, 'settings', 'conflictReview'),
        { conflicts, updatedAt: serverTimestamp() },
        { merge: true },
      )
      onSaved?.()
      onClose?.()
    } catch {
      setError('Could not save decisions. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">
            {flagged.length} rows flagged
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Identity values changed since last accepted. Decisions are curation records only —
            shipments are never modified.
          </p>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {flagged.map((row) => (
            <div
              key={rowKey(row)}
              className="border border-slate-200 rounded-lg p-4 mb-3 last:mb-0"
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-slate-900 capitalize">{row.field}</p>
                <p className="text-xs text-slate-400">{row.patientKey}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-400 mb-1">Previously accepted</p>
                  <p className="text-sm text-slate-700">{row.oldValue}</p>
                </div>
                <div className="bg-emerald-50 rounded-lg p-3">
                  <p className="text-xs text-emerald-600 mb-1">Incoming</p>
                  <p className="text-sm text-slate-700">{row.newValue}</p>
                </div>
              </div>
              <div className="flex gap-2">
                {DECISION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleDecision(row, option.value)}
                    aria-pressed={decisions[rowKey(row)] === option.value}
                    className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                      decisions[rowKey(row)] === option.value
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {flagged.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-6">No identity conflicts to review.</p>
          )}
        </div>

        {error && <p className="px-6 pb-2 text-sm text-red-600">{error}</p>}

        <div className="px-6 py-4 border-t border-slate-100 flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Decisions'}
          </button>
        </div>
      </div>
    </div>
  )
}
