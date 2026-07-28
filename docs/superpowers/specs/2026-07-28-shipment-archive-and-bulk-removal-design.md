# Shipment Archive & Bulk Removal — Design

**Date:** 2026-07-28
**Status:** approved (design), not yet implemented
**Related:** pagination is deliberately OUT of scope — see "Deferred" below.

## Problem

An organization accumulated ~22,000 shipments over 4+ years and the dashboard went
blank. The operator had no way to clear them out from inside the app: deletion was
one record at a time, so they deleted the collection directly in the Firebase console.

Two distinct needs came out of that:

1. **Old records** need to leave the working set without being destroyed outright.
2. **Wrong records** — bad imports, mistaken entries — need bulk removal.

### What actually broke (verified)

The blank screen was **not** a rendering problem. `DashboardPage.jsx:48` already sets
`PAGE_SIZE = 100` and line 108 slices `filtered.slice(page * PAGE_SIZE, ...)`, so at
most 100 rows ever render.

The failure is the **fetch**: `useShipments.js:27` calls `getDocs` on
`organizations/{slug}/shipments` with **no `limit()`**, pulling every document into
React state before any slicing happens. `useDeliveries.js:20` has the same shape
against a separate `deliveries` collection, but `DashboardPage` imports
`useShipments` (line 24) — `deliveries` is not what the user sees.

Archiving shrinks the working set, which mitigates this. It does **not** fix it.
The unbounded fetch is addressed in the deferred pagination work.

## Scope

**In:** archive/restore, archive-by-cutoff, filter-based bulk archive/delete,
permanent delete scoped to archived records, import batch stamping + undo.

**Out (deferred):** server-side pagination, adjustable page size (10–300),
moving search/filters/CSV export server-side. That is a separate subsystem
touching indexes, filters, export and search together, and gets its own spec.

## Data model

Three new fields on each document in `organizations/{slug}/shipments`:

| field | type | meaning |
|---|---|---|
| `archived` | boolean | `false` for live records, `true` for archived |
| `archivedAt` | timestamp | when it was archived; absent when live |
| `archivedBy` | string | uid or display name of the admin who archived it |

Import stamping adds three more, written only by the import path:

| field | type | meaning |
|---|---|---|
| `importId` | string | groups every document created by one import run |
| `importedAt` | timestamp | when that import ran |
| `importFilename` | string | source file, for showing the operator what they are undoing |

A companion record per import run lives at `organizations/{slug}/imports/{importId}`
holding `filename`, `count`, `importedAt`, `importedBy`. It is what the Imports list
renders; it must never be the source of truth for deletion — deletion queries
`where('importId','==',id)` so a partial import still cleans up fully.

### Migration (required, one-time)

Firestore does **not** return documents missing a field for `where('archived','==',false)`.
Existing documents therefore need a one-time backfill stamping `archived: false`.

This is cheap right now because the affected org was just emptied. It must still be
written as a resumable batched job, because other orgs may have data and this is
exactly the kind of thing that must not half-finish.

`ImportPreviewModal.handleImport` (line 11) writes 18 fields today and none of them
is `archived`; it must also start writing `archived: false` so new records are
queryable without a second backfill.

### Index

`firestore.indexes.json` currently has `"indexes": []`. Querying
`where('archived','==',false)` + `orderBy('date','desc')` needs a composite index on
`(archived ASC, date DESC)` for the `shipments` collection group. The archive view
needs the same shape; `archived == true` reuses it.

## Operations

All four are **admin-only**. `isAdmin(orgSlug)` already exists in `firestore.rules`.

### 1. Archive by cutoff
Admin picks a date. UI shows the count that would be affected **before** confirming.
On confirm, everything with `date` older than the cutoff gets `archived: true`.
Reversible: the Archive view offers Restore, which clears the three archive fields.

### 2. Bulk select on current filters
Row checkboxes in `ShipmentTable`, plus a "Select all N matching these filters"
affordance that operates on the whole filtered set rather than the visible page.
Actions: Archive, or Delete.

This is the mechanism for **wrong records that already exist**, since they can be
isolated with the existing date/status/search filters.

### 3. Permanent delete
Reachable **only from the Archive view**. Destroying records is therefore always a
two-step journey — archive first, then delete — and is never one click away from the
live list. Requires typed confirmation showing the exact count.

### 4. Undo import
The Imports list shows recent import runs with filename, count and timestamp.
"Undo this import" deletes exactly the documents carrying that `importId`.

**Limitation, stated plainly:** this only works for imports made *after* this ships.
Nothing distinguishes previously-imported documents. Pre-existing mistakes must use
operation 2.

## Where the work runs

**Not in the browser.** Firestore caps `writeBatch` at 500 operations, and a tab
closed mid-run leaves the job half-applied — which is how the original incident ended
with hand-deletion in the console.

Each operation is an **admin-only callable Cloud Function** that walks a cursor in
chunks of 500, and returns `{ processed, remaining, done, cursor }` so the client can
show progress and resume. Calling a job twice must be safe: archiving an
already-archived document is a no-op, and deleting an already-deleted one is ignored.

Callables (in `functions/`, re-exported from `functions/index.js` following the
existing bottom-of-file pattern):

- `archiveShipments({ slug, mode, cutoffDate?, ids?, filter?, cursor? })`
- `restoreShipments({ slug, ids?, cursor? })`
- `deleteArchivedShipments({ slug, ids?, cursor?, confirmCount })`
- `undoImport({ slug, importId, cursor? })`

`confirmCount` on the delete path must match the server's own count of what it is
about to delete; a mismatch aborts. This stops a stale browser tab from deleting a
set that grew since the confirmation dialog was rendered.

Every operation writes an audit entry through the existing audit-log path so a bulk
destruction is always attributable.

## Security

- Every callable calls the existing admin guard; a non-admin gets `permission-denied`.
- `firestore.rules` must **not** be loosened to permit client-side bulk writes. The
  callables run with Admin SDK privileges precisely so the rules stay tight.
- Responses carry counts and status only — never patient data.

## Testing

- Unit tests per callable: admin guard rejects non-admins; chunking handles a set
  larger than 500; re-running a completed job is a no-op; `confirmCount` mismatch
  aborts without deleting; `undoImport` deletes only the matching `importId`.
- A seam test asserting the composite index entry exists in `firestore.indexes.json`,
  mirroring the existing rules-text assertions in
  `functions/__tests__/platform-audit-rules.test.js`.
- Client tests: the dashboard query filters archived records out; the Archive view
  shows only archived; permanent delete is not reachable from the live list.
- Tests must challenge the code — no assertions that merely restate the implementation.

## Phasing

1. Data model + backfill + index + import stamping (`archived: false` on create).
2. Archive/restore callables + Archive view + archive-by-cutoff.
3. Bulk select on filters + permanent delete from the Archive view.
4. Imports list + undo import.

Each phase ships and verifies independently.

## Deferred

Server-side pagination with adjustable page size (10–300, default 100). Chosen
approach: Firestore `limit` + `startAfter` cursors, with search moving server-side as
exact `trackingNumber`/Rx lookup plus a normalized name prefix match. That requires
its own backfill (a normalized search field) and its own indexes, and it breaks the
current in-memory search/filter/CSV behaviour unless all three move together.
Own spec, own plan.
