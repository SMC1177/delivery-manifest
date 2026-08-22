import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '../contexts/AuthContext'
import {
  signInWithPopup,
  getMultiFactorResolver,
  OAuthProvider,
} from 'firebase/auth'
import { auth } from '../lib/firebase'

// Popup-specific mock factory. This file deliberately lives SEPARATE from
// AuthContext.test.jsx — that file's firebase/auth factory lacks the popup
// exports (signInWithPopup, getMultiFactorResolver, GoogleAuthProvider,
// OAuthProvider) this suite needs, and extending it under its passing tests
// would be exactly the blast radius this standalone suite avoids.

vi.mock('firebase/auth', () => {
  class GoogleAuthProvider {
    constructor() {
      this.providerId = 'google.com'
    }
  }
  class OAuthProvider {
    constructor(providerId) {
      this.providerId = providerId
    }
    setCustomParameters() {}
  }
  OAuthProvider.credentialFromError = vi.fn()
  return {
    onAuthStateChanged: vi.fn((_auth, cb) => {
      // Simulate no user signed in
      cb(null)
      return vi.fn() // unsubscribe
    }),
    signInWithEmailAndPassword: vi.fn(),
    createUserWithEmailAndPassword: vi.fn(),
    signOut: vi.fn(),
    sendEmailVerification: vi.fn(),
    multiFactor: vi.fn(),
    TotpMultiFactorGenerator: vi.fn(),
    getMultiFactorResolver: vi.fn(),
    GoogleAuthProvider,
    OAuthProvider,
    signInWithPopup: vi.fn(),
    linkWithCredential: vi.fn(),
  }
})

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(() => Promise.resolve({ exists: () => false })),
  setDoc: vi.fn(),
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(),
  serverTimestamp: vi.fn(() => new Date()),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

function Probe({ apiRef }) {
  const { signInWithGoogle, signInWithMicrosoft } = useAuth()
  useEffect(() => {
    apiRef.current = { signInWithGoogle, signInWithMicrosoft }
  })
  return null
}

async function renderProbe() {
  const apiRef = {}
  render(
    <AuthProvider>
      <Probe apiRef={apiRef} />
    </AuthProvider>
  )
  await waitFor(() => {
    expect(apiRef.current).toBeTruthy()
  })
  return apiRef
}

describe('AuthContext social sign-in MFA handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('signInWithGoogle resolves with the MFA resolver when the popup requires MFA', async () => {
    const err = { code: 'auth/multi-factor-auth-required' }
    const sentinel = { hints: [], resolveSignIn: vi.fn() }
    vi.mocked(signInWithPopup).mockRejectedValue(err)
    vi.mocked(getMultiFactorResolver).mockReturnValue(sentinel)

    const apiRef = await renderProbe()

    const result = await apiRef.current.signInWithGoogle()

    // Must RESOLVE to an { mfaRequired: true, resolver } object, mirroring the
    // login() branch at AuthContext.jsx:90-92 — NOT reject with the raw error.
    expect(result).toMatchObject({ mfaRequired: true, resolver: sentinel })
    expect(getMultiFactorResolver).toHaveBeenCalledWith(auth, err)
  })

  it('signInWithMicrosoft resolves with the MFA resolver when the popup requires MFA', async () => {
    const err = { code: 'auth/multi-factor-auth-required' }
    const sentinel = { hints: [], resolveSignIn: vi.fn() }
    vi.mocked(signInWithPopup).mockRejectedValue(err)
    vi.mocked(getMultiFactorResolver).mockReturnValue(sentinel)

    const apiRef = await renderProbe()

    const result = await apiRef.current.signInWithMicrosoft()

    expect(result).toMatchObject({ mfaRequired: true, resolver: sentinel })
    expect(getMultiFactorResolver).toHaveBeenCalledWith(auth, err)
  })

  it('signInWithMicrosoft keeps surfacing the account-exists-with-different-credential path', async () => {
    const err = { code: 'auth/account-exists-with-different-credential' }
    const pendingCred = { providerId: 'google.com' }
    vi.mocked(signInWithPopup).mockRejectedValue(err)
    vi.mocked(OAuthProvider.credentialFromError).mockReturnValue(pendingCred)

    const apiRef = await renderProbe()

    await expect(apiRef.current.signInWithMicrosoft()).rejects.toThrow(
      /sign in with Google first/
    )
    expect(OAuthProvider.credentialFromError).toHaveBeenCalledWith(err)
  })

  it('signInWithGoogle still rejects on non-MFA popup errors', async () => {
    const err = { code: 'auth/popup-closed-by-user' }
    vi.mocked(signInWithPopup).mockRejectedValue(err)

    const apiRef = await renderProbe()

    await expect(apiRef.current.signInWithGoogle()).rejects.toBe(err)
    expect(getMultiFactorResolver).not.toHaveBeenCalled()
  })
})
