import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// Use a mutable object so the factory closure always reads the current handler.
const snap = { handler: null, calls: 0 }

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((...args) => ({ _path: args.slice(1).join('/') })),
  onSnapshot: (ref, cb) => {
    snap.calls++
    if (snap.handler) snap.handler(ref, cb)
    return () => {}
  },
}))
vi.mock('../lib/firebase', () => ({ db: { _stub: true } }))

const { useSmsContact } = await import('../hooks/useSmsContact')

beforeEach(() => { snap.handler = null; snap.calls = 0 })

describe('useSmsContact', () => {
  it('returns null state when contact does not exist', async () => {
    snap.handler = (_ref, cb) => cb({ exists: () => false, data: () => null })
    const { result } = renderHook(() => useSmsContact('acme', '+12815550200'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.contact).toBe(null)
  })

  it('returns contact data when doc exists', async () => {
    snap.handler = (_ref, cb) => cb({ exists: () => true, data: () => ({ optIn: true, totalSent: 5 }) })
    const { result } = renderHook(() => useSmsContact('acme', '+12815550200'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.contact.optIn).toBe(true)
  })

  it('skips subscription when phone is empty', async () => {
    renderHook(() => useSmsContact('acme', ''))
    await act(async () => {})
    expect(snap.calls).toBe(0)
  })
})
