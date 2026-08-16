import { useState, useMemo } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { useSmsContact } from '../hooks/useSmsContact'
import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'
import { previewTemplate, SENDABLE_TEMPLATE_KEYS, TEMPLATE_LABELS } from '../lib/smsTemplateVars'

function formatPhone(e164) {
  if (!e164 || !e164.startsWith('+1')) return e164 || ''
  const d = e164.slice(2)
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export default function SendTextModal({ slug, shipment, onClose }) {
  const { data: settings, loading: settingsLoading } = useTextMessagingSettings(slug)
  const { contact, derivedState, normalizedPhone, loading: contactLoading } = useSmsContact(slug, shipment?.phone)

  const [templateKey, setTemplateKey] = useState(SENDABLE_TEMPLATE_KEYS[1] || 'delivered')
  const [consent, setConsent] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [sentMessage, setSentMessage] = useState(null)

  const policy = settings?.optInPolicy || 'double_opt_in'
  const isInviteFlow = policy === 'double_opt_in' && derivedState === 'unknown'
  const isResendInvite = policy === 'double_opt_in' && derivedState === 'pending'
  const isOptedOut = derivedState === 'opted_out'

  const effectiveTemplateKey = isInviteFlow || isResendInvite ? 'optInInvite' : templateKey

  const previewBody = useMemo(() => {
    if (!settings?.templates?.[effectiveTemplateKey]) return ''
    return previewTemplate(settings.templates[effectiveTemplateKey], {
      pharmacyName: '<your pharmacy>',
      patientName: shipment?.patientName || '',
      pharmacyPhone: '',
    })
  }, [settings, effectiveTemplateKey, shipment])

  const canSend = (() => {
    if (sending || settingsLoading || contactLoading) return false
    if (isOptedOut) return false
    if (policy === 'manual_confirm' && derivedState !== 'opted_in' && !consent) return false
    return true
  })()

  async function handleSend() {
    setSending(true)
    setError(null)
    try {
      const fn = httpsCallable(getFunctions(), 'sendSms')
      const result = (await fn({
        orgSlug: slug,
        shipmentId: shipment.id,
        templateKey: effectiveTemplateKey,
        consentAffirmed: consent,
      })).data
      if (result?.status === 'already_notified') {
        setSentMessage(`Already texted for this tracking number${result.trackingNumber ? `: ${result.trackingNumber}` : ''}.`)
      } else {
        setSentMessage('Text queued.')
      }
    } catch (e) {
      setError(e?.message || 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Send Text Message</h2>
            <p className="text-sm text-slate-500">{shipment?.patientName} · {formatPhone(normalizedPhone)}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        {isOptedOut && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
            This patient has opted out of text messages and cannot be contacted.
          </div>
        )}

        {!isOptedOut && isInviteFlow && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800 mb-3">
            This patient hasn&apos;t been asked yet. The first text will be an opt-in invitation.
          </div>
        )}

        {!isOptedOut && isResendInvite && (
          <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-800 mb-3">
            Opt-in invite was sent {contact?.invitedAt ? 'previously' : ''}. Awaiting reply.
          </div>
        )}

        {!isOptedOut && !isInviteFlow && !isResendInvite && (
          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-1">Template</label>
            <select
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
              aria-label="Template"
            >
              {SENDABLE_TEMPLATE_KEYS.filter(k => k !== 'optInInvite').map(k => (
                <option key={k} value={k}>{TEMPLATE_LABELS[k]}</option>
              ))}
            </select>
          </div>
        )}

        {!isOptedOut && (
          <div className="mb-3">
            <label className="block text-sm font-medium text-slate-700 mb-1">Preview</label>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 whitespace-pre-wrap">
              {previewBody}
            </div>
          </div>
        )}

        {policy === 'manual_confirm' && !isOptedOut && derivedState !== 'opted_in' && (
          <label className="flex items-center gap-2 mb-3 text-sm">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              aria-label="I have verified consent from this patient."
            />
            <span>I have verified consent from this patient.</span>
          </label>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-2 text-xs text-red-700 mb-3">{error}</div>
        )}
        {sentMessage && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-2 text-xs text-green-700 mb-3">{sentMessage}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
          {!isOptedOut && (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? 'Sending…' :
                isInviteFlow ? 'Send opt-in invite' :
                isResendInvite ? 'Resend invite' :
                'Send'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
