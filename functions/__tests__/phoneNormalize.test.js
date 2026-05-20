import { describe, it, expect } from 'vitest'
import { normalizePhone } from '../lib/phoneNormalize.js'

describe('normalizePhone', () => {
  it('keeps E.164 input as-is', () => {
    expect(normalizePhone('+12815550123')).toBe('+12815550123')
  })

  it('adds +1 to 10-digit US numbers', () => {
    expect(normalizePhone('2815550123')).toBe('+12815550123')
  })

  it('strips spaces, dashes, parens, and dots', () => {
    expect(normalizePhone('(281) 555-0123')).toBe('+12815550123')
    expect(normalizePhone('281.555.0123')).toBe('+12815550123')
    expect(normalizePhone('281 555 0123')).toBe('+12815550123')
  })

  it('adds +1 to 11-digit numbers starting with 1', () => {
    expect(normalizePhone('12815550123')).toBe('+12815550123')
  })

  it('throws on too-short input', () => {
    expect(() => normalizePhone('5550123')).toThrow(/invalid phone/i)
  })

  it('throws on non-numeric input', () => {
    expect(() => normalizePhone('not-a-phone')).toThrow(/invalid phone/i)
  })

  it('throws on empty input', () => {
    expect(() => normalizePhone('')).toThrow(/invalid phone/i)
    expect(() => normalizePhone(null)).toThrow(/invalid phone/i)
    expect(() => normalizePhone(undefined)).toThrow(/invalid phone/i)
  })

  it('rejects non-US country code input for v1 (we only support US)', () => {
    expect(() => normalizePhone('+442012345678')).toThrow(/only US/i)
  })
})
