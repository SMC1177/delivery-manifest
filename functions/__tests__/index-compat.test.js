import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('firestore.indexes.json — queue claim ordering (B.4)', () => {
  const indexFile = JSON.parse(
    readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8')
  )

  it('queue index must cover status, then nextAttemptAt, then createdAt', () => {
    const queueIndexes = (indexFile.indexes || []).filter(
      (i) => i.collectionGroup === 'queue'
    )

    const match = queueIndexes.find((i) => {
      const paths = (i.fields || []).map((f) => f.fieldPath)
      return (
        paths.length === 3 &&
        paths[0] === 'status' &&
        paths[1] === 'nextAttemptAt' &&
        paths[2] === 'createdAt'
      )
    })

    expect(
      match,
      'claimBatch chains .orderBy("nextAttemptAt").orderBy("createdAt") after a status filter, ' +
      'so Firestore needs the composite index (status, nextAttemptAt, createdAt). Without it the ' +
      'drain throws a missing-index error at runtime and no SMS is ever sent — a failure no unit ' +
      'test can see, because the mock has no index requirement.'
    ).toBeDefined()

    expect(
      (match?.fields || []).every((f) => f.order === 'ASCENDING'),
      'all three fields must be ASCENDING: the drain claims oldest-ready first.'
    ).toBe(true)
  })
})

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
