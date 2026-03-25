import { useState } from 'react'
import { multiFactor, TotpMultiFactorGenerator, reauthenticateWithPopup, GoogleAuthProvider, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth'
import QRCode from 'qrcode'
import { auth } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'

export default function TotpSetup({ onComplete, onSkip }) {
  const { updateMfaStatus } = useAuth()
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [totpSecret, setTotpSecret] = useState(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [error, setError] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [loading, setLoading] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [needsReauth, setNeedsReauth] = useState(false)
  const [reauthPassword, setReauthPassword] = useState('')

  async function doReauthAndSetup() {
    setLoading(true)
    setError('')
    try {
      const user = auth.currentUser
      // Try Google re-auth if they signed in with Google
      const isGoogle = user.providerData.some((p) => p.providerId === 'google.com')
      if (isGoogle) {
        await reauthenticateWithPopup(user, new GoogleAuthProvider())
      } else if (reauthPassword) {
        const credential = EmailAuthProvider.credential(user.email, reauthPassword)
        await reauthenticateWithCredential(user, credential)
      } else {
        setNeedsReauth(true)
        setLoading(false)
        return
      }
      // Now try setup again
      await doMfaSetup()
    } catch (err) {
      setError(err.message || 'Re-authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  async function doMfaSetup() {
    const mfUser = multiFactor(auth.currentUser)

    if (mfUser.enrolledFactors.length > 0) {
      setError('2FA is already enabled on this account.')
      return
    }

    const session = await mfUser.getSession()
    const secret = await TotpMultiFactorGenerator.generateSecret(session)
    setTotpSecret(secret)
    const uri = secret.generateQrCodeUrl(auth.currentUser.email, 'Prescription Delivery Tracker')
    const dataUrl = await QRCode.toDataURL(uri)
    setQrDataUrl(dataUrl)
    setInitialized(true)
    setNeedsReauth(false)
  }

  async function initSetup() {
    setLoading(true)
    setError('')
    try {
      await doMfaSetup()
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        // Need to re-authenticate first
        const isGoogle = auth.currentUser.providerData.some((p) => p.providerId === 'google.com')
        if (isGoogle) {
          // Auto re-auth with Google popup
          await doReauthAndSetup()
          return
        } else {
          setNeedsReauth(true)
        }
      } else if (err.code === 'auth/unsupported-first-factor') {
        setError('Please sign out and sign back in before setting up 2FA.')
      } else {
        setError(err.message || 'Failed to initialize 2FA setup.')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleEnroll() {
    if (!verifyCode || verifyCode.length !== 6) {
      setError('Enter a 6-digit code')
      return
    }
    setEnrolling(true)
    setError('')
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, verifyCode)
      await multiFactor(auth.currentUser).enroll(assertion, 'Authenticator App')
      await updateMfaStatus(true)
      onComplete?.()
    } catch (err) {
      setError(err.message || 'Invalid code. Try again.')
    } finally {
      setEnrolling(false)
    }
  }

  // Re-auth needed (email/password users)
  if (needsReauth && !initialized) {
    return (
      <div>
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}
        <div className="text-center py-4">
          <div className="text-4xl mb-3">🔑</div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">
            Confirm Your Identity
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            For security, please enter your password to continue setting up 2FA.
          </p>
          <div className="max-w-xs mx-auto mb-4">
            <input
              type="password"
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={doReauthAndSetup}
            disabled={!reauthPassword || loading}
            className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Verifying...' : 'Continue'}
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              className="block mx-auto mt-3 text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    )
  }

  // Initial state — show setup button
  if (!initialized && !loading) {
    return (
      <div>
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}
        <div className="text-center py-4">
          <div className="text-4xl mb-3">🔐</div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">
            Two-Factor Authentication
          </h3>
          <p className="text-sm text-slate-500 mb-4 max-w-sm mx-auto">
            Add an extra layer of security to your account using an authenticator app like Google Authenticator or Authy.
          </p>
          <button
            onClick={initSetup}
            className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Set Up 2FA
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              className="block mx-auto mt-3 text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  // QR code + verify state
  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="text-center">
        <p className="text-sm text-slate-600 mb-4">
          Scan this QR code with your authenticator app, then enter the 6-digit code below.
        </p>

        {qrDataUrl && (
          <div className="flex justify-center mb-6">
            <img src={qrDataUrl} alt="2FA QR Code" className="w-48 h-48 rounded-lg shadow-sm" />
          </div>
        )}

        <div className="max-w-xs mx-auto mb-4">
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-center font-mono text-lg tracking-widest"
            placeholder="000000"
          />
        </div>

        <button
          onClick={handleEnroll}
          disabled={enrolling}
          className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {enrolling ? 'Verifying...' : 'Verify & Enable 2FA'}
        </button>

        {onSkip && (
          <button
            onClick={onSkip}
            className="block mx-auto mt-3 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  )
}
