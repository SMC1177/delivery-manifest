// functions/__tests__/imports-rules.test.js
// Disk seam guard: the Archive Management page reads organizations/{orgSlug}/imports
// with the client SDK (v2/src/hooks/useImports.js:50), and ImportPreviewModal writes the
// companion imports/{importId} record after every import. firestore.rules carried NO
// imports match block from 2026-07-28 (ba2c5f56, which added the write) until this test,
// so Firestore denied both silently: the page showed "Missing or insufficient permissions"
// and the undo-an-import feature had never once had a record to undo.
// Same failure class, same file, same extractor as facility-rules.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(__dirname, '../../firestore.rules')
const rulesText = readFileSync(rulesPath, 'utf8')

// Same brace-walking extractor as facility-rules.test.js: returns the text between a
// match block's opening '{' and its matching '}', or null if absent.
function extractBlockBody(matchLineRegex) {
  const matchStart = rulesText.search(matchLineRegex)
  if (matchStart === -1) return null
  const openerMatch = rulesText.slice(matchStart).match(matchLineRegex)
  const braceOpen = matchStart + openerMatch.index + openerMatch[0].length - 1
  if (rulesText[braceOpen] !== '{') return null
  let depth = 1
  let pos = braceOpen + 1
  while (depth > 0 && pos < rulesText.length) {
    if (rulesText[pos] === '{') depth++
    else if (rulesText[pos] === '}') depth--
    pos++
  }
  return rulesText.slice(braceOpen + 1, pos - 1)
}

describe('firestore.rules - imports collection access', () => {
  it('premise guard: the rules file is readable and the extractor finds the shipments block', () => {
    expect(rulesText.length).toBeGreaterThan(0)
    const body = extractBlockBody(/match\s+\/shipments\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    expect(body).toMatch(/allow\s+read,\s*write:\s*if\s+isMember\(orgSlug\);/)
  })

  it('an imports match block exists', () => {
    const body = extractBlockBody(/match\s+\/imports\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
  })

  it('imports is nested inside the organizations/{orgSlug} scope, not at top level', () => {
    // A top-level block would never receive orgSlug and would silently never match.
    // The organizations block body must itself contain the imports match.
    const orgBody = extractBlockBody(/match\s+\/organizations\/\{\w+\}\s*\{/)
    expect(orgBody).not.toBeNull()
    expect(orgBody).toMatch(/match\s+\/imports\/\{\w+\}\s*\{/)
  })

  it('imports grants org members read and the writes the import flow performs', () => {
    const body = extractBlockBody(/match\s+\/imports\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    // Read: the Archive page lists import runs. Create/update: ImportPreviewModal
    // writes the companion record after each import.
    expect(body).toMatch(/allow[^;]*\bread\b[^;]*if\s+isMember\(orgSlug\);/)
    expect(body).toMatch(/allow[^;]*\bcreate\b[^;]*if\s+isMember\(orgSlug\);/)
  })

  it('imports grants NO client delete, in any form', () => {
    // Undo runs through an Admin SDK callable that bypasses rules, so a client
    // delete grant is pure surface. `write` is rejected here too because in
    // Firestore it expands to create + update + DELETE - the exact trap that
    // put a delete grant into this block on the first attempt.
    const body = extractBlockBody(/match\s+\/imports\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    const allowLines = body.match(/allow[^;]*;/g) || []
    expect(allowLines.length).toBeGreaterThan(0)
    for (const line of allowLines) {
      expect(line).not.toMatch(/\bdelete\b/)
      expect(line).not.toMatch(/\bwrite\b/)
    }
  })

  it('imports grants exactly read, create and update - the shape the app needs', () => {
    const body = extractBlockBody(/match\s+\/imports\/\{\w+\}\s*\{/)
    expect(body).toMatch(/allow\s+read,\s*create,\s*update:\s*if\s+isMember\(orgSlug\);/)
  })

  it('imports grants nothing unconditionally - every allow carries a membership check', () => {
    // PHI app: an over-broad rule turns a permissions bug into a data-exposure bug.
    const body = extractBlockBody(/match\s+\/imports\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    const allowLines = (body.match(/allow[^;]*;/g) || [])
    expect(allowLines.length).toBeGreaterThan(0)
    for (const line of allowLines) {
      expect(line).toMatch(/if\s+isMember\(orgSlug\)/)
      expect(line).not.toMatch(/if\s+true/)
    }
  })

  it('the imports block appears exactly once (no duplicated insert)', () => {
    const occurrences = rulesText.match(/match\s+\/imports\//g) || []
    expect(occurrences).toHaveLength(1)
  })
})
