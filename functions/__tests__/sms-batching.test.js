import { describe, it, expect } from 'vitest'
import { buildBatchedVars, BATCHED_TEMPLATE_VARS } from '../lib/smsBatching.js'
import { TEMPLATE_VARS } from '../sms-templates.js'

/**
 * Batching is pure: it turns one queue item into the variables a template needs.
 * No firestore, so no mock — the collapse by tracking number already happened at
 * enqueue time, via the queue's document key.
 *
 * The PHI rule is the reason this module exists at all. Clinical fields must
 * never reach a patient's phone, so the builder constructs its output from an
 * explicit allowlist rather than spreading whatever it was handed.
 */

const PHARMACY = {
  pharmacyName: 'Trident Medical Group',
  patientName: 'John Doe',
  pharmacyPhone: '+14045551234',
}

describe('buildBatchedVars', () => {
  it('counts the prescriptions in a box from its shipment ids', () => {
    const vars = buildBatchedVars({
      item: { shipmentIds: ['s_1', 's_2', 's_3'] },
      ...PHARMACY,
    })
    expect(vars.prescriptionCount).toBe(3)
  })

  it('handles the measured worst case of eleven prescriptions in one box', () => {
    const shipmentIds = Array.from({ length: 11 }, (_, i) => `s_${i}`)
    const vars = buildBatchedVars({ item: { shipmentIds }, ...PHARMACY })
    expect(vars.prescriptionCount).toBe(11)
  })

  it('treats a notification carrying no shipment ids as one prescription, never zero', () => {
    const vars = buildBatchedVars({ item: { shipmentIds: [] }, ...PHARMACY })
    expect(vars.prescriptionCount).toBe(1)
  })

  it('treats a missing shipmentIds field the same way rather than throwing', () => {
    const vars = buildBatchedVars({ item: {}, ...PHARMACY })
    expect(vars.prescriptionCount).toBe(1)
  })

  it('passes the pharmacy and patient variables through unchanged', () => {
    const vars = buildBatchedVars({ item: { shipmentIds: ['s_1'] }, ...PHARMACY })
    expect(vars.pharmacyName).toBe('Trident Medical Group')
    expect(vars.patientName).toBe('John Doe')
    expect(vars.pharmacyPhone).toBe('+14045551234')
  })

  it('returns ONLY allowlisted variables, dropping any clinical field handed to it', () => {
    const vars = buildBatchedVars({
      item: { shipmentIds: ['s_1'] },
      ...PHARMACY,
      drugName: 'Celecoxib Oral Capsule 200 MG',
      ndc: '00093372755',
      drugGpi: '66100510002020',
    })
    expect(Object.keys(vars).sort()).toEqual([...BATCHED_TEMPLATE_VARS].sort())
    expect(vars.drugName).toBeUndefined()
    expect(vars.ndc).toBeUndefined()
    expect(vars.drugGpi).toBeUndefined()
  })

  it('never leaks a clinical field carried on the queue item itself', () => {
    const vars = buildBatchedVars({
      item: {
        shipmentIds: ['s_1', 's_2'],
        drugName: 'Celecoxib Oral Capsule 200 MG',
        ndc: '00093372755',
        drugGpi: '66100510002020',
        rxNumber: '1111111',
      },
      ...PHARMACY,
    })
    const serialised = JSON.stringify(vars)
    expect(serialised).not.toMatch(/celecoxib/i)
    expect(serialised).not.toMatch(/00093372755/)
    expect(serialised).not.toMatch(/66100510002020/)
    expect(serialised).not.toMatch(/1111111/)
  })

  it('throws when pharmacyName is missing, because every template needs it', () => {
    expect(() =>
      buildBatchedVars({
        item: { shipmentIds: ['s_1'] },
        patientName: 'John Doe',
        pharmacyPhone: '+14045551234',
      })
    ).toThrow(/pharmacyName/)
  })
})

describe('BATCHED_TEMPLATE_VARS', () => {
  it('adds exactly one name to the existing allowlist', () => {
    expect(BATCHED_TEMPLATE_VARS).toEqual([...TEMPLATE_VARS, 'prescriptionCount'])
  })

  it('contains no variable whose name suggests a clinical field', () => {
    for (const name of BATCHED_TEMPLATE_VARS) {
      expect(name).not.toMatch(/drug|ndc|gpi|rx|diagnos|medication|dose/i)
    }
  })
})
