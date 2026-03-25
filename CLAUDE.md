# CLAUDE.md — Delivery Manifest Project Rules

## Project Overview
Pharmacy prescription delivery tracking app. React + Vite + Firebase (Auth, Firestore, Cloud Functions).
- **Frontend:** `v2/` — React 19, Vite, Tailwind CSS v4, React Router v7
- **Backend:** `functions/` — Firebase Cloud Functions v2 (Node 22, ESM)
- **Firebase project:** `delivery-manifest-c3deb`
- **Org slug in use:** `woodlandsrx`

## Commands
- **Dev server:** `cd v2 && pnpm dev`
- **Build:** `cd v2 && pnpm build`
- **Unit tests:** `cd v2 && pnpm test`
- **E2E tests:** `cd v2 && pnpm e2e`
- **Lint:** `cd v2 && pnpm lint`
- **Functions tests:** `cd functions && pnpm test`
- **Deploy hosting:** `npx firebase-tools deploy --only hosting` (from repo root)
- **Deploy functions:** `npx firebase-tools deploy --only functions` (from repo root)

## Test-First Rule (MANDATORY)
- Before changing ANY logic, verify existing tests pass
- Write tests FIRST for new behavior before implementing
- Never modify existing test assertions to make them pass — fix the code instead
- After your changes, run the full test suite and compare to baseline

## Seam Test Rule (MANDATORY)
When touching shared resources (Firestore listeners, Firebase Auth state, carrier API clients):
- Write "don't clobber" tests proving other consumers still work after your code runs
- Write lifecycle sequence tests simulating module A → module B → assert final state
- If async operations touch shared state, write race condition tests

## Code Safety Rule
- Never delete or modify production data
- Never change Firestore security rules without review
- Never expose API keys or secrets in client-side code
- All carrier API calls go through Cloud Functions (server-side only)

## Architecture
- **Auth:** Firebase Auth with Google Sign-In, email/password, TOTP MFA
- **Data:** Firestore — `organizations/{slug}/shipments`, `organizations/{slug}/members`
- **Carrier tracking:** Cloud Functions call FedEx/UPS APIs, store status in shipment docs
- **Scheduled sync:** Cloud Scheduler triggers `scheduledFedExSync` and `scheduledUpsSync` 4x/day
- **Carrier field:** lowercase only (`ups`, `fedex`). Old data had uppercase — app handles both via case-insensitive matching in `lib/carriers.js`

## Known Gotchas
- Old shipment records have `carrier: "UPS"` (uppercase) — `getTrackingUrl()` and `getCarrierName()` normalize to lowercase
- Two org slugs exist: `woodlandsrx` (active, 210 records) and `woodlands-pm` (migration artifact, can be cleaned up)
- V1 data lives at `artifacts/delivery-manifest-c3deb/public/data/manifest` — do not modify
- `scheduledUpsSync` Cloud Run service has a name conflict — needs manual cleanup in GCP console
