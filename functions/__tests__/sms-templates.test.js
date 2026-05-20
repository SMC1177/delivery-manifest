import { describe, it, expect } from 'vitest'
import { renderTemplate, validateOptInInvite } from '../sms-templates.js'

describe('renderTemplate', () => {
  it('substitutes {{var}} placeholders', () => {
    const out = renderTemplate('Hi {{name}}, from {{org}}', { name: 'John', org: 'Acme RX' })
    expect(out).toBe('Hi John, from Acme RX')
  })

  it('throws on missing required placeholder', () => {
    expect(() => renderTemplate('Hi {{name}}', {})).toThrow(/missing template variable: name/i)
  })

  it('ignores extra vars not in template', () => {
    expect(renderTemplate('Hi {{name}}', { name: 'X', extra: 'ignored' })).toBe('Hi X')
  })

  it('handles repeated placeholders', () => {
    expect(renderTemplate('{{x}}/{{x}}', { x: 'a' })).toBe('a/a')
  })

  it('does not run template code — placeholders only', () => {
    // Defensive: no template language, no expressions
    expect(renderTemplate('{{x}}', { x: '${process.env.SECRET}' })).toBe('${process.env.SECRET}')
  })
})

describe('validateOptInInvite', () => {
  it('passes when both STOP and YES instructions present', () => {
    expect(() => validateOptInInvite('Reply YES to subscribe or STOP to opt out')).not.toThrow()
  })

  it('fails when STOP instruction missing', () => {
    expect(() => validateOptInInvite('Reply YES to subscribe')).toThrow(/must contain STOP/i)
  })

  it('fails when YES instruction missing', () => {
    expect(() => validateOptInInvite('Reply STOP to opt out')).toThrow(/must contain YES/i)
  })

  it('is case-insensitive on keyword detection', () => {
    expect(() => validateOptInInvite('reply yes to subscribe or stop to opt out')).not.toThrow()
  })
})
