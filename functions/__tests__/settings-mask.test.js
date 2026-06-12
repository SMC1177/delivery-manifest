import { describe, it, expect } from 'vitest'
import { MASK_MARKER, SECRET_FIELD_PATTERNS, isSecretKey, maskSecrets, stripMaskMarkers } from '../lib/settings-mask.js'

describe('isSecretKey', () => {
  it('returns true for secret-matching keys', () => {
    const trueKeys = ['clientSecret', 'webhookToken', 'PASSWORD', 'api_key', 'apiKey', 'jwtToken', 'privateKey', 'TRACK_ALERT_WEBHOOK_SECRET']
    for (const key of trueKeys) {
      expect(isSecretKey(key)).toBe(true)
    }
  })

  it('returns false for non-secret keys', () => {
    const falseKeys = ['notes', 'name', 'optInPolicy', 'enabledFields', 'totalShipments']
    for (const key of falseKeys) {
      expect(isSecretKey(key)).toBe(false)
    }
  })
})

describe('maskSecrets', () => {
  it('masks RingCentral-style creds nested 3 deep', () => {
    const input = { settings: { ringcentral: { clientId: 'cid', clientSecret: 'RAW-SECRET', jwt: 'RAW-JWT' } } }
    const result = maskSecrets(input)
    // clientSecret and jwt should be masked
    expect(result.settings.ringcentral.clientSecret).toBe(MASK_MARKER)
    expect(result.settings.ringcentral.jwt).toBe(MASK_MARKER)
    // clientId is not secret per patterns (no match), so it should remain unmasked
    expect(result.settings.ringcentral.clientId).toBe('cid')
    // raw secrets must not appear in stringified output
    const str = JSON.stringify(result)
    expect(str).not.toContain('RAW-SECRET')
    expect(str).not.toContain('RAW-JWT')
  })

  it('passes non-string secret values through unmutated', () => {
    const inputs = [{ token: null }, { secret: 42 }, { password: true }]
    for (const input of inputs) {
      const result = maskSecrets(input)
      expect(result).toEqual(input)
    }
  })

  it('masks string elements of arrays under secret keys', () => {
    const out = maskSecrets({
      tokens: ['RAW-T1', 'RAW-T2'],
      apiKeys: [{ key: 'RAW-K1', label: 'prod' }],
      templates: ['hello {name}'],   // non-secret key: untouched
    })
    const s = JSON.stringify(out)
    expect(s).not.toContain('RAW-T1')
    expect(s).not.toContain('RAW-T2')
    expect(s).not.toContain('RAW-K1')
    expect(s).not.toContain('prod')  // label under secret-keyed array is also masked
    expect(out.tokens).toHaveLength(2)
    expect(out.tokens[0]).toBe(MASK_MARKER)
    expect(out.templates[0]).toBe('hello {name}')
  })

  it('does not mutate the input object', () => {
    const input = { password: 'secret123', nested: { token: 'abc' } }
    const frozen = JSON.parse(JSON.stringify(input))
    maskSecrets(input)
    expect(input).toEqual(frozen)
  })
})

describe('stripMaskMarkers', () => {
  it('removes marker-valued properties nested deep', () => {
    const input = {
      name: 'test',
      password: MASK_MARKER,
      nested: {
        token: MASK_MARKER,
        other: 'keep'
      },
      array: [MASK_MARKER, 'real']
    }
    const result = stripMaskMarkers(input)
    expect(result.password).toBeUndefined()
    expect(result.nested.token).toBeUndefined()
    expect(result.nested.other).toBe('keep')
    expect(result.array).toEqual(['real'])
  })

  it('keeps genuinely new secret values', () => {
    const input = {
      password: 'new-real-secret',
      token: MASK_MARKER
    }
    const result = stripMaskMarkers(input)
    expect(result.password).toBe('new-real-secret')
    expect(result.token).toBeUndefined()
  })

  it('keeps non-secret data', () => {
    const input = { name: 'test', count: 5, active: true }
    const result = stripMaskMarkers(input)
    expect(result).toEqual(input)
  })
})

describe('round-trip', () => {
  it('stripMaskMarkers(maskSecrets(fixture)) contains no MASK_MARKER and no raw secret values', () => {
    const fixture = {
      name: 'my app',
      clientSecret: 'raw-secret-1',
      apiKey: 'raw-secret-2',
      jwtToken: 'raw-secret-3',
      password: 'raw-secret-4',
      webhookToken: 'raw-secret-5',
      nested: {
        token: 'raw-secret-6'
      },
      tokens: ['raw-secret-7', 'raw-secret-8'],
      apiKeys: [{ key: 'raw-secret-9', label: 'prod' }]
    }
    const masked = maskSecrets(fixture)
    const stripped = stripMaskMarkers(masked)
    const str = JSON.stringify(stripped)
    expect(str).not.toContain(MASK_MARKER)
    expect(str).not.toContain('raw-secret-1')
    expect(str).not.toContain('raw-secret-2')
    expect(str).not.toContain('raw-secret-3')
    expect(str).not.toContain('raw-secret-4')
    expect(str).not.toContain('raw-secret-5')
    expect(str).not.toContain('raw-secret-6')
    expect(str).not.toContain('raw-secret-7')
    expect(str).not.toContain('raw-secret-8')
    expect(str).not.toContain('raw-secret-9')
    expect(str).not.toContain('prod')
    // Non-secret data should survive
    expect(stripped.name).toBe('my app')
  })
})
