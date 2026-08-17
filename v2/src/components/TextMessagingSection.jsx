import { useState, useEffect, useRef } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'
import { TEMPLATE_KEYS, TEMPLATE_LABELS, TEMPLATE_DEFAULTS, TEMPLATE_LANGUAGES, TEMPLATE_DRAFT_TRANSLATIONS } from '../lib/smsTemplateVars'

// Server-enforced requirements, keyed like TEMPLATE_KEYS. Mirrors
// functions/sms-templates.js validateOptInInvite (case-insensitive substring
// test for `yes` and `stop`) so the UI agrees with the send-time check.
// Advisory only — the server remains the enforcement point.
const TEMPLATE_REQUIREMENTS = {
  optInInvite: {
    note: 'Must include the words YES and STOP — patients reply YES to opt in and STOP to opt out.',
    words: ['YES', 'STOP'],
  },
}

function generateToken() {
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function formatCredsDate(d) {
  if (!d) return 'Unknown'
  try {
    const dt = typeof d.toDate === 'function' ? d.toDate() : new Date(d)
    if (isNaN(dt.getTime())) return 'Unknown'
    return dt.toLocaleString()
  } catch {
    return 'Unknown'
  }
}

function CredentialsForm({ value, onSave, onCancel }) {
  const credsConfigured = value?.credsConfigured === true
  const [showingReplace, setShowingReplace] = useState(false)

  const [draft, setDraft] = useState({
    clientId: '',
    clientSecret: '',
    jwt: '',
    server: value?.server || 'https://platform.ringcentral.com',
    fromNumber: value?.fromNumber || '',
  })

  function update(k, v) { setDraft({ ...draft, [k]: v }) }

  // Configured state: show summary with Replace action
  if (credsConfigured && !showingReplace) {
    return (
      <div className="space-y-2 border border-slate-200 rounded-lg p-3">
        <div className="flex items-center gap-2">
          <span className="text-green-600 font-medium text-sm">✓ Configured</span>
        </div>
        <div className="text-xs text-slate-500">
          Last updated: {formatCredsDate(value?.credsUpdatedAt)}
          {value?.credsUpdatedBy ? ` by ${value.credsUpdatedBy}` : ''}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowingReplace(true)}
            className="px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-50">
            Replace credentials
          </button>
          <button type="button" onClick={onCancel} className="px-3 py-1 text-sm rounded border">Cancel</button>
        </div>
      </div>
    )
  }

  // First-time setup or replace: show empty form with autofill disabled
  return (
    <div className="space-y-2 border border-slate-200 rounded-lg p-3">
      {credsConfigured && showingReplace && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          All three credential values must be re-entered together — partial saves are rejected.
        </p>
      )}
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Client ID"
        name="sms-provider-client-id" autoComplete="off"
        value={draft.clientId} onChange={(e) => update('clientId', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Client Secret" type="password"
        name="sms-provider-secret" autoComplete="new-password"
        value={draft.clientSecret} onChange={(e) => update('clientSecret', e.target.value)} />
      <textarea className="w-full px-2 py-1 border rounded text-sm font-mono" placeholder="JWT credential" rows={3}
        name="sms-provider-jwt" autoComplete="off"
        value={draft.jwt} onChange={(e) => update('jwt', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="Server (https://platform.ringcentral.com)"
        value={draft.server} onChange={(e) => update('server', e.target.value)} />
      <input className="w-full px-2 py-1 border rounded text-sm" placeholder="From Number (+1...)"
        value={draft.fromNumber} onChange={(e) => update('fromNumber', e.target.value)} />
      <div className="flex gap-2">
        <button type="button" onClick={() => onSave(draft)}
          className="px-3 py-1 text-sm rounded bg-blue-600 text-white">Save</button>
        {showingReplace ? (
          <button type="button" onClick={() => setShowingReplace(false)}
            className="px-3 py-1 text-sm rounded border">Cancel</button>
        ) : (
          <button type="button" onClick={onCancel} className="px-3 py-1 text-sm rounded border">Cancel</button>
        )}
      </div>
    </div>
  )
}

function TemplateTextarea({ label, stored, onCommit, requirement }) {
  const [value, setValue] = useState(stored)
  const [focused, setFocused] = useState(false)
  const baseRef = useRef(stored)        // server value our last write/seed was based on
  const committedRef = useRef(null)     // value of an in-flight write, null when none

  // Keep the draft in sync with the server, but never while the user is typing,
  // and never while our own write is still propagating (stored lags by a round-trip).
  useEffect(() => {
    if (focused) return
    if (committedRef.current !== null) {
      if (stored === committedRef.current) {
        // Our write came back — we're synced again.
        baseRef.current = stored
        committedRef.current = null
      } else if (stored !== baseRef.current) {
        // Server moved on from our base to a different value (e.g. another admin).
        setValue(stored)
        baseRef.current = stored
        committedRef.current = null
      }
      return
    }
    if (stored !== value) {
      setValue(stored)
      baseRef.current = stored
    }
  }, [stored, focused, value])

  function handleBlur() {
    setFocused(false)
    const lastWritten = committedRef.current ?? baseRef.current
    if (value !== lastWritten) {
      committedRef.current = value
      onCommit(value)
    }
  }

  // Advisory check mirroring validateOptInInvite: case-insensitive substring
  // test per required word, driven off the local draft so it updates as they type.
  const missingWords = requirement
    ? requirement.words.filter((w) => !value.toLowerCase().includes(w.toLowerCase()))
    : []

  return (
    <div>
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      {requirement && (
        <p className="text-xs text-amber-700 mb-1">{requirement.note}</p>
      )}
      <textarea
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        className="w-full px-2 py-1 border rounded text-sm font-mono"
      />
      {missingWords.length > 0 && (
        <p className="text-xs text-red-600 mt-1" role="alert">
          Must include the word{missingWords.length > 1 ? 's' : ''} {missingWords.join(' and ')}
        </p>
      )}
    </div>
  )
}


// Slice 3 (w8-6 UI): second-language template row (es/fr). Commits to
// settings.templatesByLang[lang][key] on blur. Drafts are surfaced ONLY via an
// explicit "Use draft" action — never auto-saved, so operator approval is real.
function SecondLanguageTemplateRow({ language, label, stored, draft, onCommit }) {
  const langLabel = TEMPLATE_LANGUAGES.find((l) => l.value === language)?.label || language
  const [value, setValue] = useState(stored)
  const [focused, setFocused] = useState(false)
  const baseRef = useRef(stored)
  const committedRef = useRef(null)
  const draftAppliedRef = useRef(false) // a draft was explicitly applied; don't clobber

  useEffect(() => {
    if (focused) return
    if (draftAppliedRef.current) return // operator-approved draft: keep it until blur
    if (committedRef.current !== null) {
      if (stored === committedRef.current) {
        baseRef.current = stored
        committedRef.current = null
      } else if (stored !== baseRef.current) {
        setValue(stored)
        baseRef.current = stored
        committedRef.current = null
      }
      return
    }
    if (stored !== value) {
      setValue(stored)
      baseRef.current = stored
    }
  }, [stored, focused, value])

  function handleBlur() {
    setFocused(false)
    const lastWritten = committedRef.current ?? baseRef.current
    if (value !== lastWritten) {
      committedRef.current = value
      onCommit(value)
    }
    draftAppliedRef.current = false
  }

  function useDraft() {
    draftAppliedRef.current = true
    setValue(draft)
    // Deliberately NO onCommit: revealing a draft is not approval.
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <div className="text-xs text-slate-500">{langLabel} — {label}</div>
        {draft && stored === '' && (
          <button
            type="button"
            onClick={useDraft}
            className="text-xs text-blue-600 hover:text-blue-800 underline"
          >
            Use draft
          </button>
        )}
      </div>
      <textarea
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        aria-label={`${langLabel} — ${label}`}
        className="w-full px-2 py-1 border rounded text-sm font-mono"
      />
    </div>
  )
}

export default function TextMessagingSection({ slug, enabledFields, addToast, logAction, currentUid }) {
  const { data, loading, save } = useTextMessagingSettings(slug)
  const [editingCreds, setEditingCreds] = useState(false)
  const [savingCreds, setSavingCreds] = useState(false)
  const [secondLanguage, setSecondLanguage] = useState('en') // slice 3: English + one additional language
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
                  value={{
                    server: settings.ringcentral?.server,
                    fromNumber: settings.ringcentral?.fromNumber,
                    credsConfigured: settings.credsConfigured,
                    credsUpdatedAt: settings.credsUpdatedAt,
                    credsUpdatedBy: settings.credsUpdatedBy,
                  }}
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
            <label className="block text-sm font-medium text-slate-700 mb-1">Default message language</label>
            <select
              aria-label="Default message language"
              value={settings.defaultLanguage || 'en'}
              onChange={(e) => patch({ defaultLanguage: e.target.value }, 'defaultLanguage')}
              className="px-2 py-1 border rounded text-sm bg-white"
            >
              {TEMPLATE_LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>{lang.label}</option>
              ))}
            </select>
            <p className="text-xs text-slate-400 mt-1">Fallback language for patients without their own preference.</p>
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
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-slate-700">Message templates</span>
              <span className="text-xs text-slate-400">— English plus one additional language</span>
            </div>
            <div className="flex gap-1 mb-3 bg-slate-100 rounded-lg p-1 w-fit">
              {TEMPLATE_LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  type="button"
                  onClick={() => setSecondLanguage(lang.value === 'en' ? 'en' : lang.value)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    secondLanguage === lang.value
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
            <div className="space-y-4">
              {TEMPLATE_KEYS.map((k) => (
                <div key={k} className="border border-slate-200 rounded-lg p-3">
                  <div className="grid gap-3">
                    <TemplateTextarea
                      label={`English — ${TEMPLATE_LABELS[k]}`}
                      stored={settings.templates?.[k] ?? TEMPLATE_DEFAULTS[k]}
                      requirement={TEMPLATE_REQUIREMENTS[k]}
                      onCommit={(v) => patch({ templates: { ...settings.templates, [k]: v } }, 'templates')}
                    />
                    {secondLanguage !== 'en' && (
                      <SecondLanguageTemplateRow
                        language={secondLanguage}
                        label={TEMPLATE_LABELS[k]}
                        stored={settings.templatesByLang?.[secondLanguage]?.[k] ?? ''}
                        draft={TEMPLATE_DRAFT_TRANSLATIONS[secondLanguage]?.[k] ?? ''}
                        onCommit={(v) => patch({ templatesByLang: { ...(settings.templatesByLang || {}), [secondLanguage]: { ...(settings.templatesByLang?.[secondLanguage] || {}), [k]: v } } }, 'templatesByLang')}
                      />
                    )}
                  </div>
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
