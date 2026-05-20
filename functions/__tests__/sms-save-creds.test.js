import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub firebase-admin/firestore + firebase-functions/v2/https
const _docs = {}
const _audit = []
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: (path) => ({
      get: async () => ({ exists: !!_docs[path], data: () => _docs[path] }),
      set: async (data, opts) => {
        _docs[path] = opts?.merge ? { ...(_docs[path] || {}), ...data } : data
      },
    }),
    collection: (path) => ({
      add: async (data) => { _audit.push({ path, data }); return { id: 'a' + _audit.length } },
    }),
  }),
  FieldValue: { serverTimestamp: () => 'TS' },
}))
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (h) => h,
  HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code } },
}))

import { saveRingCentralCreds, _setClient } from '../sms-save-creds.js'

function freshSecretClient({ createThrows = null, addThrows = null } = {}) {
  return {
    createSecret: vi.fn(async () => {
      if (createThrows) throw createThrows
      return [{ name: 'projects/x/secrets/textmsg-rc-creds-acme' }]
    }),
    addSecretVersion: vi.fn(async () => {
      if (addThrows) throw addThrows
      return [{ name: 'projects/x/secrets/textmsg-rc-creds-acme/versions/1' }]
    }),
  }
}

const validInput = {
  orgSlug: 'acme',
  clientId: 'CID',
  clientSecret: 'CS',
  jwt: 'JWT.TOKEN',
  server: 'https://platform.ringcentral.com',
  fromNumber: '+12815550100',
}

beforeEach(() => {
  for (const k of Object.keys(_docs)) delete _docs[k]
  _audit.length = 0
  _docs['organizations/acme/members/u1'] = { role: 'admin' }
  _setClient(null)
})

describe('saveRingCentralCreds', () => {
  it('rejects unauthenticated request', async () => {
    _setClient(freshSecretClient())
    await expect(saveRingCentralCreds({ auth: null, data: validInput }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects missing required field', async () => {
    _setClient(freshSecretClient())
    const { clientId, ...rest } = validInput
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: rest }))
      .rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('rejects invalid orgSlug format', async () => {
    _setClient(freshSecretClient())
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: { ...validInput, orgSlug: '../etc/passwd' } }))
      .rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('rejects non-admin caller', async () => {
    _docs['organizations/acme/members/u1'] = { role: 'staff' }
    _setClient(freshSecretClient())
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput }))
      .rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('rejects when caller is not a member of the org', async () => {
    delete _docs['organizations/acme/members/u1']
    _setClient(freshSecretClient())
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput }))
      .rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('on success: creates secret, adds version, writes Firestore, audits', async () => {
    const sm = freshSecretClient()
    _setClient(sm)
    const r = await saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput })
    expect(r).toEqual({ ok: true })
    expect(sm.createSecret).toHaveBeenCalledTimes(1)
    expect(sm.addSecretVersion).toHaveBeenCalledTimes(1)
    // payload is bytes; decode and parse
    const payload = JSON.parse(sm.addSecretVersion.mock.calls[0][0].payload.data.toString('utf8'))
    expect(payload).toEqual({ clientId: 'CID', clientSecret: 'CS', jwt: 'JWT.TOKEN' })
    // Firestore got the non-sensitive bits
    expect(_docs['organizations/acme/settings/textMessaging'].ringcentral).toEqual({
      server: 'https://platform.ringcentral.com',
      fromNumber: '+12815550100',
    })
    expect(_docs['organizations/acme/settings/textMessaging'].credsConfigured).toBe(true)
    // Audit log
    expect(_audit.find(e => e.data.action === 'sms.settings_changed')).toBeTruthy()
  })

  it('idempotent re-save: ALREADY_EXISTS on createSecret is swallowed, addSecretVersion still runs', async () => {
    const err = new Error('ALREADY_EXISTS: secret already exists')
    err.code = 6
    const sm = freshSecretClient({ createThrows: err })
    _setClient(sm)
    const r = await saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput })
    expect(r).toEqual({ ok: true })
    expect(sm.addSecretVersion).toHaveBeenCalledTimes(1)
  })

  it('propagates non-ALREADY_EXISTS createSecret errors', async () => {
    const err = new Error('PERMISSION_DENIED')
    err.code = 7
    const sm = freshSecretClient({ createThrows: err })
    _setClient(sm)
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput }))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('propagates addSecretVersion errors', async () => {
    const sm = freshSecretClient({ addThrows: new Error('quota exceeded') })
    _setClient(sm)
    await expect(saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput }))
      .rejects.toMatchObject({ code: 'internal' })
  })
})
