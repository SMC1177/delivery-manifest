// functions/__tests__/platform-audit-rules.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(__dirname, '../../firestore.rules')
const rulesText = readFileSync(rulesPath, 'utf8')

describe('firestore.rules — platformAudit deny block integrity', () => {
  it('rules_version is declared as 2', () => {
    expect(rulesText).toMatch(/^rules_version\s*=\s*'2';/m)
  })

  it('contains a match /platformAudit/{entryId} block', () => {
    expect(rulesText).toMatch(/match\s+\/platformAudit\/\{\w+\}/)
  })

  it('platformAudit block has only one allow statement: allow read, write: if false;', () => {
    // Extract the platformAudit block body by brace matching
    const matchRegex = /match\s+\/platformAudit\/\{\w+\}\s*\{/
    const matchStart = rulesText.search(matchRegex)
    expect(matchStart).not.toBe(-1)

    // Find the opening brace of the match block (the final '{' in the match opener)
    const openerMatch = rulesText.slice(matchStart).match(matchRegex)
    const braceOpen = matchStart + openerMatch.index + openerMatch[0].length - 1
    expect(rulesText[braceOpen]).toBe('{')

    // Brace-match to find the closing brace
    let depth = 1
    let pos = braceOpen + 1
    while (depth > 0 && pos < rulesText.length) {
      if (rulesText[pos] === '{') depth++
      else if (rulesText[pos] === '}') depth--
      pos++
    }
    const blockBody = rulesText.slice(braceOpen + 1, pos - 1)

    // Count allow statements in the block
    const allowMatches = blockBody.match(/allow\s+[^;]+;/g)
    expect(allowMatches).not.toBeNull()
    expect(allowMatches.length).toBe(1)
    expect(allowMatches[0]).toMatch(/allow\s+read,\s*write:\s*if\s+false;/)
  })

  it('platformAudit match appears before the legacy catch-all match /{document=**}', () => {
    const platformAuditIdx = rulesText.search(/match\s+\/platformAudit\/\{\w+\}/)
    const catchAllIdx = rulesText.search(/match\s+\/\{document=\*\*\}/)
    expect(platformAuditIdx).not.toBe(-1)
    expect(catchAllIdx).not.toBe(-1)
    expect(platformAuditIdx).toBeLessThan(catchAllIdx)
  })
})
