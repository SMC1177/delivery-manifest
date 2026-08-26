// v2/src/__tests__/archiveProgressRender.test.js
// Regression guard for a LIVE white-screen: on 2026-08-26 the operator clicked
// "Run Indexing Pass" and "Run Preparation Pass" on the Archive page and the app
// blanked instantly, three times.
//
// ArchivePage rendered `{progress} records processed`, but progress is the state
// object from useArchiveActions - useState({ processed: 0, changed: 0 }) - and React
// rejects an object as a child ("Objects are not valid as a React child"). The crash
// fired the moment `busy` flipped true, i.e. on click, before any work finished.
// The guard `progress !== undefined` was dead code: an object is never undefined.
//
// The same file already had the correct idiom in the delete danger zone
// (`progress.processed != null ? ... : 'Working…'`); these two banners had missed it.
//
// This is a SOURCE-level guard, not a render test: it proves the defective pattern is
// absent from the file. It cannot prove the span displays a real number to a user, and
// it would not catch a different way of rendering an object as a child. That limit is
// deliberate - mocking this page's auth, router, toast and four hooks was judged a
// larger risk than the one-line fix it would be testing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pagePath = resolve(__dirname, '../pages/ArchivePage.jsx')
const source = readFileSync(pagePath, 'utf8')

describe('ArchivePage - progress must never render as an object', () => {
  it('premise guard: the page is readable and still has both pass buttons', () => {
    expect(source.length).toBeGreaterThan(0)
    expect(source).toContain('Run Indexing Pass')
    expect(source).toContain('Run Preparation Pass')
  })

  it('renders no bare {progress} anywhere - that is the white-screen', () => {
    const bare = source.match(/\{\s*progress\s*\}/g) || []
    expect(
      bare,
      'progress is an object ({processed, changed}); rendering it as a React child blanks the page'
    ).toHaveLength(0)
  })

  it('every "records processed" readout renders a count, not the object', () => {
    const lines = source.split('\n').filter((l) => l.includes('records processed'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(
        line,
        `this line must render progress.processed, not progress: ${line.trim()}`
      ).toMatch(/progress\.processed/)
    }
  })

  it('the dead `progress !== undefined` guard is gone', () => {
    // An object is never undefined, so that test excluded nothing and gave the
    // false impression the render was guarded.
    expect(source).not.toMatch(/progress\s*!==\s*undefined/)
  })
})
