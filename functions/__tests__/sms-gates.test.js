import { describe, it, expect } from 'vitest'
import { checkSendPreconditions, checkOptInPolicy, GATE_ERRORS } from '../sms-gates.js'

const baseSettings = {
  enabled: true,
  ringcentral: { clientId: 'a', clientSecret: 'b', jwt: 'c', fromNumber: '+12815550123' },
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

  it('fails when RC credentials incomplete', () => {
    const r = checkSendPreconditions({
      auth: { uid: 'u1' }, memberRole: 'staff',
      settings: { ...baseSettings, ringcentral: { clientId: 'a' } },
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
