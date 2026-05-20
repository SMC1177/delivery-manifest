import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub firebase-admin/firestore BEFORE importing the module under test
const fakeDocSnap = (data) => ({ exists: !!data, data: () => data })
let _fakeDoc = null
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: (path) => ({ get: async () => fakeDocSnap(_fakeDoc) }),
  }),
}))

import { getRingCentralCredsForOrg, _setClient, secretNameFor } from '../lib/rcCredentials.js'

function makeClient(payload, { throwError = null } = {}) {
  return {
    accessSecretVersion: vi.fn(async ({ name }) => {
      if (throwError) throw throwError
      return [{ payload: { data: Buffer.from(payload, 'utf8') } }]
    }),
  }
}

beforeEach(() => {
  _fakeDoc = null
  _setClient(null)
})

describe('secretNameFor', () => {
  it('produces a versions/latest path scoped to project + org', () => {
    const name = secretNameFor('acme')
    expect(name).toMatch(/^projects\/.+\/secrets\/textmsg-rc-creds-acme\/versions\/latest$/)
  })
})

describe('getRingCentralCredsForOrg', () => {
  it('rejects empty orgSlug', async () => {
    await expect(getRingCentralCredsForOrg('')).rejects.toThrow(/orgSlug is required/i)
    await expect(getRingCentralCredsForOrg(null)).rejects.toThrow(/orgSlug is required/i)
  })

  it('throws when textMessaging settings doc is missing', async () => {
    _fakeDoc = null
    _setClient(makeClient('{}'))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/No textMessaging settings/)
  })

  it('throws when settings missing server', async () => {
    _fakeDoc = { ringcentral: { fromNumber: '+12815550100' } }
    _setClient(makeClient('{}'))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/missing server or fromNumber/)
  })

  it('throws when settings missing fromNumber', async () => {
    _fakeDoc = { ringcentral: { server: 'https://platform.ringcentral.com' } }
    _setClient(makeClient('{}'))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/missing server or fromNumber/)
  })

  it('throws when secret manager access fails', async () => {
    _fakeDoc = { ringcentral: { server: 'https://x', fromNumber: '+12815550100' } }
    _setClient(makeClient('', { throwError: new Error('PERMISSION_DENIED: no access') }))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/Could not read RC creds secret/)
  })

  it('throws when secret payload is not JSON', async () => {
    _fakeDoc = { ringcentral: { server: 'https://x', fromNumber: '+12815550100' } }
    _setClient(makeClient('not-json'))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/not valid JSON/)
  })

  it('throws when secret JSON missing required fields', async () => {
    _fakeDoc = { ringcentral: { server: 'https://x', fromNumber: '+12815550100' } }
    _setClient(makeClient(JSON.stringify({ clientId: 'a' })))
    await expect(getRingCentralCredsForOrg('acme')).rejects.toThrow(/missing clientId\/clientSecret\/jwt/)
  })

  it('returns merged creds when both sources have data', async () => {
    _fakeDoc = { ringcentral: { server: 'https://platform.ringcentral.com', fromNumber: '+12815550100' } }
    _setClient(makeClient(JSON.stringify({ clientId: 'CID', clientSecret: 'CS', jwt: 'JWT' })))
    const creds = await getRingCentralCredsForOrg('acme')
    expect(creds).toEqual({
      clientId: 'CID',
      clientSecret: 'CS',
      jwt: 'JWT',
      server: 'https://platform.ringcentral.com',
      fromNumber: '+12815550100',
    })
  })
})
