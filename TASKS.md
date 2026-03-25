# TASKS.md — Claude Code Task Queue

Read CLAUDE.md first for project conventions. Use TodoWrite to update checkboxes.

---

## Completed

- [x] Comprehensive Test Suite + Playwright E2E Setup (116 tests — 48 unit, 65 functions, 3 e2e)
- [x] Case-insensitive carrier matching in carriers.js
- [x] Sort shipments by date instead of createdAt

---

## Pending

- [x] Commit all current changes — new test files, Playwright config, CLAUDE.md, carriers.js fix, useShipments sort fix, firebase.json hosting change. Single commit: "v2: deploy + test suite + carrier fixes + migration scripts"

- [x] Clean up stale `scheduledUpsSync` Cloud Run service conflict — the function deploy fails with HTTP 409 because a Cloud Run service with this name already exists. Either delete the old Cloud Run service via `gcloud run services delete scheduledupssync --region us-central1` or rename the function. Note: gcloud CLI is not installed, may need to use Firebase console or install gcloud first. **Done:** Renamed function to `scheduledUpsStatusSync` to avoid the 409 conflict with the orphaned Cloud Run service.

- [x] Add USPS carrier support — currently only UPS and FedEx are in `v2/src/lib/carriers.js`. Add USPS with tracking URL `https://tools.usps.com/go/TrackConfirmAction?tLabels={trackingNumber}`. Update `functions/index.js` to detect USPS tracking numbers (starts with 9, 20-22 digits) and add scheduled sync if USPS has an API. Also add carrier option to ShipmentModal. Tests required: carrier detection, tracking URL generation, case insensitivity.

- [x] Date range filter default — change from "Last 14 days" to "Last 30 days" in DashboardPage.jsx. The 14-day default causes confusion when older shipments seem missing.

- [x] Add "All" button to status filter that shows count — currently the "All" tab doesn't show how many total shipments there are. Add a count badge like "All (210)".

- [ ] Data scrub feature for disabled fields — HIPAA minimum necessary compliance. When a field is disabled in Settings → Shipment Fields, show a "Scrub data" button next to it. Clicking it opens a confirmation modal: "This will permanently delete [Field Name] from all X shipments in your organization. This cannot be undone." On confirm, run a Firestore batch update setting that field to null/deleted on every shipment in `organizations/{slug}/shipments`. Log the action to audit log: `settings.field_scrubbed` with field name and record count. Implementation details:
  - File: `v2/src/pages/SettingsPage.jsx` — add scrub button next to each disabled field toggle in the Shipment Fields section
  - File: `v2/src/components/DeleteModal.jsx` or new `ScrubConfirmModal.jsx` — reuse or create confirmation dialog
  - File: `v2/src/hooks/useOrgSettings.js` or new utility — add `scrubFieldFromShipments(orgSlug, fieldKey)` function that queries all shipments and batch-updates the field to `deleteField()` (Firestore field deletion, not just null)
  - Use `writeBatch` with max 500 docs per batch (Firestore limit). If >500 shipments, split into multiple batches.
  - After scrub completes, show toast: "Scrubbed [Field Name] from X shipments"
  - Fields eligible for scrub: address, phone, dob, notes, redeliver (NOT core fields like patientName, trackingNumber, rxNumbers, date, status, carrier)
  - Tests required: (1) scrub sets field to deleted on all shipments, (2) scrub respects 500-doc batch limit, (3) scrub logs to audit log, (4) core fields cannot be scrubbed, (5) scrub button only appears for disabled fields
