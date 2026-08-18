import { describe, it, expect } from 'vitest'
import { applyMapping } from '../utils/excelImport'

// Measured in production on 2026-08-18: across 100 live Trident shipments, every
// one of the 22 extended pharmacy fields is present 100/100 and non-empty 0/100.
// ImportPreviewModal writes them as `?? ''` and applyMapping never emits them, so
// the `??` always falls through. ColumnMappingScreen already offers all 32 targets,
// so a user can map a column, save it, run an import, and receive an empty string.

describe('applyMapping emits the extended pharmacy fields', () => {
  const rows = [
    {
      'Customer Name': 'Ada Lovelace',
      'Shipment Tracking Number': '1Z999AA10123456784',
      'Dispensed Drug Description': 'ATORVASTATIN 20MG TAB',
      'Date Filled': '3/14/2026',
      'Copay Amount': 0,
      'Facility Name': 'Trident Main',
      NDC: '00093505698',
    },
  ]

  const mapping = {
    patientName: 'Customer Name',
    trackingNumber: 'Shipment Tracking Number',
    drugDescription: 'Dispensed Drug Description',
    dateFilled: 'Date Filled',
    copayAmount: 'Copay Amount',
    facilityName: 'Facility Name',
    ndc: 'NDC',
  }

  it('carries a mapped drugDescription through to the result', () => {
    const [out] = applyMapping(rows, mapping)
    expect(out.drugDescription).toBe('ATORVASTATIN 20MG TAB')
  })

  it('carries a mapped facilityName and ndc through to the result', () => {
    const [out] = applyMapping(rows, mapping)
    expect(out.facilityName).toBe('Trident Main')
    expect(out.ndc).toBe('00093505698')
  })

  it('emits dateFilled as its own field, not only as a fallback for date', () => {
    const [out] = applyMapping(rows, mapping)
    // `date` is unmapped here, so the canonical resolution falls back to dateFilled.
    expect(out.date).not.toBe('')
    // But dateFilled must ALSO survive as a field in its own right.
    expect(out.dateFilled).not.toBe('')
  })

  it('keeps a legitimate 0 for a numeric field instead of collapsing it to an empty string', () => {
    const [out] = applyMapping(rows, mapping)
    // Same bug class as r2-fix-refill-zero (b33eb366): a truthiness test turns the
    // NUMBER 0 into ''. A $0 copay is real data, not a missing value.
    expect(out.copayAmount).not.toBe('')
    expect(Number(out.copayAmount)).toBe(0)
  })

  it('leaves an UNMAPPED extended field empty, so nothing changes for an org that maps nothing', () => {
    const [out] = applyMapping(rows, { patientName: 'Customer Name' })
    expect(out.drugDescription).toBe('')
    expect(out.prescriberLastName).toBe('')
  })
})
