import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkAndIncrementRateLimit, todayKey, shouldHoldForWindow } from '../sms-rate-limit.js'

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

describe('shouldHoldForWindow', () => {
  it('7:59 Central — not held (before the 8 o-clock hour)', () => {
    const now = new Date('2026-05-19T12:59:00Z') // 07:59 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(false)
  })

  it('8:00 Central, createdAt PRIOR DAY — not held (prior-day sends during reserved hour)', () => {
    const now = new Date('2026-05-19T13:00:00Z') // 08:00 CDT
    const createdAt = new Date('2026-05-18T10:00:00Z') // yesterday Central
    expect(shouldHoldForWindow({ now, createdAt })).toBe(false)
  })

  it('8:00 Central, createdAt SAME DAY — held', () => {
    const now = new Date('2026-05-19T13:00:00Z') // 08:00 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(true)
  })

  it('8:59 Central, createdAt SAME DAY — held', () => {
    const now = new Date('2026-05-19T13:59:00Z') // 08:59 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(true)
  })

  it('9:00 Central, createdAt SAME DAY — not held', () => {
    const now = new Date('2026-05-19T14:00:00Z') // 09:00 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(false)
  })

  it('18:55 Central, createdAt SAME DAY — not held', () => {
    const now = new Date('2026-05-19T23:55:00Z') // 18:55 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(false)
  })

  it('19:00 Central — not held (unreachable via cron 8-18, assert anyway)', () => {
    const now = new Date('2026-05-20T00:00:00Z') // 19:00 CDT
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(false)
  })

  it('spring-forward day 2026-03-08, 8:00 Central — held; todayKey is the transition day', () => {
    const now = new Date('2026-03-08T13:00:00Z') // 08:00 CDT (spring forward: 02:00 CST -> 03:00 CDT)
    expect(todayKey(now, 'America/Chicago')).toBe('2026-03-08')
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(true)
  })

  it('fall-back day 2026-11-01, 8:00 Central — held; todayKey is the transition day', () => {
    const now = new Date('2026-11-01T14:00:00Z') // 08:00 CST (fall back: 02:00 CDT -> 01:00 CST)
    expect(todayKey(now, 'America/Chicago')).toBe('2026-11-01')
    expect(shouldHoldForWindow({ now, createdAt: now })).toBe(true)
  })
})
