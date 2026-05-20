import { useState, useEffect, useCallback } from 'react'
import { doc, setDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'

/**
 * Reads/writes organizations/{slug}/settings/textMessaging.
 * `data` is null while loading. Save is a stable callback.
 */
export function useTextMessagingSettings(slug) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!slug) return
    const ref = doc(db, 'organizations', slug, 'settings', 'textMessaging')
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setData(snap.exists() ? snap.data() : null)
        setLoading(false)
      },
      (err) => {
        setError(err)
        setLoading(false)
      },
    )
    return unsub
  }, [slug])

  const save = useCallback(
    async (partial) => {
      const ref = doc(db, 'organizations', slug, 'settings', 'textMessaging')
      await setDoc(ref, partial, { merge: true })
    },
    [slug],
  )

  return { data, loading, error, save }
}
