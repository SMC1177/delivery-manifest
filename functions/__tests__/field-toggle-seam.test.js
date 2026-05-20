import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _clearTokenCache } from '../ringcentral-auth.js'

// Reuse the same makeFirestore + mocks from sms-orchestration.test.js inline:
function makeFirestore({ docs = {} } = {}) {
  return {
    doc: (path) => ({
      get: async () => ({ exists: !!docs[path], data: () => docs[path] }),
      set: async (data, opts) => { docs[path] = opts?.merge ? { ...(docs[path] || {}), ...data } : data },
    }),
    collection: (path) => ({ add: async () => ({ id: 'a1' }) }),
    runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set: () => {} }),
  }
}
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => globalThis.__testFirestore,
  FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ __op: 'inc', value: n }) },
}))
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (h) => h,
  HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d } },
}))

beforeEach(() => { _clearTokenCache(); vi.restoreAllMocks() })

describe('field-toggle seam: phone field off → SMS send refused with correct gate', () => {
  it('fails with phone_field_disabled, not some other gate', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme', settings: { enabledFields: ['notes'] } }, // phone OFF
      'organizations/acme/settings/textMessaging': {
        enabled: true, optInPolicy: 'double_opt_in', dailyCap: 250,
        ringcentral: { clientId: 'C', clientSecret: 'S', jwt: 'J', server: 'X', fromNumber: '+1' },
        templates: { optInInvite: 'YES STOP' },
      },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })

    const { sendSms } = await import('../sms-send.js')
    const err = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    }).catch(e => e)

    expect(err).toBeTruthy()
    expect(err.details).toEqual({ code: 'phone_field_disabled' })
  })

  it('after enabling phone field, the same send goes through', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme', settings: { enabledFields: ['phone'] } }, // phone ON
      'organizations/acme/settings/textMessaging': {
        enabled: true, optInPolicy: 'double_opt_in', dailyCap: 250,
        ringcentral: { clientId: 'C', clientSecret: 'S', jwt: 'J', server: 'https://x', fromNumber: '+12815550100' },
        templates: { optInInvite: 'Hi from {{pharmacyName}}! YES STOP' },
      },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'msg-1' }) })

    const { sendSms } = await import('../sms-send.js')
    const r = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    })
    expect(r.ok).toBe(true)
  })
})
