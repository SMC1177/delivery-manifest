import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { checkRateLimit, recordFailedAttempt, clearLoginAttempts } from '../lib/rateLimit'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [mfaError, setMfaError] = useState('')

  const { login, completeMfaLogin, signInWithGoogle, signInWithMicrosoft } = useAuth()
  const navigate = useNavigate()

  function getErrorMessage(err) {
    switch (err.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Invalid email or password.'
      case 'auth/too-many-requests':
        return 'Too many attempts. Please try again later.'
      case 'auth/user-disabled':
        return 'This account has been disabled.'
      default:
        return err.message || 'Login failed.'
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      // Check rate limit
      const rl = await checkRateLimit(email)
      if (rl.locked) {
        setError(`Account locked. Try again in ${rl.minutesLeft} minute${rl.minutesLeft === 1 ? '' : 's'}.`)
        setLoading(false)
        return
      }

      const result = await login(email, password)

      if (result.mfaRequired) {
        setMfaRequired(true)
        setLoading(false)
        return
      }

      await clearLoginAttempts(email)
      // AuthContext loadUserData sets orgSlug; navigate after a tick
      setTimeout(() => navigate('/'), 50)
    } catch (err) {
      await recordFailedAttempt(email).catch(() => {})
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault()
    setMfaError('')
    setLoading(true)

    try {
      await completeMfaLogin(otpCode)
      await clearLoginAttempts(email).catch(() => {})
      navigate('/')
    } catch {
      setMfaError('Invalid verification code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // MFA prompt
  if (mfaRequired) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Two-Factor Authentication</h1>
            <p className="text-slate-500 mt-1">Enter the code from your authenticator app</p>
          </div>

          {mfaError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {mfaError}
            </div>
          )}

          <form onSubmit={handleMfaSubmit} className="space-y-4">
            <div>
              <label htmlFor="otpCode" className="block text-sm font-medium text-slate-700 mb-1">
                Verification Code
              </label>
              <input
                id="otpCode"
                type="text"
                inputMode="numeric"
                maxLength={6}
                required
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center font-mono text-lg tracking-widest"
                placeholder="000000"
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.length !== 6}
              className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>

          <button
            onClick={() => { setMfaRequired(false); setOtpCode(''); setMfaError('') }}
            className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-700"
          >
            Back to login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Prescription Delivery Tracker</h1>
          <p className="text-slate-500 mt-1">Sign in to your account</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="you@pharmacy.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="********"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-white px-2 text-slate-500">Or continue with</span>
            </div>
          </div>

          <button
            type="button"
            onClick={async () => {
              setError('')
              setLoading(true)
              try {
                await signInWithGoogle()
                setTimeout(() => navigate('/'), 50)
              } catch (err) {
                setError(err.message)
              } finally {
                setLoading(false)
              }
            }}
            className="mt-4 w-full flex items-center justify-center gap-3 py-2.5 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors font-medium text-slate-700"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>

          <button
            type="button"
            onClick={async () => {
              setError('')
              setLoading(true)
              try {
                await signInWithMicrosoft()
                setTimeout(() => navigate('/'), 50)
              } catch (err) {
                if (err.code !== 'auth/popup-closed-by-user') {
                  setError(err.message)
                }
              } finally {
                setLoading(false)
              }
            }}
            className="mt-3 w-full flex items-center justify-center gap-3 py-2.5 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors font-medium text-slate-700"
          >
            <svg className="h-5 w-5" viewBox="0 0 23 23">
              <path fill="#f25022" d="M1 1h10v10H1z"/>
              <path fill="#00a4ef" d="M1 12h10v10H1z"/>
              <path fill="#7fba00" d="M12 1h10v10H12z"/>
              <path fill="#ffb900" d="M12 12h10v10H12z"/>
            </svg>
            Sign in with Microsoft
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don't have an account?{' '}
          <Link to="/register" className="text-blue-600 hover:text-blue-700 font-medium">
            Register
          </Link>
        </p>
      </div>
    </div>
  )
}
