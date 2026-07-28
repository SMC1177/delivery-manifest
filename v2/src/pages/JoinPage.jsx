import { useState, useEffect } from 'react'
import { useParams, useSearchParams, Link, useNavigate, Navigate } from 'react-router-dom'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { useAuth } from '../contexts/AuthContext'
import { redeemInvite } from '../hooks/useInvites'
import { validatePassword, getPasswordStrength } from '../lib/password'

export default function JoinPage() {
  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  const inviteCode = searchParams.get('code')
  const navigate = useNavigate()
  const { user, orgSlug, loading: authLoading, register, joinOrganization } = useAuth()

  const [invite, setInvite] = useState(null)
  const [orgName, setOrgName] = useState('')
  const [loadingInvite, setLoadingInvite] = useState(true)
  const [inviteError, setInviteError] = useState('')

  // Registration form
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    async function loadInvite() {
      if (!inviteCode || !slug) {
        setInviteError('Invalid invite link. No invite code provided.')
        setLoadingInvite(false)
        return
      }

      try {
        const validateInviteCallable = httpsCallable(getFunctions(), 'validateInvite')
        const result = await validateInviteCallable({ slug, code: inviteCode })
        const { valid, orgName: name, role, inviteId, reason } = result.data

        if (!valid) {
          if (reason === 'invalid') {
            setInviteError('Invalid or expired invite code.')
          } else if (reason === 'expired') {
            setInviteError('This invite has expired.')
          } else if (reason === 'exhausted') {
            setInviteError('This invite has reached its usage limit.')
          } else {
            setInviteError('Failed to validate invite.')
          }
          setLoadingInvite(false)
          return
        }

        setOrgName(name)
        setInvite({ id: inviteId, role })
      } catch (err) {
        console.error('validateInvite call failed:', err)
        setInviteError('Failed to validate invite.')
      } finally {
        setLoadingInvite(false)
      }
    }

    loadInvite()
  }, [slug, inviteCode])

  // If user is already in this org
  if (!authLoading && user && orgSlug === slug) {
    return <Navigate to={`/${slug}/dashboard`} replace />
  }

  async function handleJoinExisting() {
    if (!user || !invite) return
    setSubmitting(true)
    setFormError('')
    try {
      await redeemInvite(slug, invite.id, user.uid)
      await joinOrganization(slug, invite.role)
      navigate(`/${slug}/dashboard`)
    } catch (err) {
      setFormError(err.message || 'Failed to join organization')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRegisterAndJoin(e) {
    e.preventDefault()
    setFormError('')

    const pwErrors = validatePassword(password)
    if (pwErrors.length > 0) {
      setFormError(pwErrors.join('. '))
      return
    }

    setSubmitting(true)
    try {
      await register(email, password, name)
      // After registration, user needs to verify email first
      // Then come back and join
      await redeemInvite(slug, invite.id, null) // mark invite as used
      navigate('/verify-email')
    } catch (err) {
      setFormError(
        err.code === 'auth/email-already-in-use'
          ? 'An account with this email already exists. Please sign in instead.'
          : err.message
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading || loadingInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (inviteError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Invalid Invite</h1>
          <p className="text-slate-600 mb-6">{inviteError}</p>
          <Link
            to="/login"
            className="text-blue-600 hover:text-blue-700 font-medium text-sm"
          >
            Go to login
          </Link>
        </div>
      </div>
    )
  }

  // User is logged in but not in this org — show join button
  if (user && user.emailVerified && !orgSlug) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Join {orgName}</h1>
          <p className="text-slate-600 mb-6">
            You've been invited to join as <span className="font-medium">{invite.role}</span>.
          </p>

          {formError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {formError}
            </div>
          )}

          <button
            onClick={handleJoinExisting}
            disabled={submitting}
            className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Joining...' : 'Join Organization'}
          </button>
        </div>
      </div>
    )
  }

  // User not logged in — show registration form
  const strength = getPasswordStrength(password)

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Join {orgName}</h1>
          <p className="text-slate-500 mt-1">
            Create an account to join as <span className="font-medium">{invite.role}</span>.
          </p>
        </div>

        {formError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            {formError}
          </div>
        )}

        <form onSubmit={handleRegisterAndJoin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Your Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="John Smith"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="you@pharmacy.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Min. 8 characters"
            />
            {password && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${strength.color}`}
                      style={{ width: `${(strength.score / 5) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-slate-600">{strength.label}</span>
                </div>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Creating account...' : 'Create Account & Join'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="text-blue-600 hover:text-blue-700 font-medium">
            Sign In
          </Link>
        </p>
      </div>
    </div>
  )
}
