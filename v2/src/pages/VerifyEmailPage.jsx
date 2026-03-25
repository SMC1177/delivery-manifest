import { useState, useEffect } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function VerifyEmailPage() {
  const { user, orgSlug, loading, resendVerification, reloadUser, logout } = useAuth()
  const [resending, setResending] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  // Poll for email verification
  useEffect(() => {
    if (!user || user.emailVerified) return
    const interval = setInterval(() => {
      reloadUser()
    }, 3000)
    return () => clearInterval(interval)
  }, [user, reloadUser])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (user.emailVerified && orgSlug) return <Navigate to={`/${orgSlug}/dashboard`} replace />
  if (user.emailVerified && !orgSlug) return <Navigate to="/setup" replace />

  async function handleResend() {
    setResending(true)
    setMessage('')
    try {
      await resendVerification()
      setCooldown(60)
      setMessage('Verification email sent! Check your inbox.')
    } catch (err) {
      setMessage(err.message || 'Failed to send email.')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8 text-center">
        <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mb-2">Check Your Email</h1>
        <p className="text-slate-600 mb-2">
          We sent a verification link to:
        </p>
        <p className="font-medium text-slate-900 mb-6">{user.email}</p>
        <p className="text-sm text-slate-500 mb-6">
          Click the link in the email to verify your account. Once verified, this page will update automatically.
        </p>

        {message && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg text-sm">
            {message}
          </div>
        )}

        <button
          onClick={handleResend}
          disabled={resending || cooldown > 0}
          className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-4"
        >
          {cooldown > 0
            ? `Resend in ${cooldown}s`
            : resending
              ? 'Sending...'
              : 'Resend Verification Email'}
        </button>

        <div className="flex items-center justify-between text-sm">
          <button
            onClick={logout}
            className="text-slate-500 hover:text-slate-700"
          >
            Sign out
          </button>
          <Link to="/login" className="text-blue-600 hover:text-blue-700 font-medium">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  )
}
