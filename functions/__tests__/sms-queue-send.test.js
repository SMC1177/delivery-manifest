// functions/__tests__/sms-queue-send.test.js
//
// The queued send path texts real patients with nobody watching. Every refusal below
// is a message that must NOT go out. Reuse of the manual path's gates is proven here,
// never assumed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizePhone } from '../lib/phoneNormalize.js'
import { GATE_ERRORS } from '../sms-gates.js'

const { rcSend, rcCreds } = vi.hoisted(() => ({ rcSend: vi.fn(), rcCreds: vi.fn() }))

vi.mock('../ringcentral-sms.js', () => ({ sendRingCentralSms: rcSend }))
vi.mock('../lib/rcCredentials.js', () => ({ getRingCentralCredsForOrg: rcCreds }))

import { sendQueuedMessage } from '../sms-queue-send.js'

const ORG = 'acme'
const RAW_PHONE = '(281) 555-0123'
// Derived, never hardcoded: the adapter keys the contact doc off normalizePhone's
// output, so the fixture must too or the test would pin a guess instead of behaviour.
const PHONE = normalizePhone(RAW_PHONE)

const SHIPPED_TEMPLATE = 'Hi {{patientName}}, {{pharmacyName}} shipped your order. Questions? {{pharmacyPhone}}'
const BATCHED_TEMPLATE = 'Hi {{patientName}}, {{pharmacyName}} shipped {{prescriptionCount}} prescriptions.'

function baseStore(overrides = {}) {
  return {
    [`organizations/${ORG}`]: {
      name: 'Acme Pharmacy',
      contactPhone: '281-555-0100',
      settings: { enabledFields: ['phone'] },
    },
    [`organizations/${ORG}/settings/textMessaging`]: {
      enabled: true,
      credsConfigured: true,
      ringcentral: { fromNumber: '+12815550123' },
      optInPolicy: 'double_opt_in',
      templates: { shipped: SHIPPED_TEMPLATE, batched: BATCHED_TEMPLATE },
    },
    [`organizations/${ORG}/shipments/s1`]: { phone: RAW_PHONE, patientName: 'Pat Smith' },
    [`organizations/${ORG}/shipments/s2`]: { phone: RAW_PHONE, patientName: 'Pat Smith' },
    [`organizations/${ORG}/smsContacts/${PHONE}`]: { optIn: true },
    ...overrides,
  }
}

function makeFirestore(store) {
  return {
    doc: (path) => ({
      get: async () => {
        const has = Object.prototype.hasOwnProperty.call(store, path) && store[path] !== undefined
        return { exists: has, data: () => store[path] }
      },
    }),
  }
}

const queueItem = (over = {}) => ({
  id: 'q1',
  trackingNumber: '9400111899223197428490',
  templateKey: 'shipped',
  shipmentIds: ['s1'],
  status: 'sending',
  ...over,
})

beforeEach(() => {
  rcSend.mockReset()
  rcCreds.mockReset()
  rcCreds.mockResolvedValue({ fromNumber: '+12815550123', token: 'tok' })
  rcSend.mockResolvedValue({ id: 'rc-1' })
})

describe('sendQueuedMessage — refusals that keep a message from going out', () => {
  it('refuses an item that names no shipments', async () => {
    const firestore = makeFirestore(baseStore())
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem({ shipmentIds: [] }) })).rejects.toThrow()
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses when none of the named shipment documents exist', async () => {
    const firestore = makeFirestore(baseStore({ [`organizations/${ORG}/shipments/s1`]: undefined }))
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow()
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses rather than guessing when batched shipments disagree on phone number', async () => {
    const firestore = makeFirestore(baseStore({
      [`organizations/${ORG}/shipments/s2`]: { phone: '(281) 555-0999', patientName: 'Pat Smith' },
    }))
    await expect(
      sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem({ shipmentIds: ['s1', 's2'] }) })
    ).rejects.toThrow()
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses with the org gate code when messaging is disabled', async () => {
    const store = baseStore()
    store[`organizations/${ORG}/settings/textMessaging`].enabled = false
    const firestore = makeFirestore(store)
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(GATE_ERRORS.MESSAGING_DISABLED)
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses when the org has not enabled the phone field', async () => {
    const store = baseStore()
    store[`organizations/${ORG}`].settings.enabledFields = ['email']
    const firestore = makeFirestore(store)
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(GATE_ERRORS.PHONE_FIELD_DISABLED)
    expect(rcSend).not.toHaveBeenCalled()
  })

  // THE ONE THAT MATTERS MOST. Under double_opt_in a patient with no contact record
  // has never agreed to be texted, and no human is present to notice.
  it('refuses to text a patient who has never opted in', async () => {
    const firestore = makeFirestore(baseStore({ [`organizations/${ORG}/smsContacts/${PHONE}`]: undefined }))
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(GATE_ERRORS.OPT_IN_REQUIRED)
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses when the contact has explicitly opted out', async () => {
    const firestore = makeFirestore(baseStore({ [`organizations/${ORG}/smsContacts/${PHONE}`]: { optIn: false } }))
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(GATE_ERRORS.OPTED_OUT)
    expect(rcSend).not.toHaveBeenCalled()
  })

  // A scheduled drain has nobody to affirm consent, so it must never affirm it itself.
  it('never affirms consent on a human being behalf under manual_confirm', async () => {
    const store = baseStore()
    store[`organizations/${ORG}/settings/textMessaging`].optInPolicy = 'manual_confirm'
    const firestore = makeFirestore(store)
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(GATE_ERRORS.CONSENT_NOT_AFFIRMED)
    expect(rcSend).not.toHaveBeenCalled()
  })

  it('refuses when the pharmacy has no contact phone to put in the message', async () => {
    const store = baseStore()
    store[`organizations/${ORG}`].contactPhone = ''
    const firestore = makeFirestore(store)
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow()
    expect(rcSend).not.toHaveBeenCalled()
  })
})

describe('sendQueuedMessage — the send itself', () => {
  it('sends one message addressed to the shipment phone', async () => {
    const firestore = makeFirestore(baseStore())
    await sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })

    expect(rcSend).toHaveBeenCalledTimes(1)
    const arg = rcSend.mock.calls[0][0]
    expect(arg.to).toBe(PHONE)
    expect(arg.from).toBe('+12815550123')
    expect(arg.text).toContain('Pat Smith')
    expect(arg.text).toContain('Acme Pharmacy')
    expect(arg.creds).toEqual({ fromNumber: '+12815550123', token: 'tok' })
  })

  it('sends exactly one message for a batched item and counts its prescriptions', async () => {
    const firestore = makeFirestore(baseStore())
    await sendQueuedMessage({
      firestore,
      orgSlug: ORG,
      item: queueItem({ templateKey: 'batched', shipmentIds: ['s1', 's2'] }),
    })

    expect(rcSend).toHaveBeenCalledTimes(1)
    expect(rcSend.mock.calls[0][0].text).toContain('2')
  })

  it('surfaces a provider failure instead of swallowing it', async () => {
    rcSend.mockRejectedValue(new Error('RingCentral SMS failed (400): Bad number'))
    const firestore = makeFirestore(baseStore())
    await expect(sendQueuedMessage({ firestore, orgSlug: ORG, item: queueItem() })).rejects.toThrow(/Bad number/)
  })
})
