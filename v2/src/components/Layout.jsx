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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWide, setSidebarWide] = useState(false)

  const { showWarning, remainingSeconds, dismissWarning } = useSessionTimeout(30, logout)
  const { settings: orgSettings } = useOrgSettings(slug)
  const mfaRequired = orgSettings?.requireMfa && userData && !userData.mfaEnrolled

  const navLinks = [
    {
      to: `/${slug}/dashboard`,
      label: 'Dashboard',
      icon: (
        <Icon>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
        </Icon>
      ),
    },
    {
      to: `/${slug}/patient`,
      label: 'Patient',
      icon: (
        <Icon>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </Icon>
      ),
    },
    {
      to: `/${slug}/import`,
      label: 'Import',
      icon: (
        <Icon>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 21h16" />
        </Icon>
      ),
    },
    {
      to: `/${slug}/settings`,
      label: 'Settings',
      icon: (
        <Icon>
          <line x1="4" y1="6" x2="20" y2="6" />
          <circle cx="9" cy="6" r="2" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <circle cx="15" cy="12" r="2" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="9" cy="18" r="2" />
        </Icon>
      ),
    },
  ]
  if (userData?.role === 'admin') {
    navLinks.push({
      to: `/${slug}/archive`,
      label: 'Archive',
      icon: (
        <Icon>
          <rect x="2" y="3" width="20" height="5" rx="1" />
          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
          <path d="M10 12h4" />
        </Icon>
      ),
    })
  }

  const currentPage = navLinks.find((link) => location.pathname === link.to)

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-4 min-w-0">
              <Link to={`/${slug}/dashboard`} className="flex items-center gap-4 flex-shrink-0">
                {org?.logoUrl ? (
                  <>
                    <img
                      src={org.logoUrl}
                      alt={org.name || 'Pharmacy'}
                      className="h-[60px] max-w-[280px] object-contain"
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
              {currentPage?.label && (
                <span className="hidden sm:inline text-base font-semibold text-slate-900 truncate max-w-[280px]">
                  {currentPage.label}
                </span>
              )}
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
      <div className="flex items-stretch">
        {sidebarCollapsed ? (
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="hidden sm:flex sticky top-16 shrink-0 h-[calc(100vh-4rem)] w-8 flex-col items-center pt-3 bg-white border-r border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <Icon className="w-4 h-4">
              <path d="m9 18 6-6-6-6" />
            </Icon>
          </button>
        ) : (
          <aside
            className={`hidden sm:flex sticky top-16 shrink-0 h-[calc(100vh-4rem)] flex-col bg-white border-r border-slate-200 transition-all duration-200 overflow-hidden ${
              sidebarWide ? 'w-[180px]' : 'w-16'
            }`}
          >
            <div
              className={`flex items-center pt-2 pb-1 ${
                sidebarWide ? 'justify-between px-2' : 'justify-center'
              }`}
            >
              {sidebarWide && (
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1 truncate">
                  Menu
                </span>
              )}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setSidebarWide(!sidebarWide)}
                  title={sidebarWide ? 'Show icons only' : 'Show labels'}
                  aria-label={sidebarWide ? 'Show icons only' : 'Show labels'}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <Icon className="w-4 h-4">
                    {sidebarWide ? <path d="m11 17-5-5 5-5" /> : <path d="m6 17 5-5-5-5" />}
                    {sidebarWide ? <path d="m18 17-5-5 5-5" /> : <path d="m13 17 5-5-5-5" />}
                  </Icon>
                </button>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                  className="p-1 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <Icon className="w-4 h-4">
                    <path d="M19 12H5" />
                    <path d="m12 19-7-7 7-7" />
                  </Icon>
                </button>
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 pb-4 flex flex-col gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  title={link.label}
                  className={`flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                    sidebarWide ? '' : 'justify-center px-0'
                  } ${
                    location.pathname === link.to
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex-shrink-0">{link.icon}</span>
                  {sidebarWide && <span className="truncate">{link.label}</span>}
                </Link>
              ))}
            </nav>
          </aside>
        )}
        <main className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6">
          <Outlet />
        </main>
      </div>

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

function Icon({ children, className = 'w-5 h-5' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
