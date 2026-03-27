import { useState, useRef } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { parseExcelFile } from '../utils/excelImport'
import ImportModal from '../components/ImportModal'

export default function ImportPage() {
  const { orgSlug } = useAuth()
  const addToast = useToast()
  const fileInputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [importResult, setImportResult] = useState(null)

  async function handleFileChange(e) {
    const selected = e.target.files[0]
    if (!selected) return
    setFile(selected)

    const ext = selected.name.split('.').pop().toLowerCase()
    if (!['xlsx', 'xls'].includes(ext)) {
      addToast('Please select an Excel file (.xlsx or .xls)', 'error')
      return
    }

    setParsing(true)
    try {
      // Fetch existing tracking numbers for dedup
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      const snap = await getDocs(colRef)
      const existingTracking = snap.docs
        .map((d) => d.data().trackingNumber)
        .filter(Boolean)

      const result = await parseExcelFile(selected, existingTracking)
      setImportResult(result)
    } catch (err) {
      console.error('Parse error:', err)
      addToast(`Failed to parse file: ${err.message}`, 'error')
    } finally {
      setParsing(false)
    }
  }

  function handleClose() {
    setImportResult(null)
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleSuccess() {
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Import Shipments</h1>

      <div className="bg-white rounded-xl border border-slate-200 p-8 max-w-xl">
        <div className="text-center">
          <svg className="mx-auto h-12 w-12 text-slate-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Upload a pharmacy export</h2>
          <p className="text-sm text-slate-500 mb-6">
            Excel files (.xlsx, .xls) with shipment data. Columns are auto-detected.
          </p>

          <label className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 cursor-pointer transition-colors">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {parsing ? 'Parsing…' : 'Choose File'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
              disabled={parsing}
            />
          </label>

          {file && !importResult && !parsing && (
            <div className="mt-4 p-3 bg-slate-50 rounded-lg">
              <p className="text-sm text-slate-700">
                <span className="font-medium">Selected:</span> {file.name}
              </p>
            </div>
          )}

          {parsing && (
            <div className="mt-4 p-3 bg-blue-50 rounded-lg">
              <p className="text-sm text-blue-700">Parsing file…</p>
            </div>
          )}
        </div>
      </div>

      {importResult && (
        <ImportModal
          result={importResult}
          onClose={handleClose}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  )
}
