// functions/__tests__/facility-rules.test.js
// Disk seam guard: the facility tab reads organizations/{orgSlug}/facilities with the
// client SDK, so firestore.rules MUST carry a facilities match block. A missing block
// denies reads in production while OAuth/IAM tooling still succeeds — the exact gap
// that white-screened the tab on 2026-08-23.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(__dirname, '../../firestore.rules')
const rulesText = readFileSync(rulesPath, 'utf8')

// Same brace-walking extractor as platform-audit-rules.test.js: returns the text
// between a match block's opening '{' and its matching '}', or null if absent.
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

describe('firestore.rules — facilities collection access', () => {
  it('premise guard: the shipments block exists and grants members read+write (extractor works on this file)', () => {
    const body = extractBlockBody(/match\s+\/shipments\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    expect(body).toMatch(/allow\s+read,\s*write:\s*if\s+isMember\(orgSlug\);/)
  })

  it('a facilities match block exists in the organizations scope', () => {
    const body = extractBlockBody(/match\s+\/facilities\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
  })

  it('facilities grants org members read+write, mirroring shipments', () => {
    const body = extractBlockBody(/match\s+\/facilities\/\{\w+\}\s*\{/)
    expect(body).toMatch(/allow\s+read,\s*write:\s*if\s+isMember\(orgSlug\);/)
  })

  it('the facilities block appears exactly once (no duplicated insert)', () => {
    const occurrences = rulesText.match(/match\s+\/facilities\//g) || []
    expect(occurrences).toHaveLength(1)
  })
})
