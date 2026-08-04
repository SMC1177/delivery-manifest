// functions/__tests__/storage-rules.test.js
// Text-level seam guards for storage.rules security invariants.
//
// Storage is a NEW attack surface for this project: the bucket was only
// provisioned 2026-08-04 after the logo upload hung against Firebase's
// locked-mode default rules. These are TEXT assertions against the rules
// source, not emulator tests — cross-service firestore.exists/get from
// Storage rules does not work under the Storage emulator (verified
// empirically in an earlier project), so an emulator test would fail for
// reasons unrelated to correctness.
//
// The highest-value guard here is the NULL-DEREF trap: firestore.get() on a
// missing Firestore document returns null, and chaining .data.role onto null
// makes the ENTIRE rule evaluation error instead of cleanly denying. Every
// role lookup must exists()-check the same path BEFORE the get() runs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(__dirname, '../../storage.rules')
const rulesText = readFileSync(rulesPath, 'utf8')
const firebaseJson = JSON.parse(readFileSync(resolve(__dirname, '../../firebase.json'), 'utf8'))

// All substance checks run on comment-stripped, whitespace-compacted text so
// the assertions survive harmless reformatting (indentation, line breaks,
// spacing around operators) but not changes to the security substance.
// Comments are stripped so a stale remark mentioning firestore.get() cannot
// pollute the call-count analysis.
function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '')
}
function compact(text) {
  return stripComments(text).replace(/\s+/g, '')
}
// Extract the body of a match block given a regex that matches the opening
// line (including the opening brace) — same pattern as the firestore.rules
// seam guard in platform-audit-rules.test.js.
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
// Return the balanced-paren argument of a call whose opening '(' sits at
// openParenIndex in text.
function callArgAt(text, openParenIndex) {
  let depth = 0
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(openParenIndex + 1, i)
    }
  }
  return null
}

const codeText = compact(rulesText)
const orgBody = extractBlockBody(/match\s+\/organizations\/\{orgSlug\}\/\{fileName\}\s*\{/)
const writeRule = orgBody && orgBody.match(/allow\s+write\s*:\s*[^;]+;/)
const deleteRule = orgBody && orgBody.match(/allow\s+delete\s*:\s*[^;]+;/)
const compactWrite = writeRule ? compact(writeRule[0]) : ''

describe('storage.rules — security invariants', () => {
  it('organizations write is gated on role == admin, not mere authentication', () => {
    // The write rule must reach the admin role check — either via the
    // isAdmin helper or an inlined role comparison. A relaxation to
    // "any signed-in user" would drop both the isAdmin call and the
    // role == 'admin' comparison, so both must hold.
    expect(compactWrite).toMatch(/isAdmin|role==['"]admin['"]/)
    expect(codeText).toMatch(/role==['"]admin['"]/)
  })

  it('organizations delete is admin-only', () => {
    expect(deleteRule).not.toBeNull()
    expect(compact(deleteRule[0])).toContain('isAdmin')
  })

  it('every role-lookup firestore.get is guarded by a same-path firestore.exists', () => {
    // THE null-deref trap: firestore.get() on a missing doc returns null,
    // and .data.role on null errors the whole evaluation instead of denying.
    // Role lookups (paths containing /members/ + request.auth.uid) must be
    // exists()-checked on the SAME path, textually before the get() so the
    // short-circuit runs first.
    const gets = []
    const getRe = /firestore\.get\s*\(/g
    let m
    while ((m = getRe.exec(codeText)) !== null) {
      gets.push({ index: m.index, path: callArgAt(codeText, getRe.lastIndex - 1) })
    }
    const roleGets = gets.filter(
      (g) => g.path && g.path.includes('members/') && g.path.includes('request.auth.uid')
    )
    expect(roleGets.length).toBeGreaterThan(0) // sanity: there IS a role lookup
    for (const g of roleGets) {
      expect(codeText.slice(0, g.index)).toContain('firestore.exists(' + g.path)
    }
    // Belt-and-braces: exists lookups must never be outnumbered by gets.
    const existsCount = (codeText.match(/firestore\.exists\s*\(/g) || []).length
    expect(existsCount).toBeGreaterThanOrEqual(gets.length)
  })

  it('server-side size limit constrains request.resource.size', () => {
    // The SettingsPage 2MB check is client-side only and not a security
    // control — the rules must enforce the cap themselves.
    expect(compactWrite).toMatch(/request\.resource\.size</)
    expect(compactWrite).toMatch(/2\*1024\*1024|2097152/)
  })

  it('content-type restriction limits uploads to images', () => {
    expect(compactWrite).toContain('request.resource.contentType')
    expect(compactWrite).toMatch(/contentType\.(?:matches\('image\/\.\*'\)|startsWith\('image\/'\))/)
  })

  it('deny-by-default catch-all exists for paths outside the organizations prefix', () => {
    const catchAll = extractBlockBody(/\bmatch\s+\/\{\w+=\*\*\}\s*\{/)
    expect(catchAll).not.toBeNull()
    const body = compact(catchAll)
    expect(body).toContain('read')
    expect(body).toContain('write')
    expect(body).toMatch(/:iffalse;/)
    // The catch-all must not grant anything.
    expect(body).not.toContain('iftrue')
  })

  it('firebase.json declares a top-level storage target pointing at storage.rules', () => {
    // Rules that exist in the repo but never deploy read as protection that
    // is not in force. Parse the JSON, don't string-match.
    const storage = firebaseJson.storage
    expect(storage).toBeDefined()
    const rulesEntries = Array.isArray(storage) ? storage.map((s) => s.rules) : [storage.rules]
    expect(rulesEntries).toContain('storage.rules')
  })
})
