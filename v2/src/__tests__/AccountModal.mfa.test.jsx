import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AccountModal from '../components/AccountModal'

// ── Mock dependencies ──

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
}))

vi.mock('../components/Toast', () => ({
  useToast: () => vi.fn(),
}))

vi.mock('../components/TotpSetup', () => ({
  default: ({ onComplete, onSkip }) => (
    <div data-testid="totp-setup">
      <button data-testid="totp-complete" onClick={onComplete}>
        Complete Setup
      </button>
      {onSkip && (
        <button data-testid="totp-skip" onClick={onSkip}>
          Skip
        </button>
      )}
    </div>
  ),
}))

vi.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: vi.fn() },
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
  signOut: vi.fn(),
}))

import { useAuth } from '../contexts/AuthContext'
import { auth } from '../lib/firebase'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Test helpers ──

/**
 * Configure auth.currentUser to satisfy isEmailUser so the password-change
 * section renders. Without a password provider entry the password UI is hidden,
 * and tests that assert its presence would falsely fail.
 */
function setAuthUser(overrides = {}) {
  auth.currentUser = {
    email: 'user@example.com',
    providerData: [{ providerId: 'password' }],
    ...overrides,
  }
}

function setUserData(overrides = {}) {
  useAuth.mockReturnValue({
    userData: {
      role: 'staff',
      mfaEnrolled: false,
      ...overrides,
    },
  })
}

// ── Regression: the role-gating lockout ──
//
// Before the fix, ProtectedRoute redirected unenrolled non-admin users to
// /{orgSlug}/settings, but SettingsPage returned early with "Admin access
// required" for staff/viewer — permanently locking them out with no way to
// enroll.  The fix moved enrollment into AccountModal, which has NO role gate.
// These tests fail if anyone reintroduces a role-dependency on the MFA section.

describe('AccountModal MFA lockout regression guard', () => {
  it('renders both password-change and 2FA sections for staff role (the lockout victim)', () => {
    setAuthUser()
    setUserData({ role: 'staff', mfaEnrolled: false })
    render(
      <AccountModal isOpen={true} onClose={vi.fn()} userName="Alice" />
    )

    expect(screen.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Change Password' })).toBeInTheDocument()
  })

  it('renders both password-change and 2FA sections for viewer role (the lockout victim)', () => {
    setAuthUser()
    setUserData({ role: 'viewer', mfaEnrolled: false })
    render(
      <AccountModal isOpen={true} onClose={vi.fn()} userName="Bob" />
    )

    expect(screen.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Change Password' })).toBeInTheDocument()
  })

  // ── Dismissal trapping ──

  it('hides close button and ignores backdrop clicks when mfaRequired is true and user is unenrolled', () => {
    setAuthUser()
    setUserData({ role: 'staff', mfaEnrolled: false })
    const onClose = vi.fn()
    render(
      <AccountModal
        isOpen={true}
        onClose={onClose}
        userName="Alice"
        mfaRequired={true}
      />
    )

    // The amber warning confirms the trapped state is active
    expect(
      screen.getByText(/organization requires two-factor authentication/i)
    ).toBeInTheDocument()

    // Close button must not exist (the entire button subtree is !trapClose)
    expect(
      document.querySelector('button.text-slate-400')
    ).not.toBeInTheDocument()

    // Clicking the backdrop must NOT fire onClose
    const backdrop = document.querySelector('.fixed.inset-0')
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders close button and calls onClose when mfaRequired is false', () => {
    setAuthUser()
    setUserData({ role: 'staff', mfaEnrolled: false })
    const onClose = vi.fn()
    render(
      <AccountModal
        isOpen={true}
        onClose={onClose}
        userName="Alice"
        mfaRequired={false}
      />
    )

    const closeButton = document.querySelector('button.text-slate-400')
    expect(closeButton).toBeInTheDocument()
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── Enrolled user immunity ──

  it('shows enrolled state and remains dismissible when enrolled even with mfaRequired true', () => {
    setAuthUser()
    setUserData({ role: 'viewer', mfaEnrolled: true })
    const onClose = vi.fn()
    render(
      <AccountModal
        isOpen={true}
        onClose={onClose}
        userName="Carol"
        mfaRequired={true}
      />
    )

    // Enrolled message is visible — the green checkmark section is rendered
    expect(
      screen.getByText(/two-factor authentication is enabled on your account/i)
    ).toBeInTheDocument()

    // TotpSetup enrollment component must NOT be shown
    expect(screen.queryByTestId('totp-setup')).not.toBeInTheDocument()

    // Close button is rendered (trapClose = true && !true = false)
    const closeButton = document.querySelector('button.text-slate-400')
    expect(closeButton).toBeInTheDocument()
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── Enrollment component ──

  it('renders TotpSetup enrollment component when user is not enrolled in MFA', () => {
    setAuthUser()
    setUserData({ role: 'staff', mfaEnrolled: false })
    render(
      <AccountModal isOpen={true} onClose={vi.fn()} userName="Dave" />
    )

    expect(screen.getByTestId('totp-setup')).toBeInTheDocument()
    expect(
      screen.queryByText(/two-factor authentication is enabled on your account/i)
    ).not.toBeInTheDocument()
  })
})
