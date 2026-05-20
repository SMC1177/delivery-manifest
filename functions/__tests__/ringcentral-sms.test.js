import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendRingCentralSms } from '../ringcentral-sms.js'
import { _clearTokenCache } from '../ringcentral-auth.js'

beforeEach(() => {
  _clearTokenCache()
  vi.restoreAllMocks()
})

const creds = {
  clientId: 'C', clientSecret: 'S', jwt: 'J', server: 'https://platform.ringcentral.com',
}

describe('sendRingCentralSms', () => {
  it('POSTs to the SMS endpoint with Bearer token and returns messageId', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({  // auth call
        ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({  // SMS call
        ok: true, json: async () => ({ id: 'msg-456' }),
      })

    const result = await sendRingCentralSms({
      creds,
      from: '+12815550100',
      to: '+12815550200',
      text: 'Hello',
    })

    expect(result.messageId).toBe('msg-456')
    const [url, opts] = global.fetch.mock.calls[1]
    expect(url).toBe('https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer AT')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({
      from: { phoneNumber: '+12815550100' },
      to: [{ phoneNumber: '+12815550200' }],
      text: 'Hello',
    })
  })

  it('throws with RC error body on 4xx', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({
        ok: false, status: 400,
        text: async () => '{"errorCode":"InvalidParameter","message":"Phone is invalid"}',
      })

    await expect(sendRingCentralSms({ creds, from: '+1', to: '+1', text: 'x' }))
      .rejects.toThrow(/Phone is invalid|InvalidParameter|400/)
  })
})
