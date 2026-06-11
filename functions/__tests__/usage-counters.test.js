import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: vi.fn((path, handler) => ({ path, handler })),
  onDocumentDeleted: vi.fn((path, handler) => ({ path, handler })),
}))

const setMock = vi.fn()
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({ doc: vi.fn(() => ({ set: setMock })) })),
  FieldValue: { increment: vi.fn((n) => ({ __inc: n })) },
}))

import { onShipmentCreatedUsage, onShipmentDeletedUsage } from '../usage-counters.js'

function makeEvent({ data, params, time }) {
  return {
    data: data ? { data: () => data } : undefined,
    params: params || {},
    time: time || new Date().toISOString(),
  }
}

describe('usage-counters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('onShipmentCreatedUsage', () => {
    it('1. CREATE with createdAt Timestamp-like for 2026-05-15 UTC noon, carrier ups', async () => {
      const event = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'ups' },
        params: { orgSlug: 'acme', shipmentId: 's1' },
        time: '2026-05-15T12:00:00Z',
      })
      await onShipmentCreatedUsage.handler(event)
      expect(setMock).toHaveBeenCalledTimes(1)
      expect(setMock).toHaveBeenCalledWith(
        {
          shipmentCount: { __inc: 1 },
          monthlyUsage: {
            '2026-05': {
              ups: { __inc: 1 },
              total: { __inc: 1 },
            },
          },
        },
        { merge: true }
      )
    })

    it('2. CREATE with legacy uppercase carrier UPS -> bucket ups', async () => {
      const event = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'UPS' },
        params: { orgSlug: 'acme', shipmentId: 's2' },
        time: '2026-05-15T12:00:00Z',
      })
      await onShipmentCreatedUsage.handler(event)
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          monthlyUsage: expect.objectContaining({
            '2026-05': expect.objectContaining({
              ups: { __inc: 1 },
            }),
          }),
        }),
        { merge: true }
      )
    })

    it('3. CREATE with carrier dhl and with carrier undefined -> bucket other; handler does not throw', async () => {
      const event1 = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'dhl' },
        params: { orgSlug: 'acme', shipmentId: 's3' },
        time: '2026-05-15T12:00:00Z',
      })
      const event2 = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') } },
        params: { orgSlug: 'acme', shipmentId: 's4' },
        time: '2026-05-15T12:00:00Z',
      })
      await expect(onShipmentCreatedUsage.handler(event1)).resolves.toBeUndefined()
      await expect(onShipmentCreatedUsage.handler(event2)).resolves.toBeUndefined()
      expect(setMock).toHaveBeenCalledTimes(2)
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          monthlyUsage: expect.objectContaining({
            '2026-05': expect.objectContaining({
              other: { __inc: 1 },
            }),
          }),
        }),
        { merge: true }
      )
    })

    it('4. CREATE with no createdAt but event.time fallback -> month 2026-06', async () => {
      const event = makeEvent({
        data: { carrier: 'fedex' },
        params: { orgSlug: 'acme', shipmentId: 's5' },
        time: '2026-06-02T01:00:00Z',
      })
      await onShipmentCreatedUsage.handler(event)
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          monthlyUsage: expect.objectContaining({
            '2026-06': expect.objectContaining({
              fedex: { __inc: 1 },
              total: { __inc: 1 },
            }),
          }),
        }),
        { merge: true }
      )
    })

    it('7. event.data undefined -> setMock NOT called, no throw', async () => {
      const event = makeEvent({ data: undefined, params: { orgSlug: 'acme', shipmentId: 's6' } })
      await expect(onShipmentCreatedUsage.handler(event)).resolves.toBeUndefined()
      expect(setMock).not.toHaveBeenCalled()
    })

    it('8. Error path: setMock rejects -> handler resolves, console.error called', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setMock.mockRejectedValueOnce(new Error('boom'))
      const event = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'ups' },
        params: { orgSlug: 'acme', shipmentId: 's7' },
        time: '2026-05-15T12:00:00Z',
      })
      await expect(onShipmentCreatedUsage.handler(event)).resolves.toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalled()
      consoleErrorSpy.mockRestore()
    })
  })

  describe('onShipmentDeletedUsage', () => {
    it('5. DELETE of shipment with createdAt May, event.time June -> decrement on 2026-05', async () => {
      const event = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'ups' },
        params: { orgSlug: 'acme', shipmentId: 's8' },
        time: '2026-06-15T12:00:00Z',
      })
      await onShipmentDeletedUsage.handler(event)
      expect(setMock).toHaveBeenCalledWith(
        {
          shipmentCount: { __inc: -1 },
          monthlyUsage: {
            '2026-05': {
              ups: { __inc: -1 },
              total: { __inc: -1 },
            },
          },
        },
        { merge: true }
      )
    })

    it('6. DELETE with no recoverable created month -> setMock called with only shipmentCount, console.warn called, no PHI', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const event = makeEvent({
        data: { carrier: 'ups', patientName: 'SECRET-NAME' },
        params: { orgSlug: 'acme', shipmentId: 's9' },
        time: '2026-06-15T12:00:00Z',
      })
      await onShipmentDeletedUsage.handler(event)
      expect(setMock).toHaveBeenCalledWith(
        { shipmentCount: { __inc: -1 } },
        { merge: true }
      )
      expect(consoleWarnSpy).toHaveBeenCalled()
      const warnArgs = consoleWarnSpy.mock.calls.map(call => call.join(' '))
      for (const arg of warnArgs) {
        expect(arg).not.toContain('SECRET-NAME')
      }
      consoleWarnSpy.mockRestore()
    })

    it('7. event.data undefined -> setMock NOT called, no throw', async () => {
      const event = makeEvent({ data: undefined, params: { orgSlug: 'acme', shipmentId: 's10' } })
      await expect(onShipmentDeletedUsage.handler(event)).resolves.toBeUndefined()
      expect(setMock).not.toHaveBeenCalled()
    })

    it('8. Error path: setMock rejects -> handler resolves, console.error called', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setMock.mockRejectedValueOnce(new Error('boom'))
      const event = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'ups' },
        params: { orgSlug: 'acme', shipmentId: 's11' },
        time: '2026-06-15T12:00:00Z',
      })
      await expect(onShipmentDeletedUsage.handler(event)).resolves.toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalled()
      consoleErrorSpy.mockRestore()
    })

    it('9. PHI-free logging: warn/error args do not contain patientName/address/rxNumbers', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // Test warn path (no monthKey)
      const eventWarn = makeEvent({
        data: { carrier: 'ups', patientName: 'SECRET-NAME', address: '123 Main St', rxNumbers: ['RX1'] },
        params: { orgSlug: 'acme', shipmentId: 's12' },
        time: '2026-06-15T12:00:00Z',
      })
      await onShipmentDeletedUsage.handler(eventWarn)
      // Test error path (force setMock to reject)
      setMock.mockRejectedValueOnce(new Error('boom'))
      const eventError = makeEvent({
        data: { createdAt: { toDate: () => new Date('2026-05-15T12:00:00Z') }, carrier: 'ups', patientName: 'SECRET-NAME', address: '123 Main St', rxNumbers: ['RX1'] },
        params: { orgSlug: 'acme', shipmentId: 's13' },
        time: '2026-06-15T12:00:00Z',
      })
      await onShipmentDeletedUsage.handler(eventError)
      const allCalls = [...consoleWarnSpy.mock.calls, ...consoleErrorSpy.mock.calls]
      for (const call of allCalls) {
        const joined = call.join(' ')
        expect(joined).not.toContain('SECRET-NAME')
        expect(joined).not.toContain('123 Main St')
        expect(joined).not.toContain('RX1')
      }
      consoleWarnSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    })
  })
})
