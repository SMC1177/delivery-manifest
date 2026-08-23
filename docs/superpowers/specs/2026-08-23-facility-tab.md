# SPEC — the Facility tab

**Date:** 2026-08-23 · **Status:** READY TO IMPLEMENT · **Origin:** operator + customer (Charlie)
iMessage design session, 2026-08-23 ~14:21–14:27, captured verbatim below. Seat counsel: seq
pending at authoring time; ruling recorded in the session that implements this.

## Why this exists

The customer runs deliveries for ~44 facilities and has no per-facility view. On 2026-08-20 the
operator said *"I need to make a facility tab"*; on 2026-08-23 the customer specified it. The
data is ready — measured the same day, not assumed.

## The customer's design (his words)

> "Yeah a tab will work. Under facility tab, patient name address DOB tracking number RX number
> (for that facility). Anything labeled 'refill….' In the column heading for each specific
> patient. I think that will work for now."

> "I'd say all of the things mentioned above in a side view list, just like the dashboard looks."
> "Almost like a dashboard for facility view with the columns mentioned above."
> "And possibly just sorted alphabetically by Alpha patient's last name."

Operator: *"the initial search in facility will be the dropdown bar (or search) with facility
names. Once alpha is selected with your date range it will show exactly as it currently does on
shipments… with your select fields."* Customer: **"Yes exactly."**

Operator: *"How about i add a selection tool that lets you add up to 10 or so columns. Adding
one or taking away one requires coding and it's permanent."* Customer: **"Yeah that will work."**
Operator: *"And i will make it sticky (or try to) maybe a save button for favorites."*

## Measured facts this spec stands on (probed 2026-08-23, not inherited)

- **28,257 shipments**, pharmacy dates spanning **2024-01-29 → 2026-08-20** — real history,
  backlog uploaded 2026-08-20..22 (6,850 / 7,307 / 14,100 per day). Not duplicates: 97% unique
  on the settled identity key; the 3% residue sits in rows with blank/placeholder identity
  fields (incl. 35 fully blank junk rows that also lack facilityName).
- **`facilityName` is 100% populated** (28,222/28,257) with **exactly 44 distinct values** —
  clean codes: TRI-OOC (4,630), TRI-HILT (4,149), TRI-MISI, TRI-TVPM, TRI-ORTHO SP, …
- **Refill columns:** `refillNumber`, `refillsAuthorized`, `refillsRemaining` ≈100%;
  `refillDate` 45% (legitimately sparse — render blank, do not treat as an error).
- **`patientNameLower` is lastname-first** ("mccormick, david") — sorting on it IS the
  customer's "alphabetical by last name". No name parsing needed.
- **The Aug 19 facilityKey ruling is superseded** in its derivation half: it assumed
  facilityName was empty (0/20,890 then); it is 100% now. Its *enumeration* half (avoid full
  scans; precompute the facility list) survives and is enforced here.

## Hard constraints

1. **Bounded queries only.** The dashboard's load-everything path (S4) is at 28k rows and
   growing ~7k/week; this tab must never inherit it. Server-side:
   `where('archived','==',false)` + `where('facilityName','==',<selected>)` + date range on
   `date` + `orderBy('date','desc')` + `limit`. No unbounded `getDocs` anywhere in the tab.
2. **The composite index ships in `firestore.indexes.json`**, shape
   `[archived ASC, facilityName ASC, date DESC]` (collection `shipments`), and **deploys
   before the hosting bundle**. A CREATING index fails exactly like a missing one — poll to
   READY before the UI that needs it goes live. Console-added indexes get pruned; file or
   nowhere.
3. **No new source-of-truth duplication.** `facilityName` stays import-owned and untouched.
   The dropdown's facility list lives in ONE place (per the seat's enumeration ruling in the
   implementing session).
4. **Sort:** Firestore forbids `orderBy(patientNameLower)` alongside a `date` range filter.
   Query bounded by facility + date window; sort by `patientNameLower` client-side within the
   bounded result. The result set is per-facility per-window (hundreds, not tens of thousands).
5. **Column selector** draws from the existing shipment field registry (`shipmentFieldRegistry`
   — every imported column is already a displayable entry), caps at 10, defaults to the
   customer's named set: patientName, address, dob, trackingNumber, rxNumbers, refillNumber,
   refillsAuthorized, refillsRemaining (+refillDate). Persistence per the seat's MVP ruling.
6. **The 35 blank junk rows** (no identity, no facility) are excluded by construction — they
   have no facilityName, so no facility query returns them. Do not build cleanup into the tab.

## Slices

1. **Index + enumeration RED-first** — disk test asserting the composite index entry exists in
   `firestore.indexes.json` (the failure no unit test can see, per the index-compat idiom);
   the facility-list mechanism per seat ruling, with one-time backfill for the existing 44.
2. **`useFacilityShipments` hook** — bounded query, RED-first against a firestore mock in the
   `useShipments.test` idiom; premise guard proving the limit and both filters are actually in
   the query.
3. **FacilityPage UI** — dropdown + date range + ShipmentTable-style list + column selector;
   route + nav wiring last, so a half-built page is never reachable.
4. **Deploy:** indexes → poll READY → hosting.

## What NOT to do

- Do not compute the facility list by scanning shipments at read time — that is the blank-screen
  bug's shape, re-shipped.
- Do not parse or normalise facility names; 44 clean codes exist. Render what is stored.
- Do not add facility editing/merging UI — the tab is a *view*, per the customer's design.
- Do not touch `useShipments`' existing dashboard path in this build (S4 is its own work; this
  tab must simply not make S4 worse).
- Do not treat `refillDate` blanks as missing data — 45% is the source's real shape.
