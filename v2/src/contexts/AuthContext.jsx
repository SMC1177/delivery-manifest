import { createContext, useContext, useState, useEffect } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendEmailVerification,
  TotpMultiFactorGenerator,
  getMultiFactorResolver,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  linkWithCredential,
} from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'

const AuthContext = createContext(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [userData, setUserData] = useState(null)
  const [orgSlug, setOrgSlug] = useState(null)
  const [loading, setLoading] = useState(true)
  const [mfaResolver, setMfaResolver] = useState(null)
  const [pendingMicrosoftCred, setPendingMicrosoftCred] = useState(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser)
      if (firebaseUser) {
        await loadUserData(firebaseUser.uid)
      } else {
        setUserData(null)
        setOrgSlug(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  async function loadUserData(uid) {
    try {
      const userSnap = await getDoc(doc(db, 'userProfiles', uid))
      if (userSnap.exists()) {
        const profile = userSnap.data()
        if (profile.orgSlug) {
          setOrgSlug(profile.orgSlug)
          const memberSnap = await getDoc(
            doc(db, 'organizations', profile.orgSlug, 'members', uid)
          )
          if (memberSnap.exists()) {
            setUserData(memberSnap.data())
          }
        } else {
          setOrgSlug(null)
          setUserData(null)
        }
      } else {
        setOrgSlug(null)
        setUserData(null)
      }
    } catch (err) {
      console.error('Error loading user data:', err)
      setOrgSlug(null)
      setUserData(null)
    }
  }

  async function login(email, password) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      await loadUserData(cred.user.uid)
      return { user: cred.user, mfaRequired: false }
    } catch (err) {
      if (err.code === 'auth/multi-factor-auth-required') {
        const resolver = getMultiFactorResolver(auth, err)
        setMfaResolver(resolver)
        return { user: null, mfaRequired: true, resolver }
      }
      throw err
    }
  }

  async function completeMfaLogin(otpCode) {
    if (!mfaResolver) throw new Error('No MFA resolver available')
    const totpHint = mfaResolver.hints.find(
      (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID
    )
    if (!totpHint) throw new Error('No TOTP factor enrolled')
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, otpCode)
    const cred = await mfaResolver.resolveSignIn(assertion)
    setMfaResolver(null)
    await loadUserData(cred.user.uid)
    return cred.user
  }

  async function signInWithGoogle() {
    const provider = new GoogleAuthProvider()
    const cred = await signInWithPopup(auth, provider)
    // Create user profile if it doesn't exist
    const profileSnap = await getDoc(doc(db, 'userProfiles', cred.user.uid))
    if (!profileSnap.exists()) {
      await setDoc(doc(db, 'userProfiles', cred.user.uid), {
        email: cred.user.email,
        name: cred.user.displayName || cred.user.email,
        orgSlug: null,
      })
    } else {
      await loadUserData(cred.user.uid)
    }
    // If there's a pending Microsoft credential, link it now
    if (pendingMicrosoftCred) {
      try {
        await linkWithCredential(cred.user, pendingMicrosoftCred)
        console.log('Microsoft account linked successfully')
      } catch (linkErr) {
        console.warn('Failed to link Microsoft credential:', linkErr)
      }
      setPendingMicrosoftCred(null)
    }
    return cred.user
  }

  async function signInWithMicrosoft() {
    const provider = new OAuthProvider('microsoft.com')
    provider.setCustomParameters({ prompt: 'select_account' })
    try {
      const cred = await signInWithPopup(auth, provider)
      const profileSnap = await getDoc(doc(db, 'userProfiles', cred.user.uid))
      if (!profileSnap.exists()) {
        await setDoc(doc(db, 'userProfiles', cred.user.uid), {
          email: cred.user.email,
          name: cred.user.displayName || cred.user.email,
          orgSlug: null,
        })
      } else {
        await loadUserData(cred.user.uid)
      }
      return cred.user
    } catch (err) {
      if (err.code === 'auth/account-exists-with-different-credential') {
        // Store pending credential for linking after Google sign-in
        const pendingCred = OAuthProvider.credentialFromError(err)
        if (pendingCred) {
          setPendingMicrosoftCred(pendingCred)
        }
        throw new Error(
          'This email is already registered with Google. Please sign in with Google first — Microsoft will be linked automatically.'
        )
      }
      throw err
    }
  }

  async function register(email, password, name) {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    await sendEmailVerification(cred.user)
    await setDoc(doc(db, 'userProfiles', cred.user.uid), {
      email,
      name,
      orgSlug: null,
    })
    return cred.user
  }

  async function resendVerification() {
    if (auth.currentUser) {
      await sendEmailVerification(auth.currentUser)
    }
  }

  async function reloadUser() {
    if (auth.currentUser) {
      await auth.currentUser.reload()
      setUser({ ...auth.currentUser })
    }
  }

  async function createOrganization(name, slug) {
    const uid = auth.currentUser.uid
    const profileSnap = await getDoc(doc(db, 'userProfiles', uid))
    const profile = profileSnap.exists() ? profileSnap.data() : {}

    await setDoc(doc(db, 'organizations', slug), {
      name,
      slug,
      createdAt: serverTimestamp(),
      createdBy: uid,
      settings: {
        sessionTimeoutMinutes: 30,
        requireMFA: true,
      },
    })

    const memberData = {
      name: profile.name || auth.currentUser.email,
      email: auth.currentUser.email,
      role: 'admin',
      joinedAt: serverTimestamp(),
      mfaEnrolled: false,
      welcomeDismissed: false,
    }

    await setDoc(doc(db, 'organizations', slug, 'members', uid), memberData)
    await setDoc(doc(db, 'userProfiles', uid), { ...profile, orgSlug: slug })

    setOrgSlug(slug)
    setUserData(memberData)
  }

  async function joinOrganization(slug, role) {
    const uid = auth.currentUser.uid
    const profileSnap = await getDoc(doc(db, 'userProfiles', uid))
    const profile = profileSnap.exists() ? profileSnap.data() : {}

    const memberData = {
      name: profile.name || auth.currentUser.email,
      email: auth.currentUser.email,
      role: role || 'staff',
      joinedAt: serverTimestamp(),
      mfaEnrolled: false,
      welcomeDismissed: false,
    }

    await setDoc(doc(db, 'organizations', slug, 'members', uid), memberData)
    await setDoc(doc(db, 'userProfiles', uid), { ...profile, orgSlug: slug })

    setOrgSlug(slug)
    setUserData(memberData)
  }

  async function updateMfaStatus(enrolled) {
    if (!orgSlug || !auth.currentUser) return
    const uid = auth.currentUser.uid
    await setDoc(
      doc(db, 'organizations', orgSlug, 'members', uid),
      { mfaEnrolled: enrolled },
      { merge: true }
    )
    setUserData((prev) => (prev ? { ...prev, mfaEnrolled: enrolled } : prev))
  }

  async function dismissWelcome() {
    if (!orgSlug || !auth.currentUser) return
    const uid = auth.currentUser.uid
    await setDoc(
      doc(db, 'organizations', orgSlug, 'members', uid),
      { welcomeDismissed: true },
      { merge: true }
    )
    setUserData((prev) => (prev ? { ...prev, welcomeDismissed: true } : prev))
  }

  async function logout() {
    await signOut(auth)
    setUser(null)
    setUserData(null)
    setOrgSlug(null)
    setMfaResolver(null)
  }

  const value = {
    user,
    userData,
    orgSlug,
    loading,
    mfaResolver,
    login,
    completeMfaLogin,
    register,
    signInWithGoogle,
    signInWithMicrosoft,
    resendVerification,
    reloadUser,
    createOrganization,
    joinOrganization,
    updateMfaStatus,
    dismissWelcome,
    logout,
    loadUserData,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
