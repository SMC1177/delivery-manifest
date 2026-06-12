import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Mock the useAuth hook before importing the component
vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}))

import AdminProtectedRoute from '../components/AdminProtectedRoute'
import { useAuth } from '../contexts/AuthContext'

describe('AdminProtectedRoute', () => {
  const mockUseAuth = vi.mocked(useAuth)

  afterEach(() => {
    vi.clearAllMocks()
  })

  function renderWithRouter(ui) {
    return render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={ui} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('renders children when profile.platformAdmin is true and not loading', () => {
    mockUseAuth.mockReturnValue({
      profile: { platformAdmin: true },
      loading: false,
    })

    renderWithRouter(
      <AdminProtectedRoute>
        <div>Protected Content</div>
      </AdminProtectedRoute>
    )

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
    expect(screen.queryByText('HOME')).not.toBeInTheDocument()
  })

  it('redirects to / when profile is null', () => {
    mockUseAuth.mockReturnValue({
      profile: null,
      loading: false,
    })

    renderWithRouter(
      <AdminProtectedRoute>
        <div>Protected Content</div>
      </AdminProtectedRoute>
    )

    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    expect(screen.getByText('HOME')).toBeInTheDocument()
  })

  it('redirects to / when profile.platformAdmin is a truthy non-boolean (e.g., "yes")', () => {
    mockUseAuth.mockReturnValue({
      profile: { platformAdmin: 'yes' },
      loading: false,
    })

    renderWithRouter(
      <AdminProtectedRoute>
        <div>Protected Content</div>
      </AdminProtectedRoute>
    )

    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    expect(screen.getByText('HOME')).toBeInTheDocument()
  })

  it('renders nothing when loading is true (no flash, no redirect)', () => {
    mockUseAuth.mockReturnValue({
      profile: null,
      loading: true,
    })

    renderWithRouter(
      <AdminProtectedRoute>
        <div>Protected Content</div>
      </AdminProtectedRoute>
    )

    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    expect(screen.queryByText('HOME')).not.toBeInTheDocument()
  })
})
