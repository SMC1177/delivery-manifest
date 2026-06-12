import { describe, it, expect, vi, beforeEach } from 'vitest'

let capturedCode, capturedMessage
vi.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    constructor(code, message) {
      super(message)
      this.code = code
      capturedCode = code
      capturedMessage = message
    }
  },
}))

const mockDoc = vi.fn()
const mockGet = vi.fn()
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({ doc: mockDoc })),
}))

import { requirePlatformAdmin } from '../lib/admin-guard.js'

describe('requirePlatformAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedCode = undefined
    capturedMessage = undefined
    mockDoc.mockReturnValue({ get: mockGet })
  })

  it('1. request with no auth → rejects with HttpsError code unauthenticated', async () => {
    const request = {}
    await expect(requirePlatformAdmin(request)).rejects.toThrow('Login required')
    expect(capturedCode).toBe('unauthenticated')
  })

  it('2. authed uid whose userProfiles doc does not exist → rejects permission-denied', async () => {
    mockGet.mockResolvedValue({ exists: false })
    const request = { auth: { uid: 'uid1' }, headers: {} }
    await expect(requirePlatformAdmin(request)).rejects.toThrow('Admin access required')
    expect(capturedCode).toBe('permission-denied')
  })

  it('3. profile exists, no platformAdmin field → rejects permission-denied', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({}) })
    const request = { auth: { uid: 'uid2' }, headers: {} }
    await expect(requirePlatformAdmin(request)).rejects.toThrow('Admin access required')
    expect(capturedCode).toBe('permission-denied')
  })

  it('4. platformAdmin: false → rejects permission-denied', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ platformAdmin: false }) })
    const request = { auth: { uid: 'uid3' }, headers: {} }
    await expect(requirePlatformAdmin(request)).rejects.toThrow('Admin access required')
    expect(capturedCode).toBe('permission-denied')
  })

  it('5. platformAdmin: yes (truthy string) → rejects permission-denied (strict === true)', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ platformAdmin: 'yes' }) })
    const request = { auth: { uid: 'uid4' }, headers: {} }
    await expect(requirePlatformAdmin(request)).rejects.toThrow('Admin access required')
    expect(capturedCode).toBe('permission-denied')
  })

  it('6. platformAdmin: true → resolves to { uid, email } using request.auth.token.email', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ platformAdmin: true }) })
    const request = { auth: { uid: 'uid5', token: { email: 'admin@example.com' } }, headers: {} }
    const result = await requirePlatformAdmin(request)
    expect(result).toEqual({ uid: 'uid5', email: 'admin@example.com' })
  })

  it('7. platformAdmin: true with no token email → email null', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ platformAdmin: true }) })
    const request = { auth: { uid: 'uid6', token: {} }, headers: {} }
    const result = await requirePlatformAdmin(request)
    expect(result).toEqual({ uid: 'uid6', email: null })
  })

  it('8. INFO-LEAK GUARD: rejection message for missing doc and non-admin are identical', async () => {
    // case 2: missing doc
    mockGet.mockResolvedValue({ exists: false })
    const request1 = { auth: { uid: 'uid7' }, headers: {} }
    await expect(requirePlatformAdmin(request1)).rejects.toThrow()
    const msg1 = capturedMessage

    // case 4: non-admin
    mockGet.mockResolvedValue({ exists: true, data: () => ({ platformAdmin: false }) })
    const request2 = { auth: { uid: 'uid8' }, headers: {} }
    await expect(requirePlatformAdmin(request2)).rejects.toThrow()
    const msg2 = capturedMessage

    expect(msg1).toBe(msg2)
  })
})
