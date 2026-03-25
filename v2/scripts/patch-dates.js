#!/usr/bin/env node

/**
 * Patches migrated shipments to add the original v1 `date` field.
 * Reads from backup file, updates each doc in Firestore.
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PROJECT_ID = 'delivery-manifest-c3deb'
const V2_COLLECTION = 'organizations/woodlandsrx/shipments'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

async function getAccessToken() {
  const refreshToken = execSync(
    `node -e "const c=require('C:/Users/SMC11/AppData/Roaming/npm/node_modules/firebase-tools/lib/configstore.js');const t=c.configstore?c.configstore.get('tokens'):c.default?.configstore?.get('tokens');if(t)process.stdout.write(t.refresh_token||'')"`,
    { encoding: 'utf8' }
  ).trim()

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  return data.access_token
}

async function main() {
  const backup = JSON.parse(readFileSync(resolve(__dirname, 'backup-2026-03-15.json'), 'utf8'))
  console.log(`Patching ${backup.length} documents with date field...\n`)

  const token = await getAccessToken()
  let patched = 0
  let errors = 0

  for (const rec of backup) {
    if (!rec.date || !rec._docId) continue
    try {
      const url = `${BASE}/${V2_COLLECTION}/${rec._docId}?updateMask.fieldPaths=date`
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            date: { stringValue: rec.date },
          },
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error?.message || 'Unknown error')
      }
      patched++
      process.stdout.write(`\rPatched: ${patched}/${backup.length}`)
    } catch (err) {
      errors++
      console.error(`\n❌ ${rec._docId}: ${err.message}`)
    }
  }

  console.log(`\n\n✅ Done. ${patched} patched, ${errors} errors.`)
}

main().catch(console.error)
