import { describe, it, expect, vi } from 'vitest'
import { getCentralTimeDateString, formatCentralTime } from '../hooks/useShipments'

// Mock firebase and auth for the hook module to load
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(() => vi.fn()),
  addDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn(),
  serverTimestamp: vi.fn(() => new Date()),
  arrayUnion: vi.fn((...args) => args),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ orgSlug: 'test-org', user: { uid: 'test-user' } }),
}))

describe('getCentralTimeDateString', () => {
  it('returns a date string in YYYY-MM-DD format', () => {
    const result = getCentralTimeDateString(new Date('2025-06-15T12:00:00Z'))
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns today when no argument is provided', () => {
    const result = getCentralTimeDateString()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('correctly formats a known date in Central Time', () => {
    // Jan 1 2025 at 2am UTC = Dec 31 2024 at 8pm Central Time
    const result = getCentralTimeDateString(new Date('2025-01-01T02:00:00Z'))
    expect(result).toBe('2024-12-31')
  })
})

describe('formatCentralTime', () => {
  it('returns dash for null/undefined', () => {
    expect(formatCentralTime(null)).toBe('—')
    expect(formatCentralTime(undefined)).toBe('—')
  })

  it('formats a Date object', () => {
    const result = formatCentralTime(new Date('2025-06-15T18:30:00Z'))
    expect(result).toContain('Jun')
    expect(result).toContain('15')
    expect(result).toContain('2025')
  })

  it('handles Firestore Timestamp-like objects', () => {
    const fakeTimestamp = { toDate: () => new Date('2025-03-01T12:00:00Z') }
    const result = formatCentralTime(fakeTimestamp)
    expect(result).toContain('Mar')
    expect(result).toContain('1')
    expect(result).toContain('2025')
  })
})
