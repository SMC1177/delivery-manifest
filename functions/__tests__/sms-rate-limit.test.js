import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkAndIncrementRateLimit, todayKey } from '../sms-rate-limit.js'

function makeMockFirestore({ initialCount = 0 } = {}) {
  const state = { count: initialCount, exists: initialCount > 0 }
  const ref = {
    _path: '',
    get: vi.fn(async () => ({
      exists: state.exists,
      data: () => ({ count: state.count, capWhenWritten: 250 }),
    })),
    set: vi.fn(async (data) => { state.count = data.count; state.exists = true }),
  }
  const firestore = {
    doc: vi.fn(() => ref),
    runTransaction: vi.fn(async (fn) => {
      const tx = {
        get: vi.fn(async () => ({
          exists: state.exists,
          data: () => ({ count: state.count, capWhenWritten: 250 }),
        })),
        set: vi.fn((_ref, data) => { state.count = data.count; state.exists = true }),
      }
      return fn(tx)
    }),
  }
  return { firestore, state, ref }
}

describe('todayKey', () => {
  it('formats YYYY-MM-DD in central time', () => {
    // Pin a known UTC date
    const d = new Date('2026-05-19T10:30:00Z')
    expect(todayKey(d, 'America/Chicago')).toBe('2026-05-19')
  })

  it('rolls over at midnight central, not UTC', () => {
    // 05:30 UTC = 00:30 CDT — still same Central day as previous UTC day
    const d = new Date('2026-05-20T05:30:00Z')
    expect(todayKey(d, 'America/Chicago')).toBe('2026-05-20')
  })
})

describe('checkAndIncrementRateLimit', () => {
  it('allows send when under cap and increments counter', async () => {
    const { firestore, state } = makeMockFirestore({ initialCount: 100 })
    const result = await checkAndIncrementRateLimit({ firestore, orgSlug: 'acme', cap: 250 })
    expect(result.allowed).toBe(true)
    expect(state.count).toBe(101)
  })

  it('blocks send when at cap', async () => {
    const { firestore, state } = makeMockFirestore({ initialCount: 250 })
    const result = await checkAndIncrementRateLimit({ firestore, orgSlug: 'acme', cap: 250 })
    expect(result.allowed).toBe(false)
    expect(result.current).toBe(250)
    expect(result.cap).toBe(250)
    expect(state.count).toBe(250) // not incremented
  })

  it('initializes counter on first send of day', async () => {
    const { firestore, state } = makeMockFirestore({ initialCount: 0 })
    state.exists = false
    const result = await checkAndIncrementRateLimit({ firestore, orgSlug: 'acme', cap: 250 })
    expect(result.allowed).toBe(true)
    expect(state.count).toBe(1)
  })
})
