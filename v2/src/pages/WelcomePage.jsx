import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import TotpSetup from '../components/TotpSetup'

export default function WelcomePage() {
  const { slug } = useParams()
  const { user, userData, loading, dismissWelcome } = useAuth()
  const navigate = useNavigate()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  // If welcome already dismissed, go to dashboard
  if (userData?.welcomeDismissed) {
    return <Navigate to={`/${slug}/dashboard`} replace />
  }

  function handleComplete() {
    dismissWelcome()
    navigate(`/${slug}/dashboard`)
  }

  function handleSkip() {
    dismissWelcome()
    navigate(`/${slug}/dashboard`)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Welcome to Prescription Delivery Tracker
          </h1>
          <p className="text-slate-500">
            Your account is ready. We strongly recommend setting up two-factor authentication to secure your account.
          </p>
        </div>

        <TotpSetup onComplete={handleComplete} onSkip={handleSkip} />
      </div>
    </div>
  )
}
