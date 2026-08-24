import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_KEYS,
  TEMPLATE_LABELS,
  TEMPLATE_DEFAULTS,
  SENDABLE_TEMPLATE_KEYS,
  TEMPLATE_DRAFT_TRANSLATIONS,
  previewTemplate,
} from '../lib/smsTemplateVars'

describe('trackingAssigned registry entry', () => {
  it('is a first-class template key with a label', () => {
    expect(TEMPLATE_KEYS).toContain('trackingAssigned')
    expect(TEMPLATE_LABELS.trackingAssigned).toBeTruthy()
  })

  it('carries the approved default text with the tracking link', () => {
    expect(TEMPLATE_DEFAULTS.trackingAssigned).toBe(
      'Hi {{patientName}}, your prescription from {{pharmacyName}} is on its way. Track it here: {{trackingUrl}}'
    )
  })

  it('is NOT manually sendable — automated path only', () => {
    expect(SENDABLE_TEMPLATE_KEYS).not.toContain('trackingAssigned')
    // Premise guard: the sendable list is non-empty, so the absence is a choice
    // rather than an empty list satisfying not-toContain for the wrong reason.
    expect(SENDABLE_TEMPLATE_KEYS.length).toBeGreaterThan(0)
  })

  it('previewTemplate substitutes real placeholders and leaves unknown ones visible', () => {
    // RED at HEAD: the placeholder regex is /{{(w+)}}/g — a literal 'w' run,
    // never a real placeholder — so the editor preview has never substituted
    // (adversarial finding, 2026-08-24; server-side rendering is separate and
    // has always been correct).
    const out = previewTemplate('Hi {{patientName}}, from {{pharmacyName}}.', {
      patientName: 'John',
      pharmacyName: 'Trident',
    })
    expect(out).toBe('Hi John, from Trident.')
    expect(previewTemplate('{{mystery}} stays', {})).toBe('{{mystery}} stays')
  })

  it('ships es and fr operator-approval drafts preserving the placeholders', () => {
    for (const lang of ['es', 'fr']) {
      const draft = TEMPLATE_DRAFT_TRANSLATIONS[lang].trackingAssigned
      expect(draft).toBeTruthy()
      expect(draft).toContain('{{trackingUrl}}')
      expect(draft).toContain('{{pharmacyName}}')
    }
  })
})
