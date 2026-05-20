import { useState, useEffect } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'
import { TEMPLATE_KEYS, TEMPLATE_LABELS, TEMPLATE_DEFAULTS } from '../lib/smsTemplateVars'

function generateToken() {
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function CredentialsForm({ value, onSave, onCancel }) {
  const [draft, setDraft] = useState({
    clientId: '',
    clientSecret: '',
    jwt: '',
    server: value?.server || 'https://platform.ringcentral.com',
    fromNumber: value?.fromNumber || '',
  })

  function update(k, v) { setDraft({ ...draft, [k]: v }) }

  return (
    <div className="space-y-2 border border-slate-200 rounded-lg p-3">
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Client ID"
        value={draft.clientId} onChange={(e) => update('clientId', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Client Secret" type="password"
        value={draft.clientSecret} onChange={(e) => update('clientSecret', e.target.value)} />
      <textarea className="w-full px-2 py-1 border rounded text-sm font-mono" placeholder="JWT credential" rows={3}
        value={draft.jwt} onChange={(e) => update('jwt', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Server (https://platform.ringcentral.com)"
        value={draft.server} onChange={(e) => update('server', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="From Number (+1...)"
        value={draft.fromNumber} onChange={(e) => update('fromNumber', e.target.value)} />
      <div className="flex gap-2">
        <button onClick={() => onSave(draft)} className="px-3 py-1 text-sm rounded bg-blue-600 text-white">Save</button>
        <button onClick={onCancel} className="px-3 py-1 text-sm rounded border">Cancel</button>
      </div>
    </div>
  )
}

export default function TextMessagingSection({ slug, enabledFields, addToast, logAction, currentUid }) {
  const { data, loading, save } = useTextMessagingSettings(slug)
  const [editingCreds, setEditingCreds] = useState(false)
  const [savingCreds, setSavingCreds] = useState(false)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [webhookError, setWebhookError] = useState(null)

  async function handleRegisterWebhook() {
    setWebhookLoading(true)
    setWebhookError(null)
    try {
      const fn = httpsCallable(getFunctions(), 'registerRcWebhook')
      await fn({ orgSlug: slug })
      addToast?.('Webhook registered with RingCentral')
    } catch (e) {
      setWebhookError(e?.message || 'Registration failed')
    } finally {
      setWebhookLoading(false)
    }
  }

  async function handleDeregisterWebhook() {
    setWebhookLoading(true)
    setWebhookError(null)
    try {
      const fn = httpsCallable(getFunctions(), 'deregisterRcWebhook')
      await fn({ orgSlug: slug })
      addToast?.('Webhook removed')
    } catch (e) {
      setWebhookError(e?.message || 'Removal failed')
    } finally {
      setWebhookLoading(false)
    }
  }

  const settings = data || {}
  const enabled = settings.enabled === true
  const phoneEnabled = enabledFields?.includes('phone')
  const credsConfigured = settings.credsConfigured === true

  async function patch(partial, auditField) {
    try {
      await save({ ...partial, updatedAt: new Date(), updatedBy: currentUid })
      if (auditField) await logAction?.('sms.settings_changed', auditField, { field: auditField })
    } catch (e) {
      addToast?.(`Save failed: ${e.message}`, 'error')
    }
  }

  async function saveCreds(rc) {
    setSavingCreds(true)
    try {
      const fn = httpsCallable(getFunctions(), 'saveRingCentralCreds')
      await fn({ orgSlug: slug, ...rc })
      await logAction?.('sms.settings_changed', 'ringcentral', { field: 'ringcentral' })
      setEditingCreds(false)
      addToast?.('RingCentral credentials saved')
    } catch (e) {
      addToast?.(`Failed to save credentials: ${e.message}`, 'error')
    } finally {
      setSavingCreds(false)
    }
  }

  async function regenerateToken() {
    const newToken = generateToken()
    await save({ webhookToken: newToken })
    await logAction?.('sms.webhook_token_regenerated', slug, {})
    addToast?.('Webhook token regenerated')
  }

  useEffect(() => {
    if (!loading && data && !data.templates) {
      save({ templates: TEMPLATE_DEFAULTS })
    }
  }, [loading, data, save])

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Text Messaging</h2>
        <div className="animate-pulse h-4 bg-slate-200 rounded w-48" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-2">Text Messaging</h2>
      <p className="text-sm text-slate-500 mb-3">
        Send SMS updates to patients about their prescription deliveries.
      </p>

      {!phoneEnabled && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 mb-3">
          Phone field is disabled — enable it under Shipment Fields above.
        </div>
      )}

      <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg mb-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Enable text messaging</div>
          <div className="text-xs text-slate-500">Off by default — turn on after configuring credentials below.</div>
        </div>
        <label className="relative cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => patch({ enabled: e.target.checked }, 'enabled')}
            className="sr-only peer"
            disabled={!phoneEnabled}
          />
          <div className="w-10 h-6 bg-slate-200 rounded-full peer-checked:bg-blue-600 transition-colors"></div>
          <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform"></div>
        </label>
      </div>

      {enabled && (
        <>
          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-1">Provider</label>
            <select disabled value="ringcentral" className="px-2 py-1 border rounded text-sm bg-slate-50">
              <option value="ringcentral">RingCentral</option>
            </select>
            <span className="text-xs text-slate-400 ml-2">More providers coming.</span>
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">RingCentral Credentials</span>
              <span className="text-xs">{credsConfigured ? '✓ Configured' : 'Not configured'}</span>
            </div>
            {editingCreds ? (
              <div className="mt-2">
                <CredentialsForm
                  value={{ server: settings.ringcentral?.server, fromNumber: settings.ringcentral?.fromNumber }}
                  onSave={saveCreds}
                  onCancel={() => setEditingCreds(false)}
                />
                {savingCreds && <p className="text-xs text-slate-500 mt-1">Saving…</p>}
              </div>
            ) : (
              <button
                onClick={() => setEditingCreds(true)}
                className="mt-1 px-3 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50"
              >
                {credsConfigured ? 'Edit' : 'Configure'}
              </button>
            )}
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-1">Opt-in Policy</label>
            <div className="space-y-1">
              {[
                ['double_opt_in', 'Double opt-in', 'First text asks for YES reply (TCPA default)'],
                ['auto_opt_in', 'Auto opt-in', 'Assume consent (mail-order with paper consent on file)'],
                ['manual_confirm', 'Manual confirm', 'Staff confirms consent per message in UI'],
              ].map(([val, label, desc]) => (
                <label key={val} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="optInPolicy"
                    value={val}
                    checked={(settings.optInPolicy || 'double_opt_in') === val}
                    onChange={() => patch({ optInPolicy: val }, 'optInPolicy')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-medium">{label}</div>
                    <div className="text-xs text-slate-500">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between p-2 border border-slate-200 rounded-lg mb-2">
            <span className="text-sm">Auto-reply on YES/STOP</span>
            <input
              type="checkbox"
              checked={settings.autoReplyOnYesStop === true}
              onChange={(e) => patch({ autoReplyOnYesStop: e.target.checked }, 'autoReplyOnYesStop')}
            />
          </div>
          <div className="flex items-center justify-between p-2 border border-slate-200 rounded-lg mb-3">
            <span className="text-sm">Auto-reply to non-keyword inbound (redirects to phone)</span>
            <input
              type="checkbox"
              checked={settings.autoReplyToNonKeyword === true}
              onChange={(e) => patch({ autoReplyToNonKeyword: e.target.checked }, 'autoReplyToNonKeyword')}
            />
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-1">Daily message cap</label>
            <input
              type="number" min="1" max="10000"
              value={settings.dailyCap ?? 250}
              onChange={(e) => patch({ dailyCap: Math.max(1, parseInt(e.target.value) || 250) }, 'dailyCap')}
              className="w-24 px-2 py-1 border rounded text-sm"
            />
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-2">Message templates</label>
            <div className="space-y-2">
              {TEMPLATE_KEYS.map((k) => (
                <div key={k}>
                  <div className="text-xs text-slate-500 mb-0.5">{TEMPLATE_LABELS[k]}</div>
                  <textarea
                    rows={2}
                    value={settings.templates?.[k] ?? TEMPLATE_DEFAULTS[k]}
                    onChange={(e) => patch({ templates: { ...settings.templates, [k]: e.target.value } }, 'templates')}
                    className="w-full px-2 py-1 border rounded text-sm font-mono"
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Placeholders: <code>{'{{pharmacyName}}'}</code>, <code>{'{{patientName}}'}</code>, <code>{'{{pharmacyPhone}}'}</code>
            </p>
          </div>

          <div className="mb-2 p-3 bg-slate-50 rounded-lg">
            <h3 className="text-sm font-medium text-slate-700 mb-1">Webhook Setup</h3>
            <p className="text-xs text-slate-600 mb-2">
              Register your webhook so RingCentral can notify the app when patients reply YES or STOP.
            </p>

            {settings.webhookSubscriptionId ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-green-700">
                  <span className="text-green-500">✓</span>
                  <span>Registered with RingCentral</span>
                  {settings.webhookExpiresAt && (
                    <span className="text-xs text-slate-400">
                      (renews automatically)
                    </span>
                  )}
                </div>
                <button
                  onClick={handleDeregisterWebhook}
                  disabled={webhookLoading}
                  className="px-3 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {webhookLoading ? 'Removing…' : 'Remove Registration'}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-slate-500 mb-1">
                  {!settings.webhookToken
                    ? 'Generate a webhook token first, then register.'
                    : 'Not yet registered — click below to connect with RingCentral.'}
                </div>
                {!settings.webhookToken && (
                  <button
                    onClick={regenerateToken}
                    className="px-3 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50"
                  >
                    Generate Token
                  </button>
                )}
                {settings.webhookToken && (
                  <>
                    <div className="text-xs">
                      <span className="font-medium text-slate-700">Token: </span>
                      <code className="bg-white px-1 py-0.5 rounded border text-slate-600 break-all">
                        {settings.webhookToken}
                      </code>
                      <button
                        onClick={regenerateToken}
                        className="ml-2 text-xs underline text-blue-600"
                      >
                        Regenerate
                      </button>
                    </div>
                    <button
                      onClick={handleRegisterWebhook}
                      disabled={webhookLoading || !credsConfigured}
                      className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {webhookLoading ? 'Registering…' : 'Register with RingCentral'}
                    </button>
                    {!credsConfigured && (
                      <p className="text-xs text-amber-600">Configure credentials first.</p>
                    )}
                  </>
                )}
              </div>
            )}
            {webhookError && (
              <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
                {webhookError}
              </div>
            )}
            <div className="mt-2 text-xs text-slate-500">
              Subscribe to event: <code>/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS</code>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
