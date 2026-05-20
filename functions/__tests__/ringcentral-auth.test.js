import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getAccessToken, _clearTokenCache } from '../ringcentral-auth.js'

beforeEach(() => {
  _clearTokenCache()
  vi.restoreAllMocks()
})

const creds = {
  clientId: 'CID',
  clientSecret: 'CSECRET',
  jwt: 'JWT.TOKEN.HERE',
  server: 'https://platform.ringcentral.com',
}

describe('getAccessToken', () => {
  it('exchanges JWT for access token and returns it', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'AT123', expires_in: 3600 }),
    })

    const token = await getAccessToken(creds)
    expect(token).toBe('AT123')

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://platform.ringcentral.com/restapi/oauth/token')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toMatch(/^Basic /)
    expect(opts.body.toString()).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(opts.body.toString()).toContain('assertion=JWT.TOKEN.HERE')
  })

  it('caches the token by clientId so a second call does NOT re-fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'AT123', expires_in: 3600 }),
    })

    await getAccessToken(creds)
    await getAccessToken(creds)

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('re-fetches when cached token has expired', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'AT123', expires_in: 1 }),
    })

    await getAccessToken(creds, { now: () => 1000 })
    // 2000ms later, token has expired (lifetime 1s)
    await getAccessToken(creds, { now: () => 3000 })

    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('throws with RC error body on 4xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant","error_description":"JWT expired"}',
    })

    await expect(getAccessToken(creds)).rejects.toThrow(/JWT expired|invalid_grant|401/)
  })

  it('caches per-clientId so different orgs do not share tokens', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT-A', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT-B', expires_in: 3600 }) })

    const tokenA = await getAccessToken({ ...creds, clientId: 'A' })
    const tokenB = await getAccessToken({ ...creds, clientId: 'B' })

    expect(tokenA).toBe('AT-A')
    expect(tokenB).toBe('AT-B')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
