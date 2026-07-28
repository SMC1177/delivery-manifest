// functions/__tests__/manual-add-rules.test.js
// Text-level seam guards for the admin-create widening on userProfiles.
// Guards against the org-admin profile-create path being silently loosened,
// reverted, or widened beyond its intended scope.
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

// Helper: extract individual allow-statements from a block body.
// Returns an array of { type, condition } objects where type is the
// operation(s) (e.g. "read", "create", "update, delete") and condition
// is the if-expression text.
function extractAllowStatements(body) {
  // Match "allow <ops>: if <condition>;" across potentially multiple lines.
  // We collapse line-continuations by normalising whitespace.
  const normalized = body.replace(/\s+/g, ' ')
  const re = /allow\s+((?:read|write|create|update|delete|get|list)(?:\s*,\s*(?:read|write|create|update|delete|get|list))*)\s*:\s*if\s+([^;]+);/g
  const statements = []
  let m
  while ((m = re.exec(normalized)) !== null) {
    statements.push({ type: m[1].replace(/\s+/g, ''), condition: m[2] })
  }
  return statements
}

describe('firestore.rules — manual-add admin-create invariants', () => {
  const upBody = extractBlockBody(/match\s+\/userProfiles\/\{\w+\}\s*\{/)
  const allowStmts = upBody ? extractAllowStatements(upBody) : []

  // --- userProfiles block existence ---
  it('userProfiles match block exists', () => {
    expect(upBody).not.toBeNull()
  })

  // --- no bare combined allow read,write ---
  it('userProfiles does NOT have a bare combined allow read,write', () => {
    // A combined "allow read, write:" would blanket-authorize and defeat
    // the split between read (owner-only), create (owner+admin), and
    // update/delete (owner-only).
    expect(upBody).not.toMatch(/allow\s+read,\s*write\s*:/)
    // Also guard against "allow write:" which would combine create+update+delete
    expect(upBody).not.toMatch(/allow\s+write\s*:/)
  })

  // --- read is owner-only ---
  it('read clause is owner-only (no admin widening)', () => {
    const readStmt = allowStmts.find(s => s.type === 'read')
    expect(readStmt).toBeDefined()
    expect(readStmt.condition).toContain('request.auth.uid == userId')
    // Must NOT be widened to admins
    expect(readStmt.condition).not.toMatch(/isAdmin/)
  })

  // --- create clause ---
  it('create clause references isAdmin scoped to request.resource.data.orgSlug', () => {
    const createStmt = allowStmts.find(s => s.type === 'create')
    expect(createStmt).toBeDefined()
    // The admin path must be scoped to the orgSlug ON THE INCOMING DOCUMENT,
    // not an arbitrary or caller-supplied org. This prevents an admin of org-A
    // from creating a profile doc scoped to org-B.
    expect(createStmt.condition).toMatch(/isAdmin\(request\.resource\.data\.orgSlug\)/)
  })

  it('create clause still permits the owner (self-create)', () => {
    const createStmt = allowStmts.find(s => s.type === 'create')
    expect(createStmt).toBeDefined()
    // The owner path: request.auth.uid == userId must still be present
    // so a user can create their own profile.
    expect(createStmt.condition).toContain('request.auth.uid == userId')
  })

  it('create clause requires isSignedIn for both owner and admin paths', () => {
    const createStmt = allowStmts.find(s => s.type === 'create')
    expect(createStmt).toBeDefined()
    // The isSignedIn() guard applies to the whole create clause.
    // Check that isSignedIn() appears AND comes before the inner conditions.
    expect(createStmt.condition).toContain('isSignedIn()')
    // The parenthesised OR expression must be after isSignedIn()
    expect(createStmt.condition).toMatch(
      /isSignedIn\(\).*\(.*request\.auth\.uid == userId.*\|\|.*isAdmin/
    )
  })

  // --- update, delete remain owner-only ---
  it('update,delete clause is owner-only (no admin widening)', () => {
    const udStmt = allowStmts.find(s => s.type === 'update,delete')
    expect(udStmt).toBeDefined()
    expect(udStmt.condition).toContain('isSignedIn()')
    expect(udStmt.condition).toContain('request.auth.uid == userId')
    // Must NOT contain isAdmin — only create is widened
    expect(udStmt.condition).not.toMatch(/isAdmin/)
  })

  it('update,delete clause does NOT reference orgSlug', () => {
    // If orgSlug appeared in update/delete, the clause might be
    // accidentally permissive across orgs.
    const udStmt = allowStmts.find(s => s.type === 'update,delete')
    expect(udStmt).toBeDefined()
    expect(udStmt.condition).not.toMatch(/orgSlug/)
  })

  // --- isAdmin helper ---
  it('isAdmin helper requires role == admin (not weakened)', () => {
    // The isAdmin function must do a get() on the org's members doc
    // and check role == 'admin'. If someone weakens this to role != null
    // or role in ['admin','member'], any org member could create profiles.
    expect(rulesText).toMatch(/function isAdmin\([\s\S]*?\.role\s*==\s*'admin'/)
  })

  it('isAdmin helper requires the caller to be signed in', () => {
    // isAdmin must call isSignedIn() as its first guard.
    expect(rulesText).toMatch(/function isAdmin\([\s\S]*?isSignedIn\(\)/)
  })

  it('isAdmin helper does a get() on the members subcollection', () => {
    // Must look up the caller's member doc in the org, not some other path.
    expect(rulesText).toMatch(
      /function isAdmin\([\s\S]*?get\(\/databases\/\$\(database\)\/documents\/organizations\/\$\(orgSlug\)\/members\/\$\(request\.auth\.uid\)\)/
    )
  })

  // --- guard against write blanket ---
  it('no separate allow write or allow create,update,delete that bypasses the split', () => {
    // The block must have exactly three allow statements: read, create, and update,delete.
    // Any extra or different grouping could indicate a regression.
    const types = allowStmts.map(s => s.type).sort()
    expect(types).toEqual(['create', 'read', 'update,delete'])
  })

  // --- structural: isAdmin is confined to the create clause ---
  it('isAdmin is confined to the create clause (not in read or update,delete)', () => {
    // Already verified piecewise above, but this is a belt-and-suspenders
    // check: isAdmin must appear exactly on the create statement and on
    // no other allow statement.
    const readStmt = allowStmts.find(s => s.type === 'read')
    const createStmt = allowStmts.find(s => s.type === 'create')
    const udStmt = allowStmts.find(s => s.type === 'update,delete')

    expect(readStmt).toBeDefined()
    expect(createStmt).toBeDefined()
    expect(udStmt).toBeDefined()

    // create has isAdmin; read and update,delete do not
    expect(createStmt.condition).toMatch(/isAdmin/)
    expect(readStmt.condition).not.toMatch(/isAdmin/)
    expect(udStmt.condition).not.toMatch(/isAdmin/)
  })
})
