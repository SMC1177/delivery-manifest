// functions/__tests__/storage-rules.test.js
// Text-level seam guards for storage.rules security invariants.
//
// THE CONTRACT. Org logos are uploaded SERVER-SIDE: the uploadOrgLogo
// callable (functions/upload-org-logo.js) writes the object through the
// Firebase Admin SDK, which BYPASSES Storage rules by design. Clients are
// therefore granted NO write or delete access in these rules at all — the
// former client write/delete grants (admin-role gate, 2 MB size cap,
// image-contentType condition) were deliberately removed 2026-08-04 when the
// upload moved off the client. Write protection now lives in
// functions/upload-org-logo.js (the callable authorizes the caller
// server-side before writing) and is covered by
// functions/__tests__/upload-org-logo.test.js — do not read this file and
// conclude the guarantee was dropped; it moved, and the no-client-write
// assertion below exists to keep it from coming back here.
//
// What remains in these rules is member-scoped READ for the org header logo,
// implemented with a cross-service firestore.exists() membership lookup.
// These are TEXT assertions against the rules source, not emulator tests —
// cross-service firestore.exists from Storage rules does not work under the
// Storage emulator (verified empirically in an earlier project), so an
// emulator test would fail for reasons unrelated to correctness. A failing
// exists() lookup degrades to a logo that does not display, not a security
// hole.
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
const codeText = compact(rulesText)
const orgBody = extractBlockBody(/match\s+\/organizations\/\{orgSlug\}\/\{fileName\}\s*\{/)
const orgCompact = orgBody ? compact(orgBody) : ''
// Every allow clause anywhere in the file that could grant a client write
// or delete — the method forms AND their Storage-rules aliases (create and
// update are write grants, get/list are read grants). Anything in here
// other than the catch-all's deny (`if false`) is a reintroduced hole.
const grantClauses = []
const allowRe = /allow\s*[a-zA-Z,\s]+?\s*:\s*[^;]+;/g
let allowMatch
while ((allowMatch = allowRe.exec(codeText)) !== null) {
  const clause = compact(allowMatch[0])
  if (/write|delete|create|update/.test(clause)) grantClauses.push(clause)
}

describe('storage.rules — security invariants', () => {
  it('no client write or delete grant exists anywhere in the rules', () => {
    // THE point of this file. Org logo uploads happen server-side: the
    // uploadOrgLogo callable writes via the Admin SDK, which bypasses these
    // rules, so clients must never be granted write/delete (or their
    // aliases create/update). The only write clause permitted anywhere is
    // the catch-all's `allow read, write: if false;`, which is a deny.
    // Restoring a real grant would silently reintroduce the entire failed
    // client-upload design (admin-role gate, size cap, contentType
    // condition) as rules that look protective but let clients straight
    // through — fail loudly instead.
    expect(grantClauses.length).toBeGreaterThan(0)
    for (const clause of grantClauses) {
      expect(
        clause,
        `'${clause}' grants clients write/delete access — org logo uploads are server-side: the uploadOrgLogo callable writes via the Admin SDK, which bypasses rules, so no allow write/delete/create/update may be granted to clients. Remove the grant; the callable owns all writes.`
      ).toMatch(/^allow(?:read,)?write:iffalse;$/)
    }
  })

  it('no firestore.get( role lookup remains in the rules', () => {
    // The cross-service admin role lookup (firestore.get().data.role ==
    // 'admin') was removed together with the client write grants — writes
    // are server-side now, so no role check exists in these rules. Comments
    // are stripped before analysis so a stale remark cannot fake a pass.
    expect(codeText).not.toMatch(/firestore\.get\s*\(/)
  })

  it('members may read organizations/{orgSlug}/{fileName} via isMember', () => {
    // The ONLY grant in the org block: member-scoped read so the header can
    // render the logo. Exact-compact match — any extra grant (a bare
    // `allow read: if true;`, an `allow get/list:`, or a write alias)
    // breaks the equality and fails loudly. No write or delete clause may
    // appear here (that is also asserted file-wide above).
    expect(orgBody).not.toBeNull()
    expect(orgCompact).toBe('allowread:ifisMember(orgSlug);')
  })

  it('isMember gates reads on a firestore.exists membership lookup', () => {
    // firestore.exists() is acceptable here even though cross-service
    // lookups fail under the Storage emulator: the worst case is a logo
    // that does not render, not unauthorized access. (The former
    // firestore.get role lookup is gone — asserted file-wide above.)
    const isMemberBody = extractBlockBody(/function\s+isMember\s*\([^)]*\)\s*\{/)
    expect(isMemberBody).not.toBeNull()
    expect(compact(isMemberBody)).toContain('firestore.exists(')
    expect(compact(isMemberBody)).not.toMatch(/firestore\.get\s*\(/)
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
