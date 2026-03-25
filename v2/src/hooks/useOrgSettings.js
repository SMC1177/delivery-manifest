import { useState, useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'

/**
 * Subscribe to org settings. Returns enabledFields array
 * and a helper to check if a field is enabled.
 */
export function useOrgSettings(orgSlug) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgSlug) {
      setSettings(null)
      setLoading(false)
      return
    }

    const unsub = onSnapshot(doc(db, 'organizations', orgSlug), (snap) => {
      if (snap.exists()) {
        setSettings(snap.data().settings || {})
      }
      setLoading(false)
    })

    return unsub
  }, [orgSlug])

  const enabledFields = settings?.enabledFields || ['notes', 'carrier']

  function isFieldEnabled(fieldKey) {
    return enabledFields.includes(fieldKey)
  }

  return { settings, enabledFields, isFieldEnabled, loading }
}
