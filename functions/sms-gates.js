export const GATE_ERRORS = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN_ROLE: 'forbidden_role',
  MESSAGING_DISABLED: 'messaging_disabled',
  CREDS_MISSING: 'creds_missing',
  PHONE_FIELD_DISABLED: 'phone_field_disabled',
  SHIPMENT_NO_PHONE: 'shipment_no_phone',
  OPT_IN_REQUIRED: 'opt_in_required',
  OPTED_OUT: 'opted_out',
  CONSENT_NOT_AFFIRMED: 'consent_not_affirmed',
  RATE_LIMITED: 'rate_limited',
  TEMPLATE_INVALID: 'template_invalid',
}

const USER_MESSAGES = {
  unauthenticated: 'You must be signed in.',
  forbidden_role: 'Only admins and staff can send text messages.',
  messaging_disabled: 'Text messaging is not enabled for this organization.',
  creds_missing: 'RingCentral credentials are not fully configured. Contact your admin.',
  phone_field_disabled: 'The Phone field is disabled for this organization. Enable it in Settings.',
  shipment_no_phone: 'This shipment does not have a phone number.',
  opt_in_required: 'This patient has not opted in to text messages yet. Send the opt-in invite first.',
  opted_out: 'This patient has opted out of text messages and cannot be contacted.',
  consent_not_affirmed: 'You must confirm patient consent before sending.',
  rate_limited: 'Daily SMS limit reached. Contact your admin to raise the cap.',
  template_invalid: 'The message template is not valid. Check Settings.',
}

export function userMessageFor(code) {
  return USER_MESSAGES[code] || 'Could not send message.'
}

function fail(code) {
  return { ok: false, code, message: USER_MESSAGES[code] }
}

// May THIS CALLER send a text? Only a signed-in admin or staff member may press the
// button. The automated queue path has no caller and never asks this question.
export function checkCallerMayText({ auth, memberRole }) {
  if (!auth || !auth.uid) return fail(GATE_ERRORS.UNAUTHENTICATED)
  if (memberRole !== 'admin' && memberRole !== 'staff') return fail(GATE_ERRORS.FORBIDDEN_ROLE)

  return { ok: true }
}

// May THIS ORG text THIS SHIPMENT? Reads nothing about the caller, deliberately: the
// scheduled drain calls this alone, so a stray auth or memberRole read here would
// silently refuse every automated message.
export function checkOrgMayText({ settings, org, shipment }) {
  if (!settings || settings.enabled !== true) return fail(GATE_ERRORS.MESSAGING_DISABLED)

  const enabledFields = org?.settings?.enabledFields || []
  if (!enabledFields.includes('phone')) return fail(GATE_ERRORS.PHONE_FIELD_DISABLED)

  const rc = settings.ringcentral || {}
  if (settings.credsConfigured !== true || !rc.fromNumber) {
    return fail(GATE_ERRORS.CREDS_MISSING)
  }

  if (!shipment?.phone || String(shipment.phone).trim() === '') return fail(GATE_ERRORS.SHIPMENT_NO_PHONE)

  return { ok: true }
}

// The manual path: a person pressed a button, so both questions apply. Caller first,
// preserving the original first-failure order exactly.
export function checkSendPreconditions({ auth, memberRole, settings, org, shipment }) {
  const caller = checkCallerMayText({ auth, memberRole })
  if (!caller.ok) return caller

  return checkOrgMayText({ settings, org, shipment })
}

export function checkOptInPolicy({ settings, contact, templateKey, consentAffirmed, orgSlug }) {
  // STOP is always universal locked out is locked out regardless of policy
  if (contact && contact.optIn === false) return fail(GATE_ERRORS.OPTED_OUT)

  if (
    settings.optInPolicy
    && settings.optInPolicy !== 'auto_opt_in'
    && settings.optInPolicy !== 'manual_confirm'
    && settings.optInPolicy !== 'double_opt_in'
  ) {
    // An unrecognised policy silently degrades to double_opt_in. On the automated
    // path that is NOT loud: every grey-patient message is refused, the drain
    // retries then dead-letters, and nobody sees anything unless they look.
    console.warn(`[sms] unrecognised optInPolicy "${settings.optInPolicy}" for org "${orgSlug || 'unknown'}" — falling back to double_opt_in`)
  }

  const policy = settings.optInPolicy || 'double_opt_in'

  if (policy === 'auto_opt_in') {
    return { ok: true, autoCreateOptedIn: !contact }
  }

  if (policy === 'manual_confirm') {
    if (consentAffirmed !== true) return fail(GATE_ERRORS.CONSENT_NOT_AFFIRMED)
    return { ok: true }
  }

  // policy === 'double_opt_in'
  const isOptedIn = contact && contact.optIn === true
  if (templateKey === 'optInInvite') {
    return { ok: true }
  }
  if (!isOptedIn) return fail(GATE_ERRORS.OPT_IN_REQUIRED)
  return { ok: true }
}
