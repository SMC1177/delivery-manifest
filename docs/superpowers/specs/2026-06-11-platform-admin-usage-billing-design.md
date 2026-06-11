# Platform Admin: Usage Visibility, Settings Remote-Assist, Billing Foundation — Design

> **Created:** 2026-06-11 | **Status:** Approved by Stephen (direction); implementation not started
> **Supersedes/extends:** TASKS.md Task E ("Platform Admin — Cross-Organization Query Dashboard", 2026-03-30, never started)

## Problem

Every query in the app is org-scoped (`organizations/{slug}/...`). There is no way for the platform owner to:

1. See usage across all organizations — shipments submitted per org, broken down by carrier (`ups` / `fedex` / `usps`) — which is the raw input for billing.
2. View or fix any org's settings remotely to support/troubleshoot customers.
3. Bill customers. Pricing will be **negotiated per company** (no public tiers), and monthly amounts fluctuate with shipment volume.

## Decisions already made

- **Support access = Option A**: platform-admin settings editor backed by callables + audit log. **No impersonation** ("log in as user") in this design — it would expose PHI and is deferred unless Option A proves insufficient.
- **Billing philosophy is per-org customizable**: pricing lives in per-org `billingConfig` data, never in code. Actual charging (Stripe) is **deferred**; this design only builds the usage data and the config surface that any future pricing model needs.
- **No PHI at the platform-admin level.** Counts, metadata, and settings only. Patient names, addresses, Rx numbers, phone numbers never appear in admin UI, audit logs, callables' return values, or anything sent to Stripe later.

## Architecture overview

Three pieces, built in this order. Each is independently shippable.

```
[shipment create/delete trigger] ──> organizations/{slug}.monthlyUsage   (Piece 1)
[monthly reconciliation job] ───────┘ (count() aggregate, fixes drift)

/admin/dashboard (platformAdmin only)                                    (Piece 2)
   └─ getOrgUsageSummary (callable, Admin SDK) ──> org list + usage + CSV
   └─ updateOrgBillingConfig (callable) ─────────> organizations/{slug}.billingConfig

Admin settings panel (same dashboard)                                    (Piece 3)
   └─ getOrgSettings / updateOrgSettings (callables, Admin SDK)
        └─ every write ──> platformAudit/{autoId}  (top-level, admin-only)
```

All cross-org reads/writes go through **callable Cloud Functions using the Admin SDK** (bypasses security rules server-side, after verifying the caller's `platformAdmin` flag). Firestore rules for org data stay untouched — no rules-based cross-org access. This matches Task E's original approach.

## Data model

### `userProfiles/{uid}` — new field
- `platformAdmin: true` — grantable **only** via Firestore console or a one-off script. No UI, no callable, no rule that sets it. Absence of the field = not an admin.

### `organizations/{slug}` — new fields
- `shipmentCount: number` — lifetime running total.
- `monthlyUsage: { [YYYY-MM]: { ups: number, fedex: number, usps: number, other: number, total: number } }` — calendar-month buckets keyed by the shipment's `createdAt` in **Central Time** (matches the app's existing `getCentralTimeDateString()` convention). Carrier key is the lowercase `carrier` field; anything unrecognized buckets to `other`.
- `billingConfig: { model: 'flat' | 'per_shipment' | 'hybrid' | 'custom', baseFee: number|null, includedShipments: number|null, perShipmentRate: number|null, perCarrierRates: { [carrier]: number }|null, currency: 'usd', billingStartDate: Timestamp|null, notes: string }` — set per customer from the admin dashboard. Purely descriptive data in this phase; nothing reads it to charge anyone yet.

### `platformAudit/{autoId}` — new top-level collection
- `{ actorUid, actorEmail, action, orgSlug, docPath, before, after, at: serverTimestamp }`
- Written **only** by Cloud Functions (Admin SDK). Firestore rules: `allow read, write: if false;` — nobody reads it from the client, including platformAdmin (read via console or a future callable if ever needed). `before`/`after` are the settings docs being changed, which contain org config — never patient data — with secret fields masked (see Piece 3).

## Piece 1 — Usage counters (the load-bearing foundation)

**Trigger:** extend/parallel the existing `onDocumentCreated('organizations/{orgSlug}/shipments/{shipmentId}')` pattern in `functions/index.js` (the UPS track-alert trigger demonstrates the wiring) with:

- `onDocumentCreated` → `FieldValue.increment(1)` on `shipmentCount`, and increment `monthlyUsage.{YYYY-MM}.{carrier}` + `monthlyUsage.{YYYY-MM}.total` on the org doc.
- `onDocumentDeleted` → matching decrements against the **shipment's original `createdAt` month**, not the current month (a June delete of a May shipment decrements May).
- Increments are atomic (`FieldValue.increment`) — no read-modify-write races.
- Sample data (`isSample: true`) **is counted** like everything else; reconciliation keeps it honest and sample loads are tiny. (Simpler than special-casing, and sample data is normally cleared.)

**Reconciliation job:** `onSchedule` monthly (and callable on demand from the admin dashboard, "Recount" button) — for each org, run Firestore aggregate `count()` queries per carrier for the current and previous month and overwrite the corresponding `monthlyUsage` buckets + recount `shipmentCount`. Counters drift in every counter system (missed trigger executions, manual console edits, the v1→v2 migration script); reconciliation makes the numbers billing-grade. Log a `platformAudit` entry when a reconciliation changes a number, so drift is visible.

**Backfill:** one-time callable/script that builds `monthlyUsage` history for existing orgs from their current shipments (same aggregate queries). Run once at deploy.

**Error handling:** trigger failures are retried by Cloud Functions; reconciliation is the safety net for anything dropped. The trigger must never throw on an unknown/missing carrier — bucket to `other`.

## Piece 2 — Platform admin dashboard

**Frontend (per Task E, unchanged paths):**
- `v2/src/components/AdminProtectedRoute.jsx` — renders children only when `userData/profile.platformAdmin === true`; otherwise redirect to `/`. Client-side gate is UX only — real enforcement is in the callables.
- `v2/src/App.jsx` — add `/admin/dashboard` route (not org-slug-scoped).
- `v2/src/pages/AdminDashboardPage.jsx` — org table: name, slug, member count, created date, lifetime shipments, this-month total, per-carrier columns (ups/fedex/usps/other), status breakdown, `billingConfig` summary. Date-range (month-range) filter. **Export CSV** button (client-side CSV from the callable's JSON; one row per org per month). Per-org expandable panel containing the `billingConfig` editor and the settings remote-assist editor (Piece 3).
- `v2/src/hooks/useAdminData.js` — wraps the callables.
- `v2/src/contexts/AuthContext.jsx` — expose `platformAdmin` from the `userProfiles` snapshot (likely automatic since the whole doc is read — verify).

**Callables (functions/, all begin with the same guard):**
- Guard: `requirePlatformAdmin(request)` — reads `userProfiles/{request.auth.uid}` via Admin SDK, throws `HttpsError('permission-denied')` unless `platformAdmin === true`. Mirrors the existing `requireAdmin` pattern in `functions/sms-webhook-register.js`.
- `getOrgUsageSummary({ months?: [YYYY-MM, YYYY-MM] })` → for all orgs: org metadata, member count (aggregate `count()` on members), `shipmentCount`, requested `monthlyUsage` slices, status breakdown (aggregate `count()` per status, current filter range only). Returns counts + metadata only.
- `updateOrgBillingConfig({ orgSlug, billingConfig })` → validates shape (model enum, numbers ≥ 0 or null), writes to org doc, writes `platformAudit` entry.

**Firestore rules:** no changes for org data. Add `platformAudit` rule block (`read, write: if false`). `userProfiles` rules must not allow a user to set their own `platformAdmin` field — verify the existing userProfiles write rule restricts updatable keys; if it doesn't, add an explicit guard that `platformAdmin` in the request payload is rejected unless unchanged.

## Piece 3 — Settings remote-assist (Option A)

**Callables:**
- `getOrgSettings({ orgSlug })` → returns the org doc's settings-relevant fields (`settings`, `enabledFields`, name/logo) plus all docs under `organizations/{orgSlug}/settings/*`. **Secret masking:** fields matching a denylist (`clientSecret`, `jwt`, `token`, `password`, `apiKey`, `webhookToken`, RingCentral creds — maintained as a shared `SECRET_FIELD_PATTERNS` list in `functions/lib/`) are replaced with `'•••set'` / `null` markers indicating presence, never values.
- `updateOrgSettings({ orgSlug, docPath, updates })` → `docPath` must match an allowlist of settings locations (`organizations/{slug}` settings fields, `organizations/{slug}/settings/{doc}`) — reject anything touching `shipments`, `deliveries`, `members`, `smsContacts`, or any path containing patient data. Masked-secret markers in `updates` are stripped (you can't accidentally overwrite a stored secret with the mask string); explicitly supplying a new secret value is allowed (that's the support use case: re-entering credentials for a customer). Writes a `platformAudit` entry with `before`/`after` **after masking secrets in both**.

**Frontend:** settings panel inside the per-org expandable section of `AdminDashboardPage` — renders the settings docs as editable JSON/form, with a required free-text "reason" field per save that is stored in the audit entry. (Matches the house rule: every change needs a WHY.)

**What this deliberately cannot do:** read or edit shipments/patients, read secret values, act as the customer in their UI. If a support case ever truly needs to see the customer's screen state, that's the deferred impersonation feature (consent toggle + expiry + banner) — out of scope here.

## Billing (deferred — direction only, no implementation in this design)

When the first paying customer is priced: a monthly `onSchedule` function reads each org's `monthlyUsage[lastMonth]` + `billingConfig`, computes line items (e.g. base fee, per-carrier shipment charges minus included volume), and creates a **Stripe Invoice** per org (`stripeCustomerId` to be added to the org doc then). Stripe Invoicing fits negotiated per-customer pricing with fluctuating amounts without subscription/tier machinery; if pricing later standardizes, graduate to Stripe Billing Meters reusing the same `monthlyUsage` pipeline. Only business data goes to Stripe (org name, slug, counts — Stripe will not sign a BAA). Until then, Piece 2's CSV export is the manual invoicing source.

## Testing

- **Unit (functions):** counter trigger math (create/delete, cross-month delete, unknown carrier → `other`); `requirePlatformAdmin` rejects non-admin/anon; `getOrgSettings` masks every pattern in `SECRET_FIELD_PATTERNS`; `updateOrgSettings` rejects non-allowlisted paths and strips mask markers; audit entries written with masked before/after; reconciliation overwrites a deliberately-drifted counter. Follow the existing mock-Firestore style in `functions/__tests__/` (e.g. `sms-orchestration.test.js`).
- **Unit (frontend):** `AdminProtectedRoute` redirect behavior; `AdminDashboardPage` renders org rows from mocked hook; CSV export shape; billingConfig editor validation.
- **Seam:** a test asserting the `docPath` allowlist and `SECRET_FIELD_PATTERNS` are imported by both `getOrgSettings` and `updateOrgSettings` from the single shared module (no divergent copies).
- **Rules:** extend the Firestore-rules tests (if a harness exists; otherwise note as gap) asserting a non-admin cannot read `platformAudit` and cannot write `platformAdmin` on their own profile.
- **Known limitation:** unit tests mock Firestore and will not catch index requirements (see 2026-05-26 incident); reconciliation's aggregate queries need no composite indexes [inferred — verify at implementation], but any new `where` + `orderBy` combos must be checked against `firestore.indexes.json` with both scopes.

## Phasing / build order

1. **Piece 1** — counters trigger + reconciliation + backfill. Ship alone; data accrues immediately.
2. **Piece 2** — platformAdmin flag, dashboard, `getOrgUsageSummary`, billingConfig editor, CSV.
3. **Piece 3** — settings callables + audit log + panel.
4. *(Later, separate design)* Stripe invoicing.

Each phase = its own edit-timeline session against the delivery-manifest repo, subagent-implemented per house rules.

## Open items

- Verify `userProfiles` write rules can't set `platformAdmin` (check during Piece 2; add guard if needed).
- Decide whether `platformAudit` ever gets a read UI (not needed now; console suffices).
- Backfill of historical months: how far back? (Default: all history — cheap at current volume.)
