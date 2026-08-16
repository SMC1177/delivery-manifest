import { useEffect, useMemo, useState } from 'react'
import { collection, query, where, in as inOp, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'

// Operator vocabulary (designer ruling): the queue status a patient's text is in.
// 'failed' reads as 'Retrying' — it has attempts left and will retry; only 'dead'
// (Not sent) means a patient never heard from the pharmacy.
const STATUS_VOCAB = {
  pending: 'Queued',
  sending: 'Sending',
  complete: 'Sent',
  failed: 'Retrying',
  dead: 'Not sent',
}

const CHUNK = 30 // Firestore 'in' cap

/**
 * Per-tracking-number queue state for the currently visible page.
 *
 * Subscribes to the queue collection for ONLY the page's distinct tracking
 * numbers, chunking 'in' queries at 30 (Firestore's cap — never assume a page
 * fits). A tracking number can have several queue docs (one per templateKey:
 * shipped, delivered, exception...); the most recent (by updatedAt) wins.
 *
 * Returns a plain map trackingNumber -> display state (Queued/Sending/Sent/
 * Retrying/Not sent). Unsubscribes on unmount or page change.
 */
export default function useQueueStates(orgSlug, trackingNumbers) {
  const trackingKey = (trackingNumbers || []).join('|')
  const distinct = useMemo(
    () => [...new Set(trackingKey.split('|').map((t) => t.trim()).filter(Boolean))],
    [trackingKey],
  )
  const [byKey, setByKey] = useState({})

  useEffect(() => {
    if (!orgSlug || distinct.length === 0) return undefined

    const col = collection(db, 'organizations', orgSlug, 'settings', 'textMessaging', 'queue')
    const chunks = []
    for (let i = 0; i < distinct.length; i += CHUNK) {
      chunks.push(distinct.slice(i, i + CHUNK))
    }

    const applySnap = (snap) => {
      setByKey((prev) => {
        const next = { ...(prev[trackingKey] || {}) }
        for (const d of snap.docs) {
          const tracking = String(d.id || '').split('__')[0]
          if (!tracking) continue
          const data = d.data() || {}
          const updatedAt = data.updatedAt ?? data.createdAt ?? 0
          const current = next[tracking]
          if (!current || updatedAt >= current.updatedAt) {
            next[tracking] = {
              display: STATUS_VOCAB[data.status] || data.status || 'Queued',
              updatedAt,
            }
          }
        }
        return { ...prev, [trackingKey]: next }
      })
    }

    const unsubs = chunks.map((chunk) =>
      onSnapshot(query(col, where('__name__', 'in', inOp(chunk))), applySnap),
    )
    return () => unsubs.forEach((u) => u && u())
  }, [orgSlug, distinct, trackingKey])

  const states = byKey[trackingKey] || {}
  return Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.display]))
}
