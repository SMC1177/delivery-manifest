# Delivery Manifest V2 — Feature File Map

**App**: Prescription Delivery Tracker (Multi-tenant Pharmacy Shipment Management)
**Stack**: React 19 + Vite 8, Firebase (Auth, Firestore, Storage), React Router 7, Tailwind CSS 4
**Architecture**: Organization-scoped data with RBAC (admin, manager, staff, viewer)

---

## Authentication & Authorization

- **`src/contexts/AuthContext.jsx`** — Core auth provider. Email/password, Google OAuth, Microsoft OAuth, TOTP MFA. Manages `user`, `userData`, `orgSlug`, `loading`. Key methods: `login()`, `completeMfaLogin()`, `register()`, `signInWithGoogle()`, `signInWithMicrosoft()`, `createOrganization()`, `joinOrganization()`, `updateMfaStatus()`, `dismissWelcome()`, `reloadUser()`, `logout()`
- **`src/components/ProtectedRoute.jsx`** — Route guard. Checks: authenticated, emailVerified, orgSlug loaded, welcomeDismissed. Redirects to `/login`, `/verify-email`, `/setup`, or `/:slug/welcome` as needed
- **`src/lib/rateLimit.js`** — Login brute-force protection. `checkRateLimit(email)`, `recordFailedAttempt(email)`, `clearLoginAttempts(email)`. Max 5 fails, 15-min lockout. Firestore: `loginAttempts/{emailHash}`
- **`src/lib/password.js`** — Password validation + strength scoring. `validatePassword(password)` → error array. `getPasswordStrength(password)` → `{ score, label, color }`. Requirements: 8+ chars, uppercase, lowercase, number

## Pages

- **`src/pages/LandingPage.jsx`** — Route: `/`. Public marketing page. Redirects authenticated users to dashboard
- **`src/pages/LoginPage.jsx`** — Route: `/login`. Email/password + OAuth login. MFA code entry. Rate limiting integration
- **`src/pages/RegisterPage.jsx`** — Route: `/register`. Registration with password strength meter. OAuth buttons
- **`src/pages/VerifyEmailPage.jsx`** — Route: `/verify-email`. 3-second polling via `reloadUser()`. Resend with 60s cooldown
- **`src/pages/SetupPage.jsx`** — Route: `/setup`. 3-step wizard: org name → slug (availability check) → TOTP 2FA setup (optional). Creates `organizations/{slug}` doc
- **`src/pages/WelcomePage.jsx`** — Route: `/:slug/welcome`. Post-setup welcome with optional 2FA. `dismissWelcome()` on complete
- **`src/pages/JoinPage.jsx`** — Route: `/:slug/join?code=`. Invite redemption. Validates code, expiration, usage limits. Register + join or join existing
- **`src/pages/DashboardPage.jsx`** — Route: `/:slug/dashboard`. Main shipment management. CRUD, status filter, date range, text search, CSV export, batch tracking refresh via Cloud Functions
- **`src/pages/ImportPage.jsx`** — Route: `/:slug/import`. Excel file import. Parses .xlsx/.xls via `parseExcelFile()`, dedup against existing tracking numbers, opens `ImportModal` with preview
- **`src/pages/SettingsPage.jsx`** — Route: `/:slug/settings`. Admin-only. Sections: branding (logo upload), field visibility toggles, team management, invite codes, 2FA setup, HIPAA data scrubbing, audit log viewer

## Shipment Management

- **`src/hooks/useShipments.js`** — Primary data hook. Real-time Firestore listener on `organizations/{orgSlug}/shipments`. Exports: `useShipments(orgSlug)` → `{ shipments, loading, error, addShipment, updateShipment, removeShipment }`. Also exports `getCentralTimeDateString()`, `formatCentralTime()`. `addShipment()` has 4-tier duplicate detection: (1) same tracking + same Rx → skip, (2) same tracking + new Rx → merge via `arrayUnion`, (3) same patient + all Rx already exist → skip (catches re-imports without date), (4) same date + overlapping Rx → soft warning
- **`src/hooks/useDeliveries.js`** — Delivery CRUD hook. `useDeliveries()` → `{ deliveries, loading, error, addDelivery, updateDelivery, removeDelivery }`
- **`src/components/ShipmentTable.jsx`** — Data table with desktop (full table) and mobile (card) views. Dynamic columns via `isFieldEnabled()`. Inline status dropdown. Edit/Delete buttons. **Grouped view:** rows sharing the same tracking number collapse into a single row with "+N" badge and expand/collapse. Primary row shows merged Rx numbers from all grouped entries. Works on both desktop table and mobile cards
- **`src/components/ShipmentModal.jsx`** — Add/edit form modal. Fields: patientName, address, phone, dob, rxNumbers, trackingNumber, carrier, status, notes. Conditional field display via `useOrgSettings()`
- **`src/components/DeliveryTable.jsx`** — Delivery list table/cards. Statuses: pending, out, delivered, failed
- **`src/components/DeliveryModal.jsx`** — Delivery form modal (simpler than ShipmentModal)
- **`src/components/StatusBadge.jsx`** — Color-coded status pill. pending=yellow, shipped=blue, in_transit=indigo, delivered=green, exception=red
- **`src/components/DeleteModal.jsx`** — Confirmation dialog with patient name display

## Excel Import

- **`src/utils/excelImport.js`** — Pure functions for Excel parsing (no Firestore calls). Exports: `parseExcelFile(file, mapping, existingTrackingNumbers)` → `{ shipments, skippedNoTracking, skippedDuplicate, totalRows, preview, unmappedColumns }`. `readExcelHeaders(file)` → `{ headers, sampleRow }`. `autoMapColumns(headers)` fuzzy-maps Excel columns to universal fields. `applyMapping(rows, mapping)` transforms rows using saved mapping. `normalizeDate(value)` handles Excel serials, MM/DD/YYYY, YYYY-MM-DD, Date objects. `detectCarrierFromTracking(tn)` infers carrier. `concatenateAddress(row, cols)` joins multi-column addresses. Uses SheetJS (`xlsx` package)
- **`src/components/ImportModal.jsx`** — Preview + confirm UI. Shows row counts, skip reasons, first 5 rows. Batch writes in 500-doc chunks via `addDoc()`. Success toast on complete

## Organization Management

- **`src/hooks/useOrganization.js`** — Org data + team management. `useOrganization()` → `{ org, members, loading, isAdmin, addMember, updateMemberRole, removeMember, updateOrgSettings }`. Firestore: `organizations/{slug}`, `organizations/{slug}/members/{uid}`
- **`src/hooks/useOrgSettings.js`** — Field visibility subscription. `useOrgSettings()` → `{ settings, enabledFields, isFieldEnabled, loading }`. Default enabled: `['notes', 'carrier']`
- **`src/hooks/useInvites.js`** — Invite code management. `useInvites(orgSlug)` → `{ createInvite, deleteInvite }`. Also exports `findInviteByCode()`, `redeemInvite()`. 8-char alphanumeric codes, maxUses, expiration. Firestore: `organizations/{slug}/invites`

## Audit & Compliance

- **`src/hooks/useAuditLog.js`** — `useAuditLog(orgSlug)` → `{ logAction }`. `useAuditLogEntries(orgSlug, max)` → real-time array. Records action, userId, userName, targetId, details, timestamp, IP. Firestore: `organizations/{slug}/auditLog`
- **`src/lib/scrubField.js`** — HIPAA data deletion. `scrubFieldFromShipments(orgSlug, fieldKey)` batch-deletes a field from all shipments (500-doc Firestore batches). `CORE_FIELDS` (never scrub), `SCRUBBABLE_FIELDS` (address, phone, dob, notes, redeliver)
- **`src/components/ScrubConfirmModal.jsx`** — Deletion confirmation with field name, affected count, "cannot be undone" warning

## Tracking Integration

- **`src/lib/carriers.js`** — Carrier utilities. `getTrackingUrl(carrier, tn)`, `getCarrierName(carrier)`, `detectCarrier(tn)` (1Z→ups, 9+20digits→usps, 12/15digits→fedex), `CARRIER_OPTIONS` array
- **`src/hooks/useFedExTracking.js`** — FedEx Cloud Function wrapper. `fetchTracking(tn)` via `httpsCallable`
- **`src/hooks/useUpsTracking.js`** — UPS Cloud Function wrapper. `fetchTracking(tn)` via `httpsCallable`

## Cloud Functions (`functions/index.js`)

- **`scheduledFedExSync`** — Scheduled daily at 7 AM CT. 540s timeout, 1GiB memory. Dedupes tracking numbers across all docs (multiple Rx on same tracking = 1 poll). Batches 30 per FedEx API call, 5 batches in parallel. Firestore writes batched 500/commit. Defaults to production FedEx API (`apis.fedex.com`); set `FEDEX_MODE=sandbox` to override
- **`scheduledUpsStatusSync`** — Scheduled daily at 7 AM CT. 540s timeout, 1GiB memory. Dedupes tracking numbers. 3 concurrent UPS API calls with 200ms delay. Firestore writes batched 500/commit. Defaults to sandbox UPS API; set `UPS_MODE=production` to override
- **`trackFedEx`** / **`trackUps`** — On-demand single tracking number lookup (callable from frontend)
- **`refreshFedExStatuses`** / **`refreshUpsStatuses`** — Manual full-org refresh (callable from frontend)
- **`syncFedExForOrg(orgSlug)`** — Core FedEx sync logic. Groups docs by tracking number, polls unique TNs only, applies results to all matching docs
- **`syncUpsForOrg(orgSlug)`** — Core UPS sync logic. Same dedup pattern, sequential with parallelism of 3

## Session & Security

- **`src/hooks/useSessionTimeout.js`** — Activity-based timeout (30min default, 5min warning). Tracks mousedown, keydown, scroll, touchstart. `useSessionTimeout(timeoutMs, warningMs)` → `{ showWarning, remainingSeconds, dismissWarning }`
- **`src/components/SessionWarningModal.jsx`** — Countdown modal (MM:SS). Stay Signed In / Sign Out buttons
- **`src/components/TotpSetup.jsx`** — 2FA enrollment component. Re-auth → generate TOTP secret → QR code → verify 6-digit code → enroll. Uses Firebase multiFactor API + `qrcode` library

## Layout & UI

- **`src/components/Layout.jsx`** — App shell. Header with user info + logout. Nav tabs: Dashboard, Import, Settings. Session timeout integration. Mobile responsive
- **`src/components/Toast.jsx`** — `ToastProvider` + `useToast()` → `addToast(message, type)`. Types: success (green), error (red), info (blue). Auto-dismiss 3s
- **`src/main.jsx`** — React entry point. Renders `<App />` in StrictMode
- **`src/App.jsx`** — Root component with React Router v7. Public + protected route structure. `AuthProvider` + `ToastProvider` wrappers
- **`src/index.css`** — Tailwind CSS + custom animations

## Firebase

- **`src/lib/firebase.js`** — Firebase SDK init. Exports: `auth`, `db`, `storage`. Project: `delivery-manifest-c3deb`

## Firestore Collections

| Collection | Description |
|------------|-------------|
| `organizations/{slug}` | Org metadata (name, owner, logo, settings, enabledFields) |
| `organizations/{slug}/shipments` | Shipment records |
| `organizations/{slug}/deliveries` | Delivery records |
| `organizations/{slug}/members/{uid}` | Membership with role |
| `organizations/{slug}/invites` | Invite codes |
| `organizations/{slug}/auditLog` | Activity audit trail |
| `userProfiles/{uid}` | User metadata (name, email, orgSlug, mfaEnabled) |
| `loginAttempts/{emailHash}` | Rate limiting |

## Test Suite

### Unit Tests (Vitest)
- **`src/__tests__/excelImport.test.js`** — Excel import parsing (22 tests). Date normalization, carrier detection, column mapping, Rx splitting, dedup logic
- **`src/__tests__/useShipments.test.js`** — 4-tier duplicate detection tests (tracking skip, Rx merge, patient+Rx dedup, date+Rx warning)
- **`src/__tests__/useDeliveries.test.js`** — Delivery hook tests
- **`src/__tests__/ShipmentModal.test.jsx`** — Form modal tests
- **`src/__tests__/ShipmentTable.test.jsx`** — Table rendering tests + tracking number grouping tests (expand/collapse, merged Rx, badge counts)
- **`src/__tests__/DashboardStatusCounts.test.jsx`** — Status count tests
- **`src/__tests__/AuthContext.test.jsx`** — Auth flow tests
- **`src/__tests__/carriers.test.js`** — Carrier detection tests
- **`src/__tests__/scrubField.test.js`** — Data scrubbing tests
- **`src/__tests__/trackingGrouping.test.jsx`** — Tracking number grouping (7 tests). Group by tracking, merged Rx display, dedup in merge, case-insensitive keys, badge counts, standalone rows
- **`src/__tests__/rxDedup.test.js`** — Rx-based dedup tier 3 (6 tests). Same patient + same Rx skip, subset skip, different Rx pass-through, different patient pass-through, no-tracking re-import, empty Rx bypass
- **`src/__tests__/seamTests.dedupAndGrouping.test.js`** — Seam tests (20 tests). 4-tier dedup ordering, grouping code structure, Cloud Functions polling dedup, tier interaction behavior (merge stops before tier 3, tier 3 catches re-imports, all tiers pass → create)

### E2E Tests (Playwright)
- **`e2e/smoke.spec.js`** — Landing page loads, login fields render, 404 handling
- **`e2e/import.spec.js`** — Import page renders, Phase 2 stub removed, file input validation
- **`e2e/shipments.spec.js`** — Dashboard route auth gate, no JS errors
- **`e2e/auth-flow.spec.js`** — (stub — needs test account)

### Scripts
```bash
pnpm test              # Vitest unit tests
pnpm test:watch        # Vitest watch mode
pnpm test:coverage     # Vitest with coverage
pnpm e2e               # Playwright E2E (headless)
pnpm e2e:headed        # Playwright E2E (visible browser)
pnpm e2e:ui            # Playwright interactive UI
pnpm deploy            # Tests → Build → Firebase deploy (gated)
```
