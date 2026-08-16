import { describe, it, expect } from 'vitest'
import { renderTemplate, validateOptInInvite, TEMPLATE_VARS, validateTemplatePlaceholders } from '../sms-templates.js'

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

describe('validateTemplatePlaceholders', () => {
  it('accepts a body using a legitimate placeholder', () => {
    expect(() => validateTemplatePlaceholders('Hello {{patientName}}')).not.toThrow()
  })

  it('rejects an unknown placeholder and names it in the error', () => {
    expect(() => validateTemplatePlaceholders('Use {{drugName}} today')).toThrow(/drugName/)
  })

  it('reports all unknown placeholders in a single error', () => {
    let error
    try {
      validateTemplatePlaceholders('{{drugName}} then {{refillDate}} then {{doctorName}}')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeDefined()
    expect(error.message).toContain('drugName')
    expect(error.message).toContain('refillDate')
    expect(error.message).toContain('doctorName')
  })

  it('is deterministic when called twice in a row on the same body', () => {
    const body = 'Take {{drugName}} now'
    const outcomes = []
    for (let i = 0; i < 2; i++) {
      try {
        outcomes.push(['return', validateTemplatePlaceholders(body)])
      } catch (e) {
        outcomes.push(['throw', e.message])
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0])
  })

  it('accepts a body with no placeholders', () => {
    expect(() => validateTemplatePlaceholders('Your prescription is ready')).not.toThrow()
  })

  it('accepts an empty string', () => {
    expect(() => validateTemplatePlaceholders('')).not.toThrow()
  })

  it('passes without throwing for non-string inputs', () => {
    expect(() => validateTemplatePlaceholders(undefined)).not.toThrow()
    expect(() => validateTemplatePlaceholders(null)).not.toThrow()
    expect(() => validateTemplatePlaceholders(42)).not.toThrow()
  })

  it('keeps TEMPLATE_VARS matching the placeholders actually used by the send path', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../lib/smsBatching.js', import.meta.url), 'utf8')
    const chunks = []
    let cursor = source.indexOf('{')
    while (cursor !== -1) {
      const end = source.indexOf('}', cursor)
      if (end === -1) break
      chunks.push(source.slice(cursor, end + 1))
      cursor = source.indexOf('{', end + 1)
    }
    const expectedVars = [...TEMPLATE_VARS]
    // The object literal that BUILD the vars (key: value), not the function's
    // parameter destructuring, which names the same vars but has no colons.
    const sendVarsLiteral = chunks.find(
      (literal) =>
        expectedVars.every((key) => literal.includes(key)) &&
        /[A-Za-z_$][A-Za-z0-9_$]*\s*:/.test(literal)
    )
    if (!sendVarsLiteral) {
      throw new Error('Could not find the send-path vars object literal in smsBatching.js')
    }
    // Keys only: an identifier followed by a colon. Matching every identifier
    // would also pick up the VALUES (org.name, shipment.patientName, ...).
    const sendKeys = [
      ...new Set(
        [...sendVarsLiteral.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)].map((m) => m[1])
      ),
    ]
    // The batched send path (buildBatchedVars in lib/smsBatching.js) legitimately
    // adds prescriptionCount via BATCHED_TEMPLATE_VARS, so the literal is a
    // superset of TEMPLATE_VARS. Assert coverage, not exact equality.
    expect([...sendKeys].sort()).toEqual(expect.arrayContaining([...expectedVars].sort()))
  })
})
