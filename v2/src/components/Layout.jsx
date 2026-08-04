import { useState } from 'react'
import { Link, Outlet, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useOrganization } from '../hooks/useOrganization'
import { useOrgSettings } from '../hooks/useOrgSettings'
import { useSessionTimeout } from '../hooks/useSessionTimeout'
import SessionWarningModal from './SessionWarningModal'
import AccountModal from './AccountModal'

export default function Layout() {
  const { slug } = useParams()
  const { userData, logout } = useAuth()
  const { org } = useOrganization()
  const location = useLocation()
  const [showAccount, setShowAccount] = useState(false)

  const { showWarning, remainingSeconds, dismissWarning } = useSessionTimeout(30, logout)
  const { settings: orgSettings } = useOrgSettings(slug)
  const mfaRequired = orgSettings?.requireMfa && userData && !userData.mfaEnrolled

  const navLinks = [
    { to: `/${slug}/dashboard`, label: 'Dashboard' },
    { to: `/${slug}/import`, label: 'Import' },
    { to: `/${slug}/settings`, label: 'Settings' },
  ]
  if (userData?.role === 'admin') {
    navLinks.push({ to: `/${slug}/archive`, label: 'Archive' })
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-8">
              <Link to={`/${slug}/dashboard`} className="flex items-center gap-4">
                {org?.logoUrl ? (
                  <>
                    <img
                      src={org.logoUrl}
                      alt={org.name || 'Pharmacy'}
                      className="h-14 max-w-[280px] object-contain"
                    />
                    {org?.showNameWithLogo && (
                      <span className="text-base font-bold text-slate-900 hidden sm:inline">
                        {org.name}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <span className="text-white font-bold text-sm">
                        {(org?.name || slug || 'RX').substring(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-base font-bold text-slate-900 leading-tight">
                        {org?.name || slug}
                      </span>
                      <span className="text-xs text-slate-400 leading-tight hidden sm:block">
                        Prescription Delivery Tracker
                      </span>
                    </div>
                  </>
                )}
              </Link>
              <nav className="hidden sm:flex items-center gap-1">
                {navLinks.map((link) => (
                  <Link
                    key={link.to}
                    to={link.to}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      location.pathname === link.to
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setShowAccount(true)}
                className="text-sm text-slate-500 hover:text-slate-900 hidden sm:inline cursor-pointer"
              >
                {userData?.name || 'User'}
              </button>
              {userData?.role === 'admin' && (
                <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded hidden sm:inline">
                  Admin
                </span>
              )}
              <button
                onClick={logout}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
          {/* Mobile nav */}
          <nav className="sm:hidden flex items-center gap-1 pb-3 -mt-1 overflow-x-auto">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  location.pathname === link.to
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {link.label}
              </Link>
            ))}
            <button
              onClick={() => setShowAccount(true)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            >
              Account
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>

      {showWarning && (
        <SessionWarningModal
          remainingSeconds={remainingSeconds}
          onDismiss={dismissWarning}
          onSignOut={logout}
        />
      )}

      <AccountModal
        isOpen={showAccount || mfaRequired}
        onClose={() => setShowAccount(false)}
        userName={userData?.name}
        mfaRequired={mfaRequired}
      />
    </div>
  )
}
