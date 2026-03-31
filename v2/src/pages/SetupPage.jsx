import { useState } from 'react'
import { Navigate, useNavigate, Link } from 'react-router-dom'
import { multiFactor, TotpMultiFactorGenerator } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import QRCode from 'qrcode'
import { auth, db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { findInviteByCode, redeemInvite } from '../hooks/useInvites'

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30)
}

export default function SetupPage() {
  const { user, orgSlug, loading, createOrganization, joinOrganization, updateMfaStatus } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState(1)
  const [orgName, setOrgName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugAvailable, setSlugAvailable] = useState(null)
  const [checkingSlug, setCheckingSlug] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showJoinFlow, setShowJoinFlow] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [inviteSlug, setInviteSlug] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joining, setJoining] = useState(false)

  // 2FA state
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [totpSecret, setTotpSecret] = useState(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [mfaLoading, setMfaLoading] = useState(false)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!user || !user.emailVerified) return <Navigate to="/login" replace />
  if (orgSlug) return <Navigate to={`/${orgSlug}/welcome`} replace />

  function handleOrgNameChange(e) {
    const name = e.target.value
    setOrgName(name)
    if (!slugEdited) {
      setSlug(slugify(name))
      setSlugAvailable(null)
    }
  }

  async function checkSlugAvailability() {
    if (!slug || slug.length < 3) {
      setSlugAvailable(false)
      return
    }
    setCheckingSlug(true)
    try {
      const orgSnap = await getDoc(doc(db, 'organizations', slug))
      setSlugAvailable(!orgSnap.exists())
    } catch {
      setSlugAvailable(false)
    } finally {
      setCheckingSlug(false)
    }
  }

  async function handleStep1() {
    if (!orgName.trim()) {
      setError('Organization name is required')
      return
    }
    setError('')
    setStep(2)
  }

  async function handleStep2() {
    if (!slug || slug.length < 3) {
      setError('Slug must be at least 3 characters')
      return
    }
    if (slugAvailable === false) {
      setError('This slug is not available')
      return
    }
    if (slugAvailable === null) {
      await checkSlugAvailability()
      return
    }
    setError('')

    // Create the organization
    setSaving(true)
    try {
      await createOrganization(orgName.trim(), slug)
      setStep(3)
      // Initialize 2FA setup
      await initMfa()
    } catch (err) {
      setError(err.message || 'Failed to create organization')
    } finally {
      setSaving(false)
    }
  }

  async function initMfa() {
    setMfaLoading(true)
    setMfaError('')
    try {
      const mfUser = multiFactor(auth.currentUser)
      const session = await mfUser.getSession()
      const secret = await TotpMultiFactorGenerator.generateSecret(session)
      setTotpSecret(secret)
      const uri = secret.generateQrCodeUrl(auth.currentUser.email, 'Prescription Delivery Tracker')
      const dataUrl = await QRCode.toDataURL(uri)
      setQrDataUrl(dataUrl)
    } catch (err) {
      setMfaError(
        err.code === 'auth/unsupported-first-factor'
          ? 'Please re-authenticate to set up 2FA.'
          : err.message || 'Failed to initialize 2FA. You can set this up later in Settings.'
      )
    } finally {
      setMfaLoading(false)
    }
  }

  async function handleEnrollMfa() {
    if (!verifyCode || verifyCode.length !== 6) {
      setMfaError('Enter a 6-digit code')
      return
    }
    setEnrolling(true)
    setMfaError('')
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, verifyCode)
      await multiFactor(auth.currentUser).enroll(assertion, 'Authenticator App')
      await updateMfaStatus(true)
      navigate(`/${slug}/welcome`)
    } catch (err) {
      setMfaError(err.message || 'Invalid code. Try again.')
    } finally {
      setEnrolling(false)
    }
  }

  function handleSkipMfa() {
    navigate(`/${slug}/welcome`)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-lg p-8">
        {/* Progress bar */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`flex-1 h-2 rounded-full transition-colors ${
                s <= step ? 'bg-blue-600' : 'bg-slate-200'
              }`}
            />
          ))}
        </div>

        {/* Step 1: Organization Name */}
        {step === 1 && (
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Set Up Your Organization</h1>
            <p className="text-slate-500 mb-6">What's the name of your pharmacy or organization?</p>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div className="mb-6">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Organization Name
              </label>
              <input
                type="text"
                value={orgName}
                onChange={handleOrgNameChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Woodlands RX"
                autoFocus
              />
            </div>

            <button
              onClick={handleStep1}
              className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Continue
            </button>

            {/* Join Existing Organization */}
            <div className="mt-6 pt-6 border-t border-slate-200">
              {!showJoinFlow ? (
                <button
                  onClick={() => setShowJoinFlow(true)}
                  className="w-full text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Have an invite code? Join an existing organization &rarr;
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-slate-700">Join Existing Organization</p>
                  <p className="text-xs text-slate-500">Enter the organization ID and invite code from your admin.</p>
                  {joinError && (
                    <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                      {joinError}
                    </div>
                  )}
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={inviteSlug}
                      onChange={(e) => { setInviteSlug(e.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')); setJoinError(''); }}
                      placeholder="Organization ID (e.g. woodlandsrx)"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={inviteCode}
                        onChange={(e) => { setInviteCode(e.target.value.trim()); setJoinError(''); }}
                        placeholder="Invite code"
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      <button
                        onClick={async () => {
                          if (!inviteSlug) { setJoinError('Enter the organization ID'); return }
                          if (!inviteCode) { setJoinError('Enter the invite code'); return }
                          setJoining(true)
                          setJoinError('')
                          try {
                            const invite = await findInviteByCode(inviteSlug, inviteCode)
                            if (!invite) { setJoinError('Invalid invite code for this organization'); setJoining(false); return }
                            await redeemInvite(inviteSlug, invite.id, user.uid)
                            await joinOrganization(inviteSlug, invite.role || 'staff')
                            navigate(`/${inviteSlug}/welcome`)
                          } catch (err) {
                            setJoinError(err.message || 'Failed to join organization')
                          }
                          setJoining(false)
                        }}
                        disabled={joining}
                        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        {joining ? 'Joining...' : 'Join'}
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => { setShowJoinFlow(false); setInviteCode(''); setInviteSlug(''); setJoinError(''); }}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Organization Slug */}
        {step === 2 && (
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Choose Your URL</h1>
            <p className="text-slate-500 mb-6">
              This will be your organization's unique URL path.
            </p>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                URL Slug
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500">app.com/</span>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))
                    setSlugEdited(true)
                    setSlugAvailable(null)
                  }}
                  onBlur={checkSlugAvailability}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                  placeholder="woodlandsrx"
                />
              </div>
              {checkingSlug && (
                <p className="text-sm text-slate-500 mt-1">Checking availability...</p>
              )}
              {slugAvailable === true && (
                <p className="text-sm text-green-600 mt-1">Available!</p>
              )}
              {slugAvailable === false && (
                <p className="text-sm text-red-600 mt-1">Not available. Try another.</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setStep(1); setError('') }}
                className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleStep2}
                disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Creating...' : 'Create Organization'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: 2FA Setup */}
        {step === 3 && (
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Set Up Two-Factor Authentication</h1>
            <p className="text-slate-500 mb-6">
              Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.).
            </p>

            {mfaError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                {mfaError}
              </div>
            )}

            {mfaLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : qrDataUrl ? (
              <>
                <div className="flex justify-center mb-6">
                  <img src={qrDataUrl} alt="2FA QR Code" className="w-48 h-48 rounded-lg" />
                </div>

                <div className="mb-6">
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Enter 6-digit verification code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center font-mono text-lg tracking-widest"
                    placeholder="000000"
                  />
                </div>

                <button
                  onClick={handleEnrollMfa}
                  disabled={enrolling}
                  className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors mb-3"
                >
                  {enrolling ? 'Verifying...' : 'Verify & Enable 2FA'}
                </button>
              </>
            ) : null}

            <button
              onClick={handleSkipMfa}
              className="w-full py-2.5 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
