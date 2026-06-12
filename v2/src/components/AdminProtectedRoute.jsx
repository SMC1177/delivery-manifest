// v2/src/components/AdminProtectedRoute.jsx
// UX gate for /admin/dashboard. Real enforcement is server-side
// (requirePlatformAdmin in the callables) — this only controls rendering.
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function AdminProtectedRoute({ children }) {
  const { profile, loading } = useAuth()

  if (loading) {
    return null
  }

  if (profile?.platformAdmin === true) {
    return children
  }

  return <Navigate to="/" replace />
}
