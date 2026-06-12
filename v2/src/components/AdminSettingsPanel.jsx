// v2/src/components/AdminSettingsPanel.jsx
// Remote-assist: view/fix any org's settings from the admin dashboard.
// Secrets arrive MASKED ('•••set') and saving a masked value leaves the
// stored secret untouched (server strips markers). Every save requires a
// reason — it lands in the platformAudit trail.
import { useEffect, useState } from 'react'
import { useAdminData } from '../hooks/useAdminData'

export default function AdminSettingsPanel({ orgSlug }) {
  const { orgSettings, settingsLoading, settingsError, fetchOrgSettings, saveOrgSettings } = useAdminData()

  const [reason, setReason] = useState('')
  const [savingSection, setSavingSection] = useState(null) // 'org' or docId
  const [saveStatus, setSaveStatus] = useState({}) // { section: 'saving' | 'success' | { error: msg } }

  useEffect(() => {
    if (!orgSettings?.[orgSlug]) {
      fetchOrgSettings(orgSlug)
    }
  }, [orgSlug, orgSettings, fetchOrgSettings])

  const data = orgSettings?.[orgSlug]

  const handleSave = async (sectionTarget, textareaValue) => {
    const trimmedReason = reason.trim()
    if (!trimmedReason) return

    let parsed
    try {
      parsed = JSON.parse(textareaValue)
    } catch {
      setSaveStatus(prev => ({ ...prev, [sectionTarget]: { error: 'Invalid JSON' } }))
      return
    }

    setSavingSection(sectionTarget)
    setSaveStatus(prev => ({ ...prev, [sectionTarget]: 'saving' }))
    try {
      await saveOrgSettings(orgSlug, sectionTarget, parsed, trimmedReason)
      setSaveStatus(prev => ({ ...prev, [sectionTarget]: 'success' }))
      setTimeout(() => {
        setSaveStatus(prev => {
          const next = { ...prev }
          delete next[sectionTarget]
          return next
        })
      }, 3000)
    } catch (err) {
      setSaveStatus(prev => ({ ...prev, [sectionTarget]: { error: err.message || 'Save failed' } }))
    } finally {
      setSavingSection(null)
    }
  }

  const isSaving = savingSection !== null

  if (settingsLoading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (settingsError && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-6 mb-6">
        <p className="font-medium">Error loading settings</p>
        <p className="text-sm mt-1">{settingsError}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-500">
        No settings docs.
      </div>
    )
  }

  const { org, settingsDocs } = data

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6" data-testid={`admin-settings-panel-${orgSlug}`}>
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Settings: {orgSlug}</h2>
      <p className="text-xs text-slate-500 mb-4">
        Values shown as •••set are stored secrets — leave them as-is to keep the stored value; type a new value to replace it.
      </p>

      {/* Reason input */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-slate-700 mb-1">Reason for change (required, audited)</label>
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Why are you changing this? (required, audited)"
          data-testid={`admin-settings-reason-${orgSlug}`}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Org fields */}
      <SectionEditor
        label="Org fields"
        sectionTarget="org"
        initialValue={JSON.stringify(org, null, 2)}
        reason={reason}
        isSaving={isSaving}
        saveStatus={saveStatus}
        onSave={handleSave}
        dataTestIdPrefix={`admin-settings-save-${orgSlug}-org`}
        textareaTestId="admin-settings-doc-org"
      />

      {/* Settings docs */}
      {settingsDocs && Object.entries(settingsDocs).map(([docId, doc]) => (
        <SectionEditor
          key={docId}
          label={`Settings doc: ${docId}`}
          sectionTarget={`settings/${docId}`}
          initialValue={JSON.stringify(doc, null, 2)}
          reason={reason}
          isSaving={isSaving}
          saveStatus={saveStatus}
          onSave={handleSave}
          dataTestIdPrefix={`admin-settings-save-${orgSlug}-${docId}`}
          textareaTestId={`admin-settings-doc-${docId}`}
        />
      ))}
    </div>
  )
}

function SectionEditor({ label, sectionTarget, initialValue, reason, saveStatus, onSave, dataTestIdPrefix, textareaTestId }) {
  const [value, setValue] = useState(initialValue)
  const status = saveStatus[sectionTarget]

  const isSectionSaving = status === 'saving'
  const disabled = isSectionSaving || !reason.trim()

  return (
    <div className="mb-6">
      <h3 className="text-sm font-medium text-slate-700 mb-2">{label}</h3>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        data-testid={textareaTestId}
        rows={8}
        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={() => onSave(sectionTarget, value)}
          disabled={disabled}
          data-testid={dataTestIdPrefix}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {isSectionSaving ? 'Saving...' : 'Save'}
        </button>
        {status === 'success' && (
          <span className="text-sm text-green-600">Saved — audited</span>
        )}
        {status && status.error && (
          <span className="text-sm text-red-600">{status.error}</span>
        )}
      </div>
    </div>
  )
}
