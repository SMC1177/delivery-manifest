import { describe, it, expect, vi } from 'vitest'
import { checkOptInPolicy, GATE_ERRORS } from '../sms-gates.js'
import { onShipmentStatusChange, STATUS_TEMPLATE_KEYS } from '../sms-status-trigger.js'

// Grey patient: NO smsContacts document exists, so the contact passed to
// checkOptInPolicy is null. w6-1 is the operator's direct question — what does
// EACH policy value actually produce for such a patient, not what a spec says
// it should. Every assertion below is the exact return value the current code
// produces, read from the source, not guessed.
describe('w6-1: checkOptInPolicy for a patient with no smsContacts document', () => {
  const grey = { contact: null }

  describe('double_opt_in', () => {
    it('refuses every template except the invite itself', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'double_opt_in' }, ...grey, templateKey: 'delivered' })
      ).toEqual({
        ok: false,
        code: GATE_ERRORS.OPT_IN_REQUIRED,
        message: 'This patient has not opted in to text messages yet. Send the opt-in invite first.',
      })
    })

    it('permits the opt-in invite exactly, without auto-creating the contact', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'double_opt_in' }, ...grey, templateKey: 'optInInvite' })
      ).toEqual({ ok: true })
    })
  })

  describe('auto_opt_in', () => {
    it('passes any template and flags that the contact record must be created', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'auto_opt_in' }, ...grey, templateKey: 'delivered' })
      ).toEqual({ ok: true, autoCreateOptedIn: true })
    })

    it('passes even the invite template for a grey patient', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'auto_opt_in' }, ...grey, templateKey: 'optInInvite' })
      ).toEqual({ ok: true, autoCreateOptedIn: true })
    })
  })

  describe('manual_confirm', () => {
    it('refuses until a human affirms consent', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'manual_confirm' }, ...grey, templateKey: 'delivered' })
      ).toEqual({
        ok: false,
        code: GATE_ERRORS.CONSENT_NOT_AFFIRMED,
        message: 'You must confirm patient consent before sending.',
      })
    })

    it('passes once consent is affirmed', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'manual_confirm' }, ...grey, templateKey: 'delivered', consentAffirmed: true })
      ).toEqual({ ok: true })
    })
  })

  describe('values the code does not recognize', () => {
    it('silently falls back to auto_opt_in when the policy is missing', () => {
      expect(checkOptInPolicy({ settings: {}, ...grey, templateKey: 'delivered' })).toEqual({ ok: true, autoCreateOptedIn: true })
      expect(checkOptInPolicy({ settings: {}, ...grey, templateKey: 'optInInvite' })).toEqual({ ok: true, autoCreateOptedIn: true })
    })

    it('an unknown truthy policy value keeps the double_opt_in tail (warned); only a MISSING policy falls back to auto_opt_in', () => {
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'triple_opt_in' }, ...grey, templateKey: 'delivered' })
      ).toEqual({
        ok: false,
        code: GATE_ERRORS.OPT_IN_REQUIRED,
        message: 'This patient has not opted in to text messages yet. Send the opt-in invite first.',
      })
      expect(
        checkOptInPolicy({ settings: { optInPolicy: 'triple_opt_in' }, ...grey, templateKey: 'optInInvite' })
      ).toEqual({ ok: true })
    })
  })
})

/**
 * The trigger is driven against the REAL enqueue and a mock firestore, not a
 * stubbed enqueue. That matters: the guarantee under test is that one delivery
 * event yields one queued notification, and that guarantee lives in the queue's
 * document key. A spy would only prove the trigger called something.
 */
function makeMockFirestore() {
  const notifications = new Map()
  const ledger = new Map()
  const refs = new Map()

  function refFor(path) {
    if (!refs.has(path)) {
      refs.set(path, { _path: path })
    }
    return refs.get(path)
  }

  // enqueue writes BOTH the ledger claim (claimSend) and the queue item, so the
  // tests' queue views (notifications.size, [...notifications.values()]) must
  // count only queue documents. Partition by path at write time; reads consult
  // both maps so the idempotency claim round-trip in claimSend still works.
  const isQueuePath = (path) => path.includes('settings/textMessaging/queue/')

  const firestore = {
    doc: vi.fn((path) => refFor(path)),
    runTransaction: vi.fn(async (fn) =>
      fn({
        get: vi.fn(async (ref) => {
          const entry = notifications.get(ref._path) ?? ledger.get(ref._path)
          return { exists: entry !== undefined, data: () => entry ?? {} }
        }),
        set: vi.fn((ref, data) => {
          const map = isQueuePath(ref._path) ? notifications : ledger
          map.set(ref._path, data)
        }),
      })
    ),
  }
  return { firestore, notifications, ledger }
}

const ORG = 'acme'
const NOW = new Date('2026-08-13T12:00:00.000Z')
const TRACK = '1Z999AA10123456784'

const shipment = (overrides = {}) => ({
  id: 's_1',
  status: 'pending',
  trackingNumber: TRACK,
  patientName: 'John Doe',
  ...overrides,
})

const fire = (firestore, before, after) =>
  onShipmentStatusChange({ firestore, before, after, orgSlug: ORG, shipmentId: 's_1', now: NOW })

// w6-3: an opt-in invitation is never enqueued AUTOMATICALLY. Only a deliberate
// action or an explicitly permissive policy may produce one. The trigger's only
// template source is STATUS_TEMPLATE_KEYS, so firing it for every notifying
// transition must never yield 'optInInvite' — exactly the w6-3 red invariant.
describe('w6-3: the status trigger never auto-enqueues an opt-in invite', () => {
  it('optInInvite is not one of the trigger template keys at all', () => {
    expect(Object.values(STATUS_TEMPLATE_KEYS)).not.toContain('optInInvite')
  })

  it('every notifying status transition enqueues only the STATUS_TEMPLATE_KEYS value for that status', async () => {
    for (const [status, templateKey] of Object.entries(STATUS_TEMPLATE_KEYS)) {
      const { firestore, notifications } = makeMockFirestore()
      await fire(firestore, shipment({ status: 'pending' }), shipment({ status }))
      expect(notifications.size, `transition into ${status}`).toBe(1)
      const [item] = [...notifications.values()]
      expect(item.templateKey, `transition into ${status}`).toBe(templateKey)
      expect(item.templateKey, `transition into ${status}`).not.toBe('optInInvite')
    }
  })

  it('the tracking-arrival fire path also enqueues only the status template key', async () => {
    for (const [status, templateKey] of Object.entries(STATUS_TEMPLATE_KEYS)) {
      const { firestore, notifications } = makeMockFirestore()
      await fire(
        firestore,
        shipment({ status, trackingNumber: '' }),
        shipment({ status, trackingNumber: TRACK })
      )
      expect(notifications.size, `tracking arrival for ${status}`).toBe(1)
      const [item] = [...notifications.values()]
      expect(item.templateKey, `tracking arrival for ${status}`).toBe(templateKey)
      expect(item.templateKey, `tracking arrival for ${status}`).not.toBe('optInInvite')
    }
  })
})

describe('checkOptInPolicy seam — both send paths call the gate', () => {
  const sourceOf = async (rel) => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(new URL(rel, import.meta.url), 'utf8')
  }

  it('the manual send path imports and calls checkOptInPolicy', async () => {
    const src = await sourceOf('../sms-send.js')
    expect(src).toContain("checkOptInPolicy")
    expect(src).toContain("from './sms-gates.js'")
    expect(src).toMatch(/checkOptInPolicy\(\{/)
  })

  it('the automated queue-send path imports and calls checkOptInPolicy', async () => {
    const src = await sourceOf('../sms-queue-send.js')
    expect(src).toContain("checkOptInPolicy")
    expect(src).toContain("from './sms-gates.js'")
    expect(src).toMatch(/checkOptInPolicy\(\{/)
  })
})
