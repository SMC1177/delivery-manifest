import { describe, it, expect } from 'vitest'
import { checkSendPreconditions, checkCallerMayText, checkOrgMayText, checkOptInPolicy, GATE_ERRORS } from '../sms-gates.js'

const baseSettings = {
  enabled: true,
  credsConfigured: true,
  ringcentral: { fromNumber: '+12815550123' },
  optInPolicy: 'double_opt_in',
}
const baseOrg = { settings: { enabledFields: ['phone'] } }
const baseShipment = { phone: '(281) 555-0123', orgSlug: 'acme' }

describe('checkSendPreconditions', () => {
  it('passes when all preconditions met', () => {
    const result = checkSendPreconditions({
      auth: { uid: 'u1' },
      memberRole: 'staff',
      settings: baseSettings,
      org: baseOrg,
      shipment: baseShipment,
    })
    expect(result.ok).toBe(true)
  })

  it('fails when unauthenticated', () => {
    const r = checkSendPreconditions({
      auth: null, memberRole: 'staff', settings: baseSettings, org: baseOrg, shipment: baseShipment,
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.UNAUTHENTICATED)
  })

  it('fails when caller is viewer (read-only role)', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'viewer', settings: baseSettings, org: baseOrg, shipment: baseShipment,
    })
    expect(r.code).toBe(GATE_ERRORS.FORBIDDEN_ROLE)
  })

  it('fails when text messaging disabled', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff',
      settings: { ...baseSettings, enabled: false }, org: baseOrg, shipment: baseShipment,
    })
    expect(r.code).toBe(GATE_ERRORS.MESSAGING_DISABLED)
  })

  it('fails when credsConfigured is false', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff',
      settings: { ...baseSettings, credsConfigured: false },
      org: baseOrg, shipment: baseShipment,
    })
    expect(r.code).toBe(GATE_ERRORS.CREDS_MISSING)
  })

  it('fails when fromNumber is missing even if credsConfigured', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff',
      settings: { ...baseSettings, ringcentral: {} },
      org: baseOrg, shipment: baseShipment,
    })
    expect(r.code).toBe(GATE_ERRORS.CREDS_MISSING)
  })

  it('fails when phone field disabled at org level', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff', settings: baseSettings,
      org: { settings: { enabledFields: ['notes'] } }, shipment: baseShipment,
    })
    expect(r.code).toBe(GATE_ERRORS.PHONE_FIELD_DISABLED)
  })

  it('fails when shipment has no phone', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff', settings: baseSettings, org: baseOrg,
      shipment: { ...baseShipment, phone: '' },
    })
    expect(r.code).toBe(GATE_ERRORS.SHIPMENT_NO_PHONE)
  })
})

describe('checkOptInPolicy', () => {
  describe('double_opt_in', () => {
    const settings = { ...baseSettings, optInPolicy: 'double_opt_in' }

    it('allows optInInvite when contact is null (never asked)', () => {
      const r = checkOptInPolicy({ settings, contact: null, templateKey: 'optInInvite' })
      expect(r.ok).toBe(true)
    })

    it('blocks non-invite templates when contact is null', () => {
      const r = checkOptInPolicy({ settings, contact: null, templateKey: 'delivered' })
      expect(r.code).toBe(GATE_ERRORS.OPT_IN_REQUIRED)
    })

    it('blocks all sends when contact is opted out', () => {
      const r = checkOptInPolicy({ settings, contact: { optIn: false }, templateKey: 'optInInvite' })
      expect(r.code).toBe(GATE_ERRORS.OPTED_OUT)
    })

    it('allows any template when contact is opted in', () => {
      const r = checkOptInPolicy({ settings, contact: { optIn: true }, templateKey: 'delivered' })
      expect(r.ok).toBe(true)
    })
  })

  describe('auto_opt_in', () => {
    const settings = { ...baseSettings, optInPolicy: 'auto_opt_in' }

    it('allows any template even when contact is null', () => {
      const r = checkOptInPolicy({ settings, contact: null, templateKey: 'delivered' })
      expect(r.ok).toBe(true)
      expect(r.autoCreateOptedIn).toBe(true)
    })

    it('still blocks when contact is opted out (STOP is universal)', () => {
      const r = checkOptInPolicy({ settings, contact: { optIn: false }, templateKey: 'delivered' })
      expect(r.code).toBe(GATE_ERRORS.OPTED_OUT)
    })
  })

  describe('manual_confirm', () => {
    const settings = { ...baseSettings, optInPolicy: 'manual_confirm' }

    it('allows send when consentAffirmed=true', () => {
      const r = checkOptInPolicy({ settings, contact: null, templateKey: 'delivered', consentAffirmed: true })
      expect(r.ok).toBe(true)
    })

    it('blocks send when consentAffirmed missing/false', () => {
      const r = checkOptInPolicy({ settings, contact: null, templateKey: 'delivered', consentAffirmed: false })
      expect(r.code).toBe(GATE_ERRORS.CONSENT_NOT_AFFIRMED)
    })

    it('still blocks when contact is opted out', () => {
      const r = checkOptInPolicy({ settings, contact: { optIn: false }, templateKey: 'delivered', consentAffirmed: true })
      expect(r.code).toBe(GATE_ERRORS.OPTED_OUT)
    })
  })
})

describe('checkCallerMayText', () => {
  it('fails when unauthenticated', () => {
    const r = checkCallerMayText({ auth: null, memberRole: 'staff' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.UNAUTHENTICATED)
  })

  it('fails for a role that is neither admin nor staff', () => {
    const r = checkCallerMayText({ auth: { uid: 'u1' }, memberRole: 'viewer' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.FORBIDDEN_ROLE)
  })

  it('passes for an authenticated staff member', () => {
    expect(checkCallerMayText({ auth: { uid: 'u1' }, memberRole: 'staff' }).ok).toBe(true)
  })

  it('passes for an authenticated admin', () => {
    expect(checkCallerMayText({ auth: { uid: 'u1' }, memberRole: 'admin' }).ok).toBe(true)
  })
})

describe('checkOrgMayText', () => {
  it('fails when messaging is disabled', () => {
    const r = checkOrgMayText({ settings: { ...baseSettings, enabled: false }, org: baseOrg, shipment: baseShipment })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.MESSAGING_DISABLED)
  })

  it('fails when the org has not enabled the phone field', () => {
    const r = checkOrgMayText({ settings: baseSettings, org: { settings: { enabledFields: ['email'] } }, shipment: baseShipment })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.PHONE_FIELD_DISABLED)
  })

  it('fails when credentials are not configured', () => {
    const r = checkOrgMayText({ settings: { ...baseSettings, credsConfigured: false }, org: baseOrg, shipment: baseShipment })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.CREDS_MISSING)
  })

  it('fails when the shipment carries no phone number', () => {
    const r = checkOrgMayText({ settings: baseSettings, org: baseOrg, shipment: { ...baseShipment, phone: '   ' } })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(GATE_ERRORS.SHIPMENT_NO_PHONE)
  })

  it('passes when the org is fully configured for this shipment', () => {
    expect(checkOrgMayText({ settings: baseSettings, org: baseOrg, shipment: baseShipment }).ok).toBe(true)
  })

  // THE PROPERTY THE AUTOMATED PATH DEPENDS ON. A scheduled drain has no caller at all:
  // there is no auth object and no member role to check. If checkOrgMayText ever reads
  // either one, the queue path silently starts refusing every message.
  it('never reads auth or memberRole — a denied caller changes nothing', () => {
    const noCaller = checkOrgMayText({ settings: baseSettings, org: baseOrg, shipment: baseShipment })
    const deniedCaller = checkOrgMayText({
      auth: null,
      memberRole: 'viewer',
      settings: baseSettings,
      org: baseOrg,
      shipment: baseShipment,
    })
    expect(noCaller.ok).toBe(true)
    expect(deniedCaller).toEqual(noCaller)
  })
})
