import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-functions/v2/https', () => {
  class HttpsError extends Error {
    constructor(code, message) {
      super(message)
      this.code = code
    }
  }
  return {
    onCall: vi.fn((handler) => handler),
    HttpsError,
  }
})

const serverTimestampSentinel = { __serverTimestamp: true }
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: { serverTimestamp: vi.fn(() => serverTimestampSentinel) },
}))

vi.mock('../lib/admin-guard.js', () => ({
  requirePlatformAdmin: vi.fn(),
}))

import { getOrgSettings, updateOrgSettings } from '../admin-settings.js'
import { requirePlatformAdmin } from '../lib/admin-guard.js'
import { MASK_MARKER } from '../lib/settings-mask.js'

function makeFakeDb({ orgDocs = {}, settingsDocs = {}, auditAdd: auditAddMock } = {}) {
  const auditAdd = auditAddMock || vi.fn()
  const orgGet = vi.fn()
  const orgSet = vi.fn()
  const settingsGet = vi.fn()
  const settingsSet = vi.fn()

  function collectionImpl(path) {
    if (path.startsWith('organizations/') && path.endsWith('/settings')) {
      return {
        get: vi.fn().mockResolvedValue({
          docs: Object.entries(settingsDocs).map(([id, data]) => ({
            id,
            data: () => data,
          })),
        }),
      }
    }
    if (path === 'platformAudit') {
      return { add: auditAdd }
    }
    return {}
  }

  function docImpl(path) {
    if (path.startsWith('organizations/') && path.includes('/settings/')) {
      return {
        get: settingsGet,
        set: settingsSet,
      }
    }
    if (path.startsWith('organizations/')) {
      return {
        get: orgGet,
        set: orgSet,
      }
    }
    return {}
  }

  const fakeDb = {
    collection: vi.fn(collectionImpl),
    doc: vi.fn(docImpl),
  }

  return { fakeDb, orgGet, orgSet, settingsGet, settingsSet, auditAdd }
}

describe('admin-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOrgSettings', () => {
    it('1. Guard rejection short-circuits: requirePlatformAdmin rejects -> no firestore reads', async () => {
      requirePlatformAdmin.mockRejectedValue(new Error('permission-denied'))

      const { fakeDb } = makeFakeDb({})
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(getOrgSettings({ data: { orgSlug: 'test' } })).rejects.toThrow('permission-denied')
      expect(fakeDb.collection).not.toHaveBeenCalled()
      expect(fakeDb.doc).not.toHaveBeenCalled()
    })

    it('2. Masks secrets and excludes non-editable fields', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgData = {
        name: 'Acme RX',
        settings: { ringcentral: { clientSecret: 'RAW-SECRET', jwt: 'RAW-JWT' } },
        enabledFields: ['phone'],
        monthlyUsage: { '2026-05': { total: 10 } },
      }
      const settingsDocs = {
        textMessaging: { webhookToken: 'RAW-WH', optInPolicy: 'double_opt_in' },
      }

      const { fakeDb, orgGet } = makeFakeDb({ orgDocs: { 'acme': orgData }, settingsDocs })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgData })

      const result = await getOrgSettings({ data: { orgSlug: 'acme' } })

      const json = JSON.stringify(result)
      expect(json).toContain(MASK_MARKER)
      expect(json).toContain('double_opt_in')
      expect(json).not.toContain('RAW-SECRET')
      expect(json).not.toContain('RAW-JWT')
      expect(json).not.toContain('RAW-WH')
      expect(json).not.toContain('monthlyUsage')
    })

    it('3. Unknown orgSlug -> not-found', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const { fakeDb, orgGet } = makeFakeDb({})
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: false })

      await expect(getOrgSettings({ data: { orgSlug: 'nonexistent' } })).rejects.toThrow('Organization not found')
    })
  })

  describe('updateOrgSettings', () => {
    it('4. Guard rejection short-circuits: requirePlatformAdmin rejects -> no firestore reads/writes', async () => {
      requirePlatformAdmin.mockRejectedValue(new Error('permission-denied'))

      const { fakeDb } = makeFakeDb({})
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'org', updates: {}, reason: 'test' } })).rejects.toThrow('permission-denied')
      expect(fakeDb.collection).not.toHaveBeenCalled()
      expect(fakeDb.doc).not.toHaveBeenCalled()
    })

    it('5. Validation rejections: each throws, no writes', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const { fakeDb } = makeFakeDb({})
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      // target 'shipments'
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'shipments', updates: {}, reason: 'test' } })).rejects.toThrow('target must be "org" or "settings/<docId>"')
      expect(fakeDb.doc).not.toHaveBeenCalled()

      // target 'members'
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'members', updates: {}, reason: 'test' } })).rejects.toThrow('target must be "org" or "settings/<docId>"')

      // target 'settings/a/b'
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'settings/a/b', updates: {}, reason: 'test' } })).rejects.toThrow('Invalid settings docId')

      // target 'settings/..'
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'settings/..', updates: {}, reason: 'test' } })).rejects.toThrow('Invalid settings docId')

      // target 'org' with updates containing 'monthlyUsage'
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'org', updates: { monthlyUsage: {} }, reason: 'test' } })).rejects.toThrow('Key "monthlyUsage" is not allowed for target "org"')

      // missing reason
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'org', updates: {} } })).rejects.toThrow('reason required')

      // reason whitespace only
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'org', updates: {}, reason: '   ' } })).rejects.toThrow('reason required')

      // updates not an object
      await expect(updateOrgSettings({ data: { orgSlug: 'test', target: 'org', updates: 'string', reason: 'test' } })).rejects.toThrow('updates must be a plain object')

      expect(fakeDb.doc).not.toHaveBeenCalled()
    })

    it('6. Valid save to settings/textMessaging: mask markers stripped, audit masks secrets', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgData = {
        name: 'Acme',
        settings: { ringcentral: { clientSecret: 'OLD-SECRET' } },
        enabledFields: ['phone'],
      }
      const existingSettings = {
        textMessaging: { webhookToken: 'OLD-WH', optInPolicy: 'double_opt_in' },
      }

      const auditAdd = vi.fn().mockResolvedValue({})
      const { fakeDb, orgGet, settingsGet, settingsSet } = makeFakeDb({ orgDocs: { 'acme': orgData }, settingsDocs: existingSettings, auditAdd })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgData })
      settingsGet.mockResolvedValue({ exists: true, data: () => existingSettings.textMessaging })

      const updates = {
        webhookToken: MASK_MARKER,
        optInPolicy: 'auto_opt_in',
        clientSecret: 'NEW-RAW',
      }

      const result = await updateOrgSettings({ data: { orgSlug: 'acme', target: 'settings/textMessaging', updates, reason: 'update policy' } })

      expect(result).toEqual({ ok: true })

      // Verify set was called with stripped markers (marker-valued properties removed)
      expect(settingsSet).toHaveBeenCalledWith(
        expect.not.objectContaining({ webhookToken: expect.anything() }),
        { merge: true }
      )
      const written = settingsSet.mock.calls[0][0]
      expect(JSON.stringify(written)).not.toContain(MASK_MARKER)
      expect(written.optInPolicy).toBe('auto_opt_in')
      expect(written.clientSecret).toBe('NEW-RAW')

      // Verify audit add called with correct fields
      expect(auditAdd).toHaveBeenCalledWith({
        actor: 'admin1',
        actorEmail: 'admin@test.com',
        action: 'settings_update',
        orgSlug: 'acme',
        target: 'organizations/acme/settings/textMessaging',
        reason: 'update policy',
        before: expect.objectContaining({ webhookToken: MASK_MARKER, optInPolicy: 'double_opt_in' }),
        after: { clientSecret: MASK_MARKER, optInPolicy: 'auto_opt_in' },
        at: serverTimestampSentinel,
      })

      // Audit payload should not contain raw secrets
      const auditCallArg = auditAdd.mock.calls[0][0]
      const auditJson = JSON.stringify(auditCallArg)
      expect(auditJson).not.toContain('OLD-SECRET')
      expect(auditJson).not.toContain('NEW-RAW')
      expect(auditJson).not.toContain('OLD-WH')

      // Write payload should contain NEW-RAW (unmasked)
      const writeCallArg = settingsSet.mock.calls[0][0]
      expect(writeCallArg.clientSecret).toBe('NEW-RAW')
    })

    it('7. Audit-write failure -> call rejects with internal', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgData = {
        name: 'Acme',
        settings: {},
        enabledFields: ['phone'],
      }
      const auditAdd = vi.fn().mockRejectedValue(new Error('audit db error'))
      const { fakeDb, orgGet, settingsGet, settingsSet } = makeFakeDb({ orgDocs: { 'acme': orgData }, auditAdd })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgData })
      settingsGet.mockResolvedValue({ exists: true, data: () => ({}) })

      await expect(updateOrgSettings({ data: { orgSlug: 'acme', target: 'settings/textMessaging', updates: { optInPolicy: 'auto_opt_in' }, reason: 'test' } })).rejects.toThrow('audit write failed')

      // Verify set was called (write happened)
      expect(settingsSet).toHaveBeenCalled()
    })

    it('8. Valid save to target org with enabledFields', async () => {
      requirePlatformAdmin.mockResolvedValue({ uid: 'admin1', email: 'admin@test.com' })

      const orgData = {
        name: 'Acme',
        settings: {},
        enabledFields: ['phone'],
      }
      const auditAdd = vi.fn().mockResolvedValue({})
      const { fakeDb, orgGet, orgSet } = makeFakeDb({ orgDocs: { 'acme': orgData }, auditAdd })
      const { getFirestore } = await import('firebase-admin/firestore')
      getFirestore.mockReturnValue(fakeDb)

      orgGet.mockResolvedValue({ exists: true, data: () => orgData })

      const result = await updateOrgSettings({ data: { orgSlug: 'acme', target: 'org', updates: { enabledFields: ['phone', 'rx'] }, reason: 'enable rx' } })

      expect(result).toEqual({ ok: true })
      expect(orgSet).toHaveBeenCalledWith({ enabledFields: ['phone', 'rx'] }, { merge: true })
      expect(auditAdd).toHaveBeenCalledWith({
        actor: 'admin1',
        actorEmail: 'admin@test.com',
        action: 'settings_update',
        orgSlug: 'acme',
        target: 'organizations/acme',
        reason: 'enable rx',
        before: expect.objectContaining({ enabledFields: ['phone'] }),
        after: expect.objectContaining({ enabledFields: ['phone', 'rx'] }),
        at: serverTimestampSentinel,
      })
    })
  })
})
