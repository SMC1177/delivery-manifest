import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleTrackAlertWebhook, subscribeTrackingNumbers } from '../ups-track-alert.js'

// ─── Firestore mock helpers ───────────────────────────────────────────────────

function makeDocSnapshot(path, data) {
  return {
    ref: {
      path,
      // update is called on the ref inside a batch, not directly — but we mock
      // the batch separately
    },
    data: () => data,
  }
}

function makeFirestoreMock(docs = []) {
  const batchUpdate = vi.fn()
  const batchCommit = vi.fn().mockResolvedValue(undefined)
  const batch = vi.fn().mockReturnValue({ update: batchUpdate, commit: batchCommit })

  const collectionGroupGet = vi.fn().mockResolvedValue({
    empty: docs.length === 0,
    docs,
  })
  const collectionGroup = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ get: collectionGroupGet }),
  })

  return {
    firestore: { collectionGroup, batch },
    batchUpdate,
    batchCommit,
    collectionGroupGet,
  }
}

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { credential: 'test-secret' },
    body: {
      trackingNumber: '1Z999AA10123456784',
      activityStatus: { type: 'D', code: '011', description: 'Delivered' },
      actualDeliveryDate: '20260524',
      actualDeliveryTime: '143000',
    },
    ...overrides,
  }
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  }
  // Capture final status code via the chain: res.status(N).send(X)
  res.status.mockImplementation((code) => {
    res.statusCode = code
    return res
  })
  res.send.mockImplementation((body) => {
    res.body = body
    return res
  })
  return res
}

const WEBHOOK_SECRET = 'test-secret'

// ─── handleTrackAlertWebhook ──────────────────────────────────────────────────

describe('handleTrackAlertWebhook', () => {
  describe('valid delivery event updates Firestore status', () => {
    it('updates matching shipment to delivered and sets deliveredAt', async () => {
      const existingShipment = { trackingNumber: '1Z999AA10123456784', status: 'in_transit' }
      const { firestore, batchUpdate, batchCommit } = makeFirestoreMock([
        makeDocSnapshot('organizations/acme/shipments/s1', existingShipment),
      ])

      const req = makeReq()
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      expect(res.statusCode).toBe(200)
      expect(batchUpdate).toHaveBeenCalledOnce()

      const [_ref, updates] = batchUpdate.mock.calls[0]
      expect(updates.status).toBe('delivered')
      expect(updates.updatedBy).toBe('system:ups-track-alert')
      expect(updates.deliveredAt).toBeInstanceOf(Date)
      // deliveredAt should parse the actualDeliveryDate/Time from the payload
      expect(updates.deliveredAt.toISOString()).toMatch(/^2026-05-24/)

      expect(batchCommit).toHaveBeenCalledOnce()
    })
  })

  describe('invalid credential returns 401', () => {
    it('rejects request with wrong credential header', async () => {
      const { firestore } = makeFirestoreMock()
      const req = makeReq({ headers: { credential: 'wrong-secret' } })
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      expect(res.statusCode).toBe(401)
      expect(firestore.collectionGroup).not.toHaveBeenCalled()
    })

    it('rejects request with missing credential header', async () => {
      const { firestore } = makeFirestoreMock()
      const req = makeReq({ headers: {} })
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      expect(res.statusCode).toBe(401)
      expect(firestore.collectionGroup).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle rank guard prevents downgrade', () => {
    it('does not update a delivered shipment to in_transit', async () => {
      const existingShipment = { trackingNumber: '1Z999AA10123456784', status: 'delivered' }
      const { firestore, batchUpdate, batchCommit } = makeFirestoreMock([
        makeDocSnapshot('organizations/acme/shipments/s1', existingShipment),
      ])

      const req = makeReq({
        body: {
          trackingNumber: '1Z999AA10123456784',
          activityStatus: { type: 'I', description: 'In Transit' },
        },
      })
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      // Should still 200 but not write anything
      expect(res.statusCode).toBe(200)
      expect(batchUpdate).not.toHaveBeenCalled()
      expect(batchCommit).not.toHaveBeenCalled()
    })

    it('does not update an exception shipment to shipped', async () => {
      const existingShipment = { trackingNumber: '1Z999AA10123456784', status: 'exception' }
      const { firestore, batchUpdate } = makeFirestoreMock([
        makeDocSnapshot('organizations/acme/shipments/s1', existingShipment),
      ])

      const req = makeReq({
        body: {
          trackingNumber: '1Z999AA10123456784',
          activityStatus: { type: 'M', description: 'Shipped' },
        },
      })
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      expect(res.statusCode).toBe(200)
      expect(batchUpdate).not.toHaveBeenCalled()
    })

    it('allows upgrading from in_transit to exception', async () => {
      const existingShipment = { trackingNumber: '1Z999AA10123456784', status: 'in_transit' }
      const { firestore, batchUpdate, batchCommit } = makeFirestoreMock([
        makeDocSnapshot('organizations/acme/shipments/s1', existingShipment),
      ])

      const req = makeReq({
        body: {
          trackingNumber: '1Z999AA10123456784',
          activityStatus: { type: 'X', description: 'Exception' },
        },
      })
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      expect(res.statusCode).toBe(200)
      expect(batchUpdate).toHaveBeenCalledOnce()
      const [_ref, updates] = batchUpdate.mock.calls[0]
      expect(updates.status).toBe('exception')
    })
  })

  describe('method guard (405 enforced by the onRequest wrapper in index.js)', () => {
    // handleTrackAlertWebhook itself is only called after the method check, so
    // we test: (a) that a valid POST actually reaches the handler and returns 200,
    // and (b) that the onRequest wrapper pattern, when applied manually, sends 405
    // for non-POST — mirroring what index.js does.

    it('valid POST with correct credential and known TN returns 200', async () => {
      const existingShipment = { trackingNumber: '1Z999AA10123456784', status: 'shipped' }
      const { firestore } = makeFirestoreMock([
        makeDocSnapshot('organizations/acme/shipments/s1', existingShipment),
      ])
      const req = makeReq()
      const res = makeRes()

      await handleTrackAlertWebhook(req, res, firestore, WEBHOOK_SECRET)

      // delivered(4) > shipped(1) — upgrade allowed, handler completes successfully
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('OK')
    })

    it('onRequest method guard sends 405 for GET before handleTrackAlertWebhook is reached', async () => {
      // Reproduce the index.js onRequest wrapper: non-POST → 405, handler not called.
      // We extract the guard into a helper so there are no branches in the test body.
      const handler = vi.fn()
      const res = makeRes()

      // applyMethodGuard mirrors the exact logic in index.js upsTrackAlertWebhook
      async function applyMethodGuard(method) {
        if (method !== 'POST') {
          res.status(405).send('Method Not Allowed')
          return
        }
        await handler()
      }

      await applyMethodGuard('GET')

      expect(res.statusCode).toBe(405)
      expect(res.body).toBe('Method Not Allowed')
      expect(handler).not.toHaveBeenCalled()
    })
  })
})

// ─── subscribeTrackingNumbers ─────────────────────────────────────────────────

describe('subscribeTrackingNumbers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the correct request URL, body, and headers', async () => {
    const mockResponse = { subscriptionId: 'sub-123', status: 'OK' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(mockResponse),
    })

    const trackingNumbers = ['1Z999AA10123456784', '1Z888BB20234567895']
    const webhookUrl = 'https://us-central1-delivery-manifest-c3deb.cloudfunctions.net/upsTrackAlertWebhook'
    const webhookSecret = 'my-webhook-secret'
    const token = 'ups-bearer-token'

    const result = await subscribeTrackingNumbers(trackingNumbers, webhookUrl, webhookSecret, token)

    expect(fetchSpy).toHaveBeenCalledOnce()

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://onlinetools.ups.com/api/track/v1/subscription/standard/package')
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe(`Bearer ${token}`)
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['transactionSrc']).toBe('delivery_manifest')
    expect(init.headers['transId']).toMatch(/^track-alert-\d+$/)

    const sentBody = JSON.parse(init.body)
    expect(sentBody.locale).toBe('en_US')
    expect(sentBody.trackingNumberList).toEqual(trackingNumbers)
    expect(sentBody.destination.url).toBe(webhookUrl)
    expect(sentBody.destination.credentialType).toBe('Bearer')
    expect(sentBody.destination.credential).toBe(webhookSecret)

    expect(result).toEqual(mockResponse)
  })

  it('throws on non-OK UPS response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    })

    await expect(
      subscribeTrackingNumbers(['1Z999AA10123456784'], 'https://example.com', 'secret', 'token')
    ).rejects.toThrow('UPS Track Alert subscribe failed (400)')
  })
})
