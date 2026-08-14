The SMS idempotency ledger in `functions/lib/smsLedger.js` writes one claim document per tracking-number-and-template pair, each carrying an `expiresAt` timestamp with a 90-day default. The code half is done and tested: an expired claim is treated as absent, so it stops blocking sends. The other half is a Firestore TTL policy that actually deletes expired documents — and that half cannot be expressed in this repository at all.

## TTL policy

A Firestore TTL policy applies to a FIELD and is set through gcloud or the console. This was established by direct check on the development machine: `firebase-tools` 15.1.0 exposes no field-TTL command anywhere in its firestore command set, `gcloud` is not installed, and no TTL configuration exists in any of the repository's JSON files. Setting the policy is therefore an operational action performed outside this repo.

The danger this document exists to counter is that the step is invisible: no deploy applies it, no test fails without it, and no CI check goes red. The system keeps working and simply accumulates ledger documents forever — roughly 200 new rows per day per organization against an export already holding 8,616 distinct tracking numbers.

| Measure | Value |
| --- | --- |
| New ledger rows per day per organization | ~200 |
| Distinct tracking numbers in the current export | 8,616 |

> **Warning:** A comment in the code would not be found; a runbook section will be. Until the TTL policy is created and applied, no expired document is ever deleted even though the code already treats expired claims as absent. The exact invocation — command line, project id, database, collection-group path — is deliberately left to whoever runs it; record what you actually used here when you do.
