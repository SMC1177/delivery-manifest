import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useOrgSettings } from '../hooks/useOrgSettings'

export default function ProtectedRoute({ children, requireOrg = true }) {
  const { user, userData, orgSlug, loading } = useAuth()
  const { settings: orgSettings } = useOrgSettings(orgSlug)
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  if (!user.emailVerified) return <Navigate to="/verify-email" replace />

  if (requireOrg && !orgSlug) return <Navigate to="/setup" replace />

  // Redirect to welcome/2FA setup on first login (unless already on welcome page)
  if (
    requireOrg &&
    orgSlug &&
    userData &&
    !userData.welcomeDismissed &&
    !location.pathname.includes('/welcome')
  ) {
    return <Navigate to={`/${orgSlug}/welcome`} replace />
  }

  // Enforce MFA if org requires it — redirect to settings to set up 2FA
  // (allow settings page so users can actually enroll)
  if (
    requireOrg &&
    orgSlug &&
    orgSettings?.requireMfa &&
    userData &&
    !userData.mfaEnrolled &&
    !location.pathname.includes('/settings')
  ) {
    return <Navigate to={`/${orgSlug}/settings`} replace />
  }

  return children
}
