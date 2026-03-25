import { collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, limit } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useCallback, useState, useEffect } from 'react'

export function useAuditLog(orgSlug) {
  const { user, userData } = useAuth()

  const logAction = useCallback(
    async (action, targetId, details = {}) => {
      if (!orgSlug || !user) return
      const colRef = collection(db, 'organizations', orgSlug, 'auditLog')
      await addDoc(colRef, {
        action,
        userId: user.uid,
        userName: userData?.name || user.email,
        targetId: targetId || null,
        details,
        timestamp: serverTimestamp(),
        ip: null,
      })
    },
    [orgSlug, user, userData]
  )

  return { logAction }
}

export function useAuditLogEntries(orgSlug, maxEntries = 100) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgSlug) {
      setEntries([])
      setLoading(false)
      return
    }

    const colRef = collection(db, 'organizations', orgSlug, 'auditLog')
    const q = query(colRef, orderBy('timestamp', 'desc'), limit(maxEntries))

    const unsub = onSnapshot(
      q,
      (snap) => {
        setEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setLoading(false)
      },
      (err) => {
        console.error('Audit log error:', err)
        setLoading(false)
      }
    )

    return unsub
  }, [orgSlug, maxEntries])

  return { entries, loading }
}
