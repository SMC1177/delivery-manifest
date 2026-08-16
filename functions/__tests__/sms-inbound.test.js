import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _clearTokenCache } from '../ringcentral-auth.js'

function makeFirestore({ docs = {} } = {}) {
  const auditEntries = []
  return {
    doc: (path) => ({
      get: async () => ({ exists: !!docs[path], data: () => docs[path] }),
      set: async (data, opts) => { docs[path] = opts?.merge ? { ...(docs[path] || {}), ...data } : data },
    }),
    collection: (path) => ({
      add: async (data) => { auditEntries.push({ path, data }); return { id: 'a' + auditEntries.length } },
    }),
    _audit: auditEntries,
    _docs: docs,
  }
}

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => globalThis.__testFirestore,
  FieldValue: { serverTimestamp: () => 'TS' },
}))

vi.mock('firebase-functions/v2/https', () => ({
  onRequest: (h) => h,
}))

const _mockCreds = {
  clientId: 'CID', clientSecret: 'CS', jwt: 'JWT',
  server: 'https://platform.ringcentral.com',
  fromNumber: '+12815550100',
}
vi.mock('../lib/rcCredentials.js', () => ({
  getRingCentralCredsForOrg: vi.fn(async () => _mockCreds),
}))

beforeEach(() => { _clearTokenCache(); vi.restoreAllMocks() })

function makeReq({ method = 'POST', query = { org: 'acme' }, headers = { 'x-webhook-token': 'TOK' }, body = {} } = {}) {
  return {
    method, query, body,
    get: (k) => headers[k.toLowerCase()],
  }
}
function makeRes() {
  return {
    status: vi.fn(function (s) { this._status = s; return this }),
    send: vi.fn(function (b) { this._body = b; return this }),
  }
}

const baseSettings = {
  enabled: true,
  webhookToken: 'TOK',
  credsConfigured: true,
  ringcentral: { fromNumber: '+12815550100' },
  templates: {
    optInConfirm: 'You are subscribed to {{pharmacyName}}.',
    optOutConfirm: 'You are unsubscribed from {{pharmacyName}}.',
    nonKeywordRedirect: 'Call {{pharmacyPhone}}.',
  },
}

describe('ringcentralInbound', () => {
  it('rejects non-POST', async () => {
    globalThis.__testFirestore = makeFirestore()
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()
    await ringcentralInbound(makeReq({ method: 'GET' }), res)
    expect(res._status).toBe(405)
  })

  it('rejects missing ?org=', async () => {
    globalThis.__testFirestore = makeFirestore()
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()
    await ringcentralInbound(makeReq({ query: {} }), res)
    expect(res._status).toBe(400)
  })

  it('rejects bad webhook token', async () => {
    const docs = { 'organizations/acme/settings/textMessaging': baseSettings }
    globalThis.__testFirestore = makeFirestore({ docs })
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()
    await ringcentralInbound(makeReq({ headers: { 'x-webhook-token': 'WRONG' } }), res)
    expect(res._status).toBe(401)
  })

  it('YES sets optIn=true and audits invite_response', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()

    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'YES', messageId: 'rc-1' } },
    }), res)

    expect(res._status).toBe(200)
    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(true)
    const optInEntry = fs._audit.find(e => e.data.action === 'sms.invite_response')
    expect(optInEntry.data.details.reply).toBe('YES')
  })

  it('STOP sets optIn=false', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()

    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'STOP', messageId: 'rc-2' } },
    }), res)

    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(false)
  })

  it('case-insensitive — "yes" still counts', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    globalThis.__testFirestore = makeFirestore({ docs })
    const { ringcentralInbound } = await import('../sms-inbound.js')
    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: ' yes ', messageId: 'rc-3' } },
    }), makeRes())
    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(true)
  })

  it('non-keyword inbound is audited WITHOUT body content (PHI safety)', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    const { ringcentralInbound } = await import('../sms-inbound.js')
    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'I have a sensitive medical question', messageId: 'rc-4' } },
    }), makeRes())

    const entry = fs._audit.find(e => e.data.action === 'sms.non_keyword_inbound')
    expect(entry).toBeDefined()
    expect(entry.data.details).toEqual({})
    expect(JSON.stringify(entry)).not.toContain('sensitive medical')
  })

  it('dedupes duplicate messageIds', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
      'organizations/acme/settings/textMessaging/inboundSeen/rc-5': { seenAt: 'past' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()
    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'YES', messageId: 'rc-5' } },
    }), res)
    expect(res._body).toBe('Duplicate')
    expect(docs['organizations/acme/smsContacts/+12815550200']).toBeUndefined()
  })

  it('auto-replies on YES when autoReplyOnYesStop=true', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': { ...baseSettings, autoReplyOnYesStop: true },
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'reply-1' }) })

    const { ringcentralInbound } = await import('../sms-inbound.js')
    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'YES', messageId: 'rc-6' } },
    }), makeRes())

    expect(fs._audit.find(e => e.data.action === 'sms.auto_reply_sent')).toBeDefined()
  })
})

describe('w8-5 multilingual opt-out', () => {
  it.each(['PARE', 'ARRET', 'ALTO', 'BAJA', 'DETENER', 'PARAR', 'NO'])(
    '%s opts the contact out (optIn=false, audit reflects it)',
    async (word) => {
      const docs = {
        'organizations/acme/settings/textMessaging': baseSettings,
        'organizations/acme': { name: 'Acme RX' },
      }
      const fs = makeFirestore({ docs })
      globalThis.__testFirestore = fs
      const { ringcentralInbound } = await import('../sms-inbound.js')
      const res = makeRes()

      await ringcentralInbound(makeReq({
        body: { body: { from: { phoneNumber: '+12815550200' }, subject: word, messageId: `rc-multi-${word}` } },
      }), res)

      // Non-English opt-out words must classify as opt-out (not non_keyword):
      // the contact flips to optIn:false and the invite_response audit records
      // the handler-normalized reply ('STOP'), not the raw word.
      expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(false)
      expect(fs._audit.find(e => e.data.action === 'sms.non_keyword_inbound')).toBeUndefined()
      const entry = fs._audit.find(e => e.data.action === 'sms.invite_response')
      expect(entry).toBeDefined()
      expect(entry.data.details.reply).toBe('STOP')
    },
  )
})

describe('w8-6 language learning from inbound replies', () => {
  it('PARE sets the contact language to es (learned from the reply) and opts out', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    const { ringcentralInbound } = await import('../sms-inbound.js')
    const res = makeRes()

    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'PARE', messageId: 'rc-lang-1' } },
    }), res)

    expect(res._status).toBe(200)
    const contact = docs['organizations/acme/smsContacts/+12815550200']
    expect(contact.optIn).toBe(false)
    expect(contact.language).toBe('es')
  })

  it('SI sets optIn=true and language es; OUI sets optIn=true and language fr', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': baseSettings,
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    const { ringcentralInbound } = await import('../sms-inbound.js')

    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'SI', messageId: 'rc-lang-2' } },
    }), makeRes())
    expect(docs['organizations/acme/smsContacts/+12815550200'].optIn).toBe(true)
    expect(docs['organizations/acme/smsContacts/+12815550200'].language).toBe('es')

    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550300' }, subject: 'OUI', messageId: 'rc-lang-3' } },
    }), makeRes())
    expect(docs['organizations/acme/smsContacts/+12815550300'].optIn).toBe(true)
    expect(docs['organizations/acme/smsContacts/+12815550300'].language).toBe('fr')
  })

  it('sends the opt-out confirmation auto-reply in the patient language (es for a Spanish reply)', async () => {
    const docs = {
      'organizations/acme/settings/textMessaging': {
        ...baseSettings,
        autoReplyOnYesStop: true,
        templates: {
          ...baseSettings.templates,
          optOutConfirmEs: 'Está dado de baja de {{pharmacyName}}.',
        },
      },
      'organizations/acme': { name: 'Acme RX' },
    }
    const fs = makeFirestore({ docs })
    globalThis.__testFirestore = fs
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'reply-1' }) })

    const { ringcentralInbound } = await import('../sms-inbound.js')
    await ringcentralInbound(makeReq({
      body: { body: { from: { phoneNumber: '+12815550200' }, subject: 'PARE', messageId: 'rc-lang-4' } },
    }), makeRes())

    // fetch call #1 = token, call #2 = the SMS send; the sent text must be Spanish.
    const sendInit = JSON.parse(global.fetch.mock.calls[1][1].body)
    expect(sendInit.text).toContain('Está dado de baja')
    expect(docs['organizations/acme/smsContacts/+12815550200'].language).toBe('es')
  })
})
