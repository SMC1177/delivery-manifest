# RingCentral Setup for a Pharmacy

**Last updated:** 2026-08-04
**Scopes and permission names verified** against RingCentral's permissions guide. Console wording may drift — follow the on-screen prompts where they differ.

---

## The decision: each pharmacy registers its own app

Every pharmacy creates **its own RingCentral app** under **its own RingCentral account**.

An earlier version of this document said the second pharmacy should reuse Woodlands' app. That was technically possible but wrong in practice, because the existing app lives in **Woodlands' developer console under Woodlands' account** — it is a customer's app, not a neutral vendor's. Sharing it would mean:

- handing another business Woodlands' Client Secret
- every pharmacy's API call history appearing in Woodlands' console
- all pharmacies losing SMS at once if Woodlands' account ever lapsed or the app were suspended

Independent businesses should not be coupled that way.

### If this becomes a product

If the delivery app is sold to pharmacies generally, the right long-term shape is a **vendor-owned public app** registered under the software company's own RingCentral account. Every pharmacy — Woodlands included — then creates a JWT against that one app, and app registration disappears from onboarding forever.

Open question before choosing that path: **whether a RingCentral developer account with no phone service can host a production app.** If it can, this costs one registration, once. If RingCentral requires an active phone account behind it, it means paying for a seat. Worth asking RingCentral directly.

Until that is answered, per-pharmacy apps are the working default.

---

## What identifies what

Two credential types, constantly confused:

| Credential | Identifies | Scope |
|---|---|---|
| **Client ID + Client Secret** | the **app** | one per pharmacy, under their own account |
| **JWT credential** | the **user and account** | one per pharmacy, created by them |

---

## Part 1 — Create the app

Signed into **developers.ringcentral.com** with **that pharmacy's own** RingCentral credentials.

1. **Create App**
2. **App type:** REST API app — server-side, no user interface
3. **Auth type:** **JWT auth flow** (server-to-server). Not the 3-legged OAuth flow; this app has no user login.
4. **Scopes / permissions — add both:**

   | Permission | Why |
   |---|---|
   | **SMS** | Sending text messages. Also includes `ReadMessages`. |
   | **SubscriptionWebhook** | Creating the webhook subscription that delivers patient YES/STOP replies. |

   Both are required. Without `SMS`, sending fails. Without `SubscriptionWebhook`, webhook registration fails. [verified against RingCentral's permissions guide]

5. **Name and description** — anything descriptive, e.g. "Prescription Delivery Notifications". It is internal to that pharmacy.
6. **Keep it private.** Do **not** submit to the App Gallery. Gallery listing requires screenshots, videos, terms of service and a privacy policy, and is meant for publicly distributed integrations. A private app in production is all that is needed.
7. **Graduate the app to Production.** Sandbox uses a different API host and will not touch real numbers.

Record the **Client ID** and **Client Secret**.

---

## Part 2 — Create the JWT

Still in the developer console, under the same account:

1. Create a **JWT credential**
2. Scope it to the app just created — choose "Only specific apps of my choice" and enter that app's Client ID
3. **Issue it for a user who owns the SMS-capable number.** This is the step that silently breaks everything if it is wrong: a JWT signs in as one specific user, and can only send from numbers that user owns.

Record the **JWT**.

---

## Part 3 — Enter it in the delivery app

That pharmacy's organization → **Settings → Text Messaging → Edit**:

| Field | Value |
|---|---|
| Client ID | theirs |
| Client Secret | theirs |
| JWT credential | theirs |
| Server | `https://platform.ringcentral.com` |
| From Number | theirs, as `+1XXXXXXXXXX` |

Then **Generate Token** → **Register with RingCentral** under Webhook Setup.

Credentials are stored per organization in Secret Manager (`textmsg-rc-creds-{orgSlug}`), so no pharmacy can see another's.

---

## Part 4 — A2P / 10DLC registration (the real blocker)

**This is what actually prevents texting, and it is separate from everything above.** Authentication will succeed, the webhook will register, and sending will still fail until this clears.

In the RingCentral **admin** portal (service.ringcentral.com) → **Phone System → Business SMS → Set up SMS**:

1. Register the **Brand** — the legal business entity, EIN, address, website
2. Register the **Campaign** — use case and message samples
3. **Allocate the number** to the campaign's number pool

Both a green registration status **and** an allocated number are required. Woodlands sat at "Update required" with "Not Allocated" and could not send a single message despite everything else being correct.

**A2P is per phone account and does not inherit.** A separate pharmacy is a separate legal entity with a separate EIN, so it registers its own brand and campaign regardless of which app it uses.

### What the campaign submission asks for

The app's real behaviour answers these well, so use it:

- **Use case:** Customer Care / delivery notifications
- **Opt-in method:** double opt-in — the first message asks the patient to reply YES, and nothing else sends until they do
- **Opt-out:** every message carries "Reply STOP"; STOP is honoured before any other policy check
- **Sample messages:** copy the actual templates from Settings → Text Messaging

Vague answers here are the most common cause of a second "Update required."

---

## Five things that waste the most time

1. **A2P registration is the long pole. Start it first.** Everything else is minutes; this is paperwork and review time.
2. **The From Number must belong to the JWT's user**, or you get `403 MSG-242` — which looks like a credentials problem and is not.
3. **The From Number must be a Digital Line**, not a main or auto-receptionist number. Company numbers cannot send SMS.
4. **All three credential values must be entered together.** The form rejects partial saves by design; you cannot update just the JWT later.
5. **Format as `+1XXXXXXXXXX`.** RingCentral's own UI displays `(936) 877-1167`, but the API needs `+19368771167`.

---

## Diagnosing a failure

The red error text in the app is RingCentral's verbatim response. Read it before changing anything.

| Symptom | Meaning |
|---|---|
| `403 MSG-242 FeatureNotAvailable` on send | Account entitlement. Almost always A2P registration incomplete or the number unallocated. **Not** credentials. |
| `CMN-408` | The app genuinely lacks a permission — check `SMS` and `SubscriptionWebhook`. |
| Token call returns 200 but sending fails | Credentials are fine. Stop re-entering them. |
| Webhook registers but sending fails | Messaging permissions fine; only outbound blocked. Points squarely at A2P. |
| `404 CMN-102` on webhook renewal | The stored subscription belongs to a different app. Re-register the webhook. |

Independent check that needs no code: sign into the RingCentral app as the JWT's user and try to text by hand from that number. If RingCentral's own app cannot send it, nothing in the delivery app will help — and that is evidence for a support ticket.

---

## Corrections log

Kept so the same ground is not re-argued.

- **"Each pharmacy registers its own app"** was stated, then reversed to "share Woodlands' app," now settled as **each registers its own**. The reversal came from confusing *what is technically possible* with *what is the right shape*. Cross-account JWT genuinely works — it is simply the wrong thing to do with a customer's app.
- **Credential storage being per-organization** says nothing about who registers the app. That is a fact about storage only.
- **A2P never inherits.** Not from an app, not from another pharmacy, not from a parent company with a different EIN.
