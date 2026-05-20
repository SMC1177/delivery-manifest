import { useState, useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { normalizePhone } from '../lib/phoneNormalize'

/**
 * Subscribe to organizations/{slug}/smsContacts/{phone}.
 * Returns { contact, loading, derivedState } where derivedState is one of:
 *   'unknown' (never asked), 'pending' (invited, no reply),
 *   'opted_in', 'opted_out', 'no_phone' (phone arg empty/invalid).
 */
export function useSmsContact(slug, phoneRaw) {
  const [contact, setContact] = useState(null)
  const [loading, setLoading] = useState(true)

  let normalizedPhone = null
  if (phoneRaw) {
    try { normalizedPhone = normalizePhone(phoneRaw) }
    catch { normalizedPhone = null }
  }

  useEffect(() => {
    if (!slug || !normalizedPhone) {
      setLoading(false)
      return
    }
    setLoading(true)
    const ref = doc(db, 'organizations', slug, 'smsContacts', normalizedPhone)
    const unsub = onSnapshot(ref, (snap) => {
      setContact(snap.exists() ? snap.data() : null)
      setLoading(false)
    })
    return unsub
  }, [slug, normalizedPhone])

  let derivedState
  if (!normalizedPhone) derivedState = 'no_phone'
  else if (contact === null) derivedState = 'unknown'
  else if (contact.optIn === true) derivedState = 'opted_in'
  else if (contact.optIn === false) derivedState = 'opted_out'
  else if (contact.invitedAt) derivedState = 'pending'
  else derivedState = 'unknown'

  return { contact, loading, derivedState, normalizedPhone }
}
