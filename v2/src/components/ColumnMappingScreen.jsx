import { useState, useMemo } from 'react'
import { UNIVERSAL_FIELDS, ADDRESS_SUBFIELDS } from '../utils/excelImport'

const SKIP_VALUE = '__skip__'

export default function ColumnMappingScreen({ headers, sampleRow, initialMapping, onSave, onCancel }) {
  // Build initial state from auto-mapped or saved mapping
  const [fieldMap, setFieldMap] = useState(() => {
    const map = {}
    if (initialMapping) {
      // Reverse the mapping: for each universal field, find which Excel header(s) map to it
      for (const [field, value] of Object.entries(initialMapping)) {
        if (field === 'address' && Array.isArray(value)) continue // handled in addressMap
        map[field] = value
      }
    }
    return map
  })

  const [addressMap, setAddressMap] = useState(() => {
    const amap = { address1: '', address2: '', city: '', state: '', zip: '' }
    if (initialMapping?.address && Array.isArray(initialMapping.address)) {
      const addrCols = initialMapping.address
      // Try to match saved address columns back to sub-fields by position
      ADDRESS_SUBFIELDS.forEach((key, i) => {
        if (addrCols[i]) amap[key] = addrCols[i]
      })
    }
    return amap
  })

  // Which headers are already assigned
  const usedHeaders = useMemo(() => {
    const used = new Set()
    Object.values(fieldMap).forEach((h) => { if (h && h !== SKIP_VALUE) used.add(h) })
    Object.values(addressMap).forEach((h) => { if (h) used.add(h) })
    return used
  }, [fieldMap, addressMap])

  const mappedCount = usedHeaders.size
  const unmappedCount = headers.length - mappedCount

  // Validation: required fields
  const missingRequired = UNIVERSAL_FIELDS
    .filter((f) => f.required && !fieldMap[f.key])
    .map((f) => f.label)

  function handleFieldChange(fieldKey, excelHeader) {
    setFieldMap((prev) => ({ ...prev, [fieldKey]: excelHeader === '' ? undefined : excelHeader }))
  }

  function handleAddressChange(subKey, excelHeader) {
    setAddressMap((prev) => ({ ...prev, [subKey]: excelHeader }))
  }

  function handleSave() {
    const mapping = {}
    for (const { key } of UNIVERSAL_FIELDS) {
      if (key === 'address') continue
      if (fieldMap[key] && fieldMap[key] !== SKIP_VALUE) {
        mapping[key] = fieldMap[key]
      }
    }
    // Build address array from sub-fields
    const addrCols = ADDRESS_SUBFIELDS.map((k) => addressMap[k]).filter(Boolean)
    if (addrCols.length > 0) {
      mapping.address = addrCols
    }
    onSave(mapping)
  }

  function renderDropdown(value, onChange) {
    return (
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      >
        <option value="">— Skip / Don&apos;t Import —</option>
        {headers.map((h) => (
          <option key={h} value={h} disabled={usedHeaders.has(h) && h !== value}>
            {h}
          </option>
        ))}
      </select>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-3xl">
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Map Your Spreadsheet Columns</h2>
      <p className="text-sm text-slate-500 mb-6">
        Match your pharmacy&apos;s column headers to the universal fields. Only mapped columns will be stored.
      </p>

      <div className="space-y-4">
        {UNIVERSAL_FIELDS.filter((f) => !f.isAddress).map(({ key, label, required }) => (
          <div key={key} className="flex items-center gap-4">
            <div className="w-40 shrink-0">
              <span className="text-sm font-medium text-slate-700">{label}</span>
              {required && <span className="text-red-500 ml-1">*</span>}
            </div>
            <div className="flex-1">
              {renderDropdown(fieldMap[key], (v) => handleFieldChange(key, v), label)}
            </div>
            {fieldMap[key] && sampleRow[fieldMap[key]] !== undefined && (
              <div className="text-xs text-slate-400 w-40 truncate">
                e.g. {String(sampleRow[fieldMap[key]])}
              </div>
            )}
          </div>
        ))}

        {/* Address sub-fields */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Address Fields</h3>
          <p className="text-xs text-slate-500 mb-3">
            Map up to 5 columns that will be combined into a single address.
          </p>
          {[
            { key: 'address1', label: 'Address Line 1' },
            { key: 'address2', label: 'Address Line 2' },
            { key: 'city', label: 'City' },
            { key: 'state', label: 'State' },
            { key: 'zip', label: 'Zip Code' },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center gap-4 mb-2">
              <div className="w-40 shrink-0 text-sm text-slate-600">{label}</div>
              <div className="flex-1">
                {renderDropdown(addressMap[key], (v) => handleAddressChange(key, v), label)}
              </div>
              {addressMap[key] && sampleRow[addressMap[key]] !== undefined && (
                <div className="text-xs text-slate-400 w-40 truncate">
                  e.g. {String(sampleRow[addressMap[key]])}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="mt-6 p-3 bg-slate-50 rounded-lg text-sm">
        <span className="text-green-700 font-medium">{mappedCount} columns mapped</span>
        {unmappedCount > 0 && (
          <span className="text-amber-600 ml-2">· {unmappedCount} columns will be scrubbed</span>
        )}
      </div>

      {missingRequired.length > 0 && (
        <div className="mt-2 p-3 bg-red-50 rounded-lg text-sm text-red-700">
          Required fields missing: {missingRequired.join(', ')}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={missingRequired.length > 0}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          Save Mapping &amp; Continue
        </button>
      </div>
    </div>
  )
}
