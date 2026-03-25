import { useState } from 'react'

export default function ImportPage() {
  const [file, setFile] = useState(null)

  function handleFileChange(e) {
    const selected = e.target.files[0]
    if (selected) setFile(selected)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Import Shipments</h1>

      <div className="bg-white rounded-xl border border-slate-200 p-8 max-w-xl">
        <div className="text-center">
          <svg className="mx-auto h-12 w-12 text-slate-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Upload a file</h2>
          <p className="text-sm text-slate-500 mb-6">
            CSV, Excel, or PDF files accepted. Parsing will be available in Phase 2.
          </p>

          <label className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 cursor-pointer transition-colors">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Choose File
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.pdf"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          {file && (
            <div className="mt-4 p-3 bg-slate-50 rounded-lg">
              <p className="text-sm text-slate-700">
                <span className="font-medium">Selected:</span> {file.name}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                File parsing coming in Phase 2. For now, add shipments manually from the Dashboard.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
