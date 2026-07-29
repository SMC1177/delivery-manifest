import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirror the exact harness from sms-save-creds.test.js
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

// ---------------------------------------------------------------------------
// Helper: assert that NOTHING was written — no Secret Manager call, no
// Firestore settings doc.  This is the most critical invariant: a rejected
// save must leave the live creds intact.
// ---------------------------------------------------------------------------
async function assertNoWritesOnReject(dataOverrides) {
  const sm = freshSecretClient()
  _setClient(sm)
  await expect(
    saveRingCentralCreds({ auth: { uid: 'u1' }, data: { ...validInput, ...dataOverrides } }),
  ).rejects.toMatchObject({ code: 'invalid-argument' })
  expect(sm.addSecretVersion).not.toHaveBeenCalled()
  expect(_docs['organizations/acme/settings/textMessaging']).toBeUndefined()
}

describe('saveRingCentralCreds guard — autofill & partial-save protection', () => {
  // ---- 1. THE AUTOFILL CASE ------------------------------------------------
  it('rejects clientId containing @ (browser autofill signature) and mentions autofill or email', async () => {
    const sm = freshSecretClient()
    _setClient(sm)
    const promise = saveRingCentralCreds({
      auth: { uid: 'u1' },
      data: { ...validInput, clientId: 'operator@example.com' },
    })
    await expect(promise).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(promise).rejects.toThrow(/autofill|email/i)
    // writes nothing
    expect(sm.addSecretVersion).not.toHaveBeenCalled()
    expect(_docs['organizations/acme/settings/textMessaging']).toBeUndefined()
  })

  // ---- 2. PARTIAL PAYLOADS ARE REFUSED ------------------------------------
  it('rejects blank jwt (empty string)', async () => {
    await assertNoWritesOnReject({ jwt: '' })
  })

  it('rejects blank clientSecret (empty string)', async () => {
    await assertNoWritesOnReject({ clientSecret: '' })
  })

  it('rejects blank clientId (empty string)', async () => {
    await assertNoWritesOnReject({ clientId: '' })
  })

  it('rejects whitespace-only jwt', async () => {
    await assertNoWritesOnReject({ jwt: '   ' })
  })

  it('rejects whitespace-only clientSecret', async () => {
    await assertNoWritesOnReject({ clientSecret: '\t  ' })
  })

  it('rejects whitespace-only clientId', async () => {
    await assertNoWritesOnReject({ clientId: '  \n ' })
  })

  // ---- 3. THE MOST IMPORTANT ASSERTION — no writes on rejection -----------
  // Already embedded in each rejection test above via assertNoWritesOnReject.
  // The autofill case does its own inline assertions.  This test doubles down
  // with a combo payload missing all creds — the worst-case near-miss.
  it('writes NOTHING when all three credential fields are missing', async () => {
    const sm = freshSecretClient()
    _setClient(sm)
    await expect(
      saveRingCentralCreds({
        auth: { uid: 'u1' },
        data: { orgSlug: 'acme', server: 's', fromNumber: 'f' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' })
    expect(sm.addSecretVersion).not.toHaveBeenCalled()
    expect(sm.createSecret).not.toHaveBeenCalled()
    expect(_docs['organizations/acme/settings/textMessaging']).toBeUndefined()
  })

  // ---- 4. NON-STRING INPUTS DO NOT CRASH ----------------------------------
  it('rejects null clientId cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientId: null })
  })

  it('rejects undefined clientId cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientId: undefined })
  })

  it('rejects numeric clientId cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientId: 12345 })
  })

  it('rejects null clientSecret cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientSecret: null })
  })

  it('rejects undefined clientSecret cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientSecret: undefined })
  })

  it('rejects numeric clientSecret cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ clientSecret: 99 })
  })

  it('rejects null jwt cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ jwt: null })
  })

  it('rejects undefined jwt cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ jwt: undefined })
  })

  it('rejects numeric jwt cleanly (no TypeError)', async () => {
    await assertNoWritesOnReject({ jwt: 0 })
  })

  // ---- 5. A VALID PAYLOAD STILL WORKS -------------------------------------
  it('accepts a valid payload: Secret Manager write, Firestore write, credsConfigured set', async () => {
    const sm = freshSecretClient()
    _setClient(sm)
    const r = await saveRingCentralCreds({ auth: { uid: 'u1' }, data: validInput })
    expect(r).toEqual({ ok: true })
    expect(sm.addSecretVersion).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(sm.addSecretVersion.mock.calls[0][0].payload.data.toString('utf8'))
    expect(payload).toEqual({ clientId: 'CID', clientSecret: 'CS', jwt: 'JWT.TOKEN' })
    expect(_docs['organizations/acme/settings/textMessaging'].ringcentral).toEqual({
      server: 'https://platform.ringcentral.com',
      fromNumber: '+12815550100',
    })
    expect(_docs['organizations/acme/settings/textMessaging'].credsConfigured).toBe(true)
  })

  // ---- 6. TRIMMING ---------------------------------------------------------
  it('stores trimmed values — leading/trailing whitespace is stripped before Secret Manager write', async () => {
    const sm = freshSecretClient()
    _setClient(sm)
    const r = await saveRingCentralCreds({
      auth: { uid: 'u1' },
      data: {
        ...validInput,
        clientId: '  CID  ',
        clientSecret: '\tCS\n',
        jwt: '  JWT.TOKEN  ',
      },
    })
    expect(r).toEqual({ ok: true })
    const payload = JSON.parse(sm.addSecretVersion.mock.calls[0][0].payload.data.toString('utf8'))
    expect(payload).toEqual({ clientId: 'CID', clientSecret: 'CS', jwt: 'JWT.TOKEN' })
    // Firestore should also get trimmed server/fromNumber (they are non-sensitive but still trimmed)
    expect(_docs['organizations/acme/settings/textMessaging'].ringcentral).toEqual({
      server: 'https://platform.ringcentral.com',
      fromNumber: '+12815550100',
    })
  })
})
