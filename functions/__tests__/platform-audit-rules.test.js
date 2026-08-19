// functions/__tests__/platform-audit-rules.test.js
// Text-level seam guards for firestore.rules security invariants.
// THE regression guard for the cross-org PHI hole fixed 2026-06-11:
// a bare root catch-all must never reappear.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = resolve(__dirname, '../../firestore.rules')
const rulesText = readFileSync(rulesPath, 'utf8')

// Helper: extract the body of a match block given a regex that matches
// the opening line (including the opening brace). Returns the text
// between the opening '{' and its matching '}'.
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

describe('firestore.rules — security invariants', () => {
  it('declares rules_version 2', () => {
    expect(rulesText).toMatch(/^rules_version\s*=\s*'2';/m)
  })

  it('platformAudit denies all client access', () => {
    const body = extractBlockBody(/match\s+\/platformAudit\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    const allowMatches = body.match(/allow\s+[^;]+;/g)
    expect(allowMatches).not.toBeNull()
    expect(allowMatches.length).toBe(1)
    expect(allowMatches[0]).toMatch(/allow\s+read,\s*write:\s*if\s+false;/)
  })

  it('has NO bare root catch-all match /{document=**}', () => {
    // The bare root form is match /{document=**} without a prefix path.
    // The artifacts block uses match /artifacts/{document=**} so it won't match.
    const bareCatchAll = rulesText.match(/match\s+\/\{document=\*\*\}/)
    expect(bareCatchAll).toBeNull()
  })

  it('legacy v1 access is scoped to /artifacts and signed-in only', () => {
    const body = extractBlockBody(/match\s+\/artifacts\/\{document=\*\*\}\s*\{/)
    expect(body).not.toBeNull()
    expect(body).toContain('isSignedIn()')
    expect(body).not.toContain('if true')
  })

  it('isMember isolation gates shipments, deliveries, settings', () => {
    // Verify isMember function exists with exists() call on members path
    expect(rulesText).toContain('function isMember(orgSlug)')
    expect(rulesText).toContain('exists(/databases/$(database)/documents/organizations/$(orgSlug)/members/$(request.auth.uid))')

    // Check each block contains isMember(orgSlug)
    const shipmentBody = extractBlockBody(/match\s+\/shipments\/\{\w+\}\s*\{/)
    expect(shipmentBody).not.toBeNull()
    expect(shipmentBody).toContain('isMember(orgSlug)')

    const deliveryBody = extractBlockBody(/match\s+\/deliveries\/\{\w+\}\s*\{/)
    expect(deliveryBody).not.toBeNull()
    expect(deliveryBody).toContain('isMember(orgSlug)')

    const settingsBody = extractBlockBody(/match\s+\/settings\/\{\w+\}\s*\{/)
    expect(settingsBody).not.toBeNull()
    expect(settingsBody).toContain('isMember(orgSlug)')
  })

  it('smsContacts: client writes denied, reads member-gated', () => {
    const body = extractBlockBody(/match\s+\/smsContacts\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    expect(body).toContain('allow write: if false;')
    expect(body).toContain('isMember(orgSlug)')
  })

  it('userProfiles remains own-profile only', () => {
    const body = extractBlockBody(/match\s+\/userProfiles\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()
    expect(body).toContain('request.auth.uid == userId')
  })

  // ══════════════════════════════════════════════════════════════════════════
  // Members subcollection rules — guards against the self-join security hole.
  // Before the fix, allow create permitted request.auth.uid == memberId,
  // letting ANY signed-in user create their own membership in ANY org.
  // The fix: create is admin-only; update still allows self-update (needed
  // for MFA enrollment).
  // ══════════════════════════════════════════════════════════════════════════

  it('members allow create MUST NOT permit self-create (no request.auth.uid == memberId)', () => {
    const body = extractBlockBody(/match\s+\/members\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()

    // Extract the create rule
    const createMatch = body.match(/allow\s+create\s*:\s*[^;]+;/)
    expect(createMatch).not.toBeNull()
    const createRule = createMatch[0]

    // THE INVARIANT: create must NOT allow self-uid matching
    expect(createRule).not.toMatch(/request\.auth\.uid\s*==\s*memberId/)
    // Create must gate on isAdmin — only admins can add members
    expect(createRule).toMatch(/isAdmin/)
  })

  it('members allow update STILL permits self-update (request.auth.uid == memberId)', () => {
    const body = extractBlockBody(/match\s+\/members\/\{\w+\}\s*\{/)
    expect(body).not.toBeNull()

    // Extract the update rule
    const updateMatch = body.match(/allow\s+update\s*:\s*[^;]+;/)
    expect(updateMatch).not.toBeNull()
    const updateRule = updateMatch[0]

    // THE INVARIANT: update MUST still allow self-uid matching
    // This is required for MFA enrollment — tightening it would re-create
    // a lockout fixed earlier today.
    expect(updateRule).toMatch(/request\.auth\.uid\s*==\s*memberId/)
  })
})
