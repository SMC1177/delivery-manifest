import { useState } from 'react'

export default function ScrubConfirmModal({ fieldLabel, shipmentCount, onConfirm, onCancel }) {
  const [scrubbing, setScrubbing] = useState(false)

  async function handleConfirm() {
    setScrubbing(true)
    try {
      await onConfirm()
    } finally {
      setScrubbing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Scrub Field Data</h3>
            <p className="text-sm text-slate-500">HIPAA data minimization</p>
          </div>
        </div>

        <p className="text-sm text-slate-700 mb-6">
          This will permanently delete <strong>{fieldLabel}</strong> from all{' '}
          <strong>{shipmentCount}</strong> shipments in your organization.{' '}
          <span className="text-red-600 font-medium">This cannot be undone.</span>
        </p>

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={scrubbing}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={scrubbing}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {scrubbing ? 'Scrubbing...' : 'Scrub Data'}
          </button>
        </div>
      </div>
    </div>
  )
}
