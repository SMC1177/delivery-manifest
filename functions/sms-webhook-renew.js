import { onSchedule } from 'firebase-functions/v2/scheduler'
import { getFirestore } from 'firebase-admin/firestore'
import { getRingCentralCredsForOrg } from './lib/rcCredentials.js'
import { getAccessToken } from './ringcentral-auth.js'

export const renewRcWebhooks = onSchedule('every 12 hours', async () => {
  const firestore = getFirestore()

  // Find all orgs with active webhook subscriptions
  // We query the textMessaging settings across all orgs via collection group
  // Since settings are a named doc (not a collection), we must query org by org.
  // Instead, store a top-level registry for efficiency.
  // For v1 with few orgs: scan organizations collection and check each settings doc.
  const orgsSnap = await firestore.collection('organizations').get()

  for (const orgDoc of orgsSnap.docs) {
    const orgSlug = orgDoc.id
    const settingsRef = firestore.doc(`organizations/${orgSlug}/settings/textMessaging`)
    const settingsSnap = await settingsRef.get()
    if (!settingsSnap.exists) continue

    const settings = settingsSnap.data()
    if (!settings.enabled || !settings.webhookSubscriptionId || !settings.credsConfigured) continue

    try {
      const creds = await getRingCentralCredsForOrg(orgSlug)
      const token = await getAccessToken(creds)

      const res = await fetch(`${creds.server}/restapi/v1.0/subscription/${settings.webhookSubscriptionId}/renew`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      })

      if (!res.ok) {
        // Subscription is gone — clear it so UI shows "Not registered"
        console.error(`[renewRcWebhooks] renew failed for ${orgSlug}: ${res.status}`)
        await settingsRef.set({
          webhookSubscriptionId: null,
          webhookExpiresAt: null,
        }, { merge: true })
        continue
      }

      const data = await res.json()
      const expiresAt = new Date(data.expirationTime || Date.now() + 604800000)
      await settingsRef.set({ webhookExpiresAt: expiresAt }, { merge: true })
      console.log(`[renewRcWebhooks] renewed webhook for ${orgSlug}, expires ${expiresAt.toISOString()}`)
    } catch (e) {
      console.error(`[renewRcWebhooks] error for ${orgSlug}:`, e.message)
      // Non-fatal — try again next run
    }
  }
})
