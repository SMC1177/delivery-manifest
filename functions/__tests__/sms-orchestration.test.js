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
      get: vi.fn(async (ref) => ({ exists: !!docs[ref.path], data: () => docs[ref.path] })),
      set: vi.fn(async (ref, data, opts) => {
        if (opts?.merge) docs[ref.path] = { ...(docs[ref.path] || {}), ...data }
        else docs[ref.path] = data
      }),
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
  it('first opt-in invite to a new patient is queued, never sent directly', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()

    const sendSms = await loadSendSms()
    const result = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    })

    expect(result).toEqual({ ok: true, status: 'queued', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
    const auditLog = fs._collections.get('organizations/acme/auditLog')
    expect(auditLog).toBeDefined()
    expect(auditLog.map(e => e.action)).toContain('sms.invite_queued')
  })

  it('non-invite send is blocked when contact has never opted in', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
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
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
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
  it('auto_opt_in first send is queued; contact bookkeeping belongs to the drain', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'auto_opt_in' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()

    const sendSms = await loadSendSms()
    const result = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })

    expect(result).toEqual({ ok: true, status: 'queued', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(docs['organizations/acme/smsContacts/+12815550200']).toBeUndefined()
  })
})

describe('sendSms orchestration — manual_confirm', () => {
  it('blocks send without consentAffirmed', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'manual_confirm' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered', consentAffirmed: false },
    })).rejects.toMatchObject({ details: { code: 'consent_not_affirmed' } })
  })

  it('allows queueing with consentAffirmed=true', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'manual_confirm' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    global.fetch = vi.fn()

    const sendSms = await loadSendSms()
    const r = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered', consentAffirmed: true },
    })
    expect(r).toEqual({ ok: true, status: 'queued', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('sendSms orchestration — failure paths', () => {
  it('rejects a shipment without a tracking number', async () => {
    const fs = makeFirestore({ docs: {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John' },
    } })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()

    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'cannot queue a text for a shipment without a tracking number',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('surfaces an HttpsError and an audit entry when enqueue fails', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': { ...baseSettings, optInPolicy: 'auto_opt_in' },
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
    fs.runTransaction = vi.fn(async () => { throw new Error('ledger unavailable') })

    const sendSms = await loadSendSms()
    await expect(sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'delivered' },
    })).rejects.toMatchObject({ code: 'internal' })

    const auditLog = fs._collections.get('organizations/acme/auditLog')
    expect(auditLog).toBeDefined()
    expect(auditLog.map(e => e.action)).toContain('sms.enqueue_failed')
  })
})
describe('sendSms enqueues instead of sending directly', () => {
  const ORG = 'acme'

  function makeDocs(trackingNumber) {
    return {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber },
      // The opt-in policy gate still applies at enqueue time (double_opt_in
      // requires an opted-in contact before a non-invite template can queue).
      'organizations/acme/smsContacts/+12815550200': { phone: '+12815550200', optIn: true },
    }
  }

  it('returns { ok: true, status: "queued", trackingNumber } and never calls the provider directly', async () => {
    const fs = makeFirestore({ docs: makeDocs('1Z999AA10123456784') })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
    _clearTokenCache()
    const sendSms = await loadSendSms()
    const result = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: ORG, shipmentId: 's1', templateKey: 'delivered' },
    })
    expect(result).toEqual({ ok: true, status: 'queued', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns already_notified for a second send of the same shipment', async () => {
    const fs = makeFirestore({ docs: makeDocs('1Z999AA10123456784') })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
    _clearTokenCache()
    const sendSms = await loadSendSms()
    await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: ORG, shipmentId: 's1', templateKey: 'delivered' },
    })
    const second = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: ORG, shipmentId: 's1', templateKey: 'delivered' },
    })
    expect(second).toEqual({ ok: true, status: 'already_notified', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('consent-read fail-open', () => {
  // A READ failure on the smsContacts doc must fail open: we cannot prove the
  // contact opted out, so the send proceeds as an assumed opt-in and we warn.
  it('queues the send when the smsContacts read rejects', async () => {
    const docs = {
      'organizations/acme': { name: 'Acme RX', settings: { enabledFields: ['phone'] } },
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme/members/u1': { role: 'staff' },
      'organizations/acme/shipments/s1': { phone: '+12815550200', patientName: 'John', trackingNumber: '1Z999AA10123456784' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
    _clearTokenCache()

    // Only the smsContacts doc read rejects; every other read keeps working.
    const baseDoc = fs.doc.getMockImplementation()
    fs.doc = vi.fn((path) => {
      const ref = baseDoc(path)
      if (path.startsWith('organizations/acme/smsContacts/')) {
        ref.get = vi.fn(async () => { throw new Error('consent lookup failed') })
      }
      return ref
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sendSms = await loadSendSms()
    const result = await sendSms({
      auth: { uid: 'u1' },
      data: { orgSlug: 'acme', shipmentId: 's1', templateKey: 'optInInvite' },
    })

    expect(result).toEqual({ ok: true, status: 'queued', trackingNumber: '1Z999AA10123456784' })
    expect(global.fetch).not.toHaveBeenCalled()
    const warnMessages = warnSpy.mock.calls.map((args) =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    expect(warnMessages.some((m) => m.includes('acme') && m.includes('+12815550200'))).toBe(true)
  })
})
