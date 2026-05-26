import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('firestore.indexes.json — collection-scope compatibility', () => {
  const indexFile = JSON.parse(
    readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8')
  )

  // Fields the frontend queries at COLLECTION scope in useShipments.js addShipment
  const frontendCollectionFields = ['trackingNumber', 'patientName', 'date']

  it('fieldOverrides must preserve COLLECTION scope for frontend-queried fields', () => {
    const overrides = indexFile.fieldOverrides || []

    for (const field of frontendCollectionFields) {
      const override = overrides.find(
        o => o.collectionGroup === 'shipments' && o.fieldPath === field
      )
      if (!override) continue // no override = default indexing = COLLECTION scope exists

      const hasCollectionScope = override.indexes.some(
        idx => idx.queryScope === 'COLLECTION'
      )
      expect(
        hasCollectionScope,
        `fieldOverride for shipments.${field} must include COLLECTION scope — ` +
        `the frontend queries this field at collection scope in useShipments.js addShipment. ` +
        `Without it, Firestore throws a missing-index error on save.`
      ).toBe(true)
    }
  })
})
