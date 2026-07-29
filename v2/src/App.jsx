import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ToastProvider } from './components/Toast'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import VerifyEmailPage from './pages/VerifyEmailPage'
import SetupPage from './pages/SetupPage'
import WelcomePage from './pages/WelcomePage'
import JoinPage from './pages/JoinPage'
import DashboardPage from './pages/DashboardPage'
import ImportPage from './pages/ImportPage'
import SettingsPage from './pages/SettingsPage'
import AdminProtectedRoute from './components/AdminProtectedRoute'
import AdminDashboardPage from './pages/AdminDashboardPage'
import ArchivePage from './pages/ArchivePage'

function OrgRedirect() {
  const { orgSlug, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    )
  }
  if (orgSlug) return <Navigate to={`/${orgSlug}/dashboard`} replace />
  return <Navigate to="/setup" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route
              path="/setup"
              element={
                <ProtectedRoute requireOrg={false}>
                  <SetupPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/app"
              element={
                <ProtectedRoute>
                  <OrgRedirect />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/dashboard"
              element={
                <AdminProtectedRoute>
                  <AdminDashboardPage />
                </AdminProtectedRoute>
              }
            />
            <Route path="/:slug/join" element={<JoinPage />} />
            <Route
              path="/:slug/welcome"
              element={
                <ProtectedRoute>
                  <WelcomePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/:slug"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="import" element={<ImportPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="archive" element={<ArchivePage />} />
              <Route index element={<Navigate to="dashboard" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
