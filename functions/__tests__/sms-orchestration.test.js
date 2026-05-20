import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _clearTokenCache } from '../ringcentral-auth.js'

// Build an in-memory Firestore stub
function makeFirestore({ docs = {} } = {}) {
  const collections = new Map()
  function colRef(path) {
    if (!collections.has(path)) collections.set(path, [])
    return {
      add: vi.fn(async (data) => { collections.get(path).push(data); return { id: 'audit-' + collections.get(path).length } }),
    }
  }
  function docRef(path) {
    return {
      get: vi.fn(async () => ({
        exists: !!docs[path],
        data: () => docs[path],
      })),
      set: vi.fn(async (data, opts) => {
        if (opts?.merge) docs[path] = { ...(docs[path] || {}), ...data }
        else docs[path] = data
      }),
    }
  }
  return {
    doc: vi.fn(docRef),
    collection: vi.fn(colRef),
    runTransaction: vi.fn(async (fn) => fn({
      get: vi.fn(async (ref) => ({ exists: false, data: () => null })),
      set: vi.fn(),
    })),
    _docs: docs,
    _collections: collections,
  }
}

// Mock firebase-admin/firestore to return our stub
vi.mock('firebase-admin/firestore', async () => {
  const actual = {}
  return {
    ...actual,
    getFirestore: () => globalThis.__testFirestore,
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP',
      increment: (n) => ({ __op: 'increment', value: n }),
    },
  }
})

// Mock firebase-functions/v2/https to give us a callable invocation harness
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (handler) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details }
  },
}))

const _mockCreds = {
  clientId: 'CID', clientSecret: 'CS', jwt: 'JWT',
  server: 'https://platform.ringcentral.com',
  fromNumber: '+12815550100',
}
vi.mock('../lib/rcCredentials.js', () => ({
  getRingCentralCredsForOrg: vi.fn(async () => _mockCreds),
}))

beforeEach(() => {
  _clearTokenCache()
  vi.restoreAllMocks()
})

const baseSettings = {
  enabled: true,
  credsConfigured: true,
  optInPolicy: 'double_opt_in',
  dailyCap: 250,
  ringcentral: {
    fromNumber: '+12815550100',
  },
  templates: {
    optInInvite: 'Hi from {{pharmacyName}}! Reply YES to subscribe, STOP to opt out.',
    delivered: 'Your prescription from {{pharmacyName}} has been delivered.',
  },
}

async function loadSendSms() {
  const mod = await import('../sms-send.js')
  return mod.sendSms
}

describe('sendSms orchestration — double_opt_in', () => {
  it('first send to a new patient must be the opt-in invite', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'rc-msg-1' }) })

    const sendSms = await loadSendSms()
    const result = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    })

    expect(result).toEqual({ ok: true, messageId: 'rc-msg-1' })
    expect(docs['organizations/acme/smsContacts/+12815550200']).toBeDefined()
    expect(docs['organizations/acme/smsContacts/+12815550200'].invitedAt).toBe('SERVER_TIMESTAMP')
    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(null)
  })

  it('non-invite send is blocked when contact has never opted in', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })

    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('send is blocked after opted_out (STOP locks future sends)', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
      'organizations/acme/smsContacts/+12815550200': { phone: '+12815550200', optIn: false },
    }
    globalThis.__testFirestore = makeFirestore({ docs })

    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    })).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'opted_out' } })
  })
})

describe('sendSms orchestration — auto_opt_in', () => {
  it('auto-creates an opted-in contact on first send', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'auto_opt_in' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'rc-msg-2' }) })

    const sendSms = await loadSendSms()
    await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })

    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(true)
    expect(docs['organizations/acme/smsContacts/+12815550200'].respondedAt).toBe('SERVER_TIMESTAMP')
  })
})

describe('sendSms orchestration — manual_confirm', () => {
  it('blocks send without consentAffirmed', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'manual_confirm' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered', consentAffirmed: false },
    })).rejects.toMatchObject({ details: { code: 'consent_not_affirmed' } })
  })

  it('allows send with consentAffirmed=true', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'manual_confirm' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'rc-msg-3' }) })

    const sendSms = await loadSendSms()
    const r = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered', consentAffirmed: true },
    })
    expect(r.ok).toBe(true)
  })
})

describe('sendSms orchestration — failure paths', () => {
  it('logs send_failed audit entry when RC returns 4xx', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'auto_opt_in' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad number' })

    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })).rejects.toThrow(/Bad number/)

    const auditCalls = fs.collection.mock.calls.filter(c => c[0].endsWith('/auditLog'))
    expect(auditCalls.length).toBeGreaterThan(0)
  })
})
