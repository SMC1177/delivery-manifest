import { useState, useEffect, useCallback } from 'react'
import {
  collection,
  query,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'

export function getCentralTimeDateString(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'America/Chicago',
    })
    const parts = formatter.formatToParts(date)
    const year = parts.find((p) => p.type === 'year').value
    const month = parts.find((p) => p.type === 'month').value
    const day = parts.find((p) => p.type === 'day').value
    return `${year}-${month}-${day}`
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export function useDeliveries() {
  const { orgId, user } = useAuth()
  const [deliveries, setDeliveries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchDeliveries = useCallback(async () => {
    if (!orgId) {
      setDeliveries([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'organizations', orgId, 'deliveries')))
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      docs.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
        const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
        return dateB - dateA
      })
      setDeliveries(docs)
      setError(null)
    } catch (err) {
      console.error('Deliveries fetch error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    fetchDeliveries()
  }, [fetchDeliveries])

  useEffect(() => {
    const handleFocus = () => fetchDeliveries()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchDeliveries()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [fetchDeliveries])

  async function addDelivery(data) {
    if (!orgId) throw new Error('No organization')
    const colRef = collection(db, 'organizations', orgId, 'deliveries')
    await addDoc(colRef, {
      ...data,
      status: data.status || 'pending',
      assignedDriver: data.assignedDriver || null,
      deliveredAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: user.uid,
    })
    await fetchDeliveries()
  }

  async function updateDelivery(id, data) {
    if (!orgId) throw new Error('No organization')
    const ref = doc(db, 'organizations', orgId, 'deliveries', id)
    const updates = { ...data, updatedAt: serverTimestamp() }
    if (data.status === 'delivered' && !data.deliveredAt) {
      updates.deliveredAt = serverTimestamp()
    }
    await updateDoc(ref, updates)
    await fetchDeliveries()
  }

  async function removeDelivery(id) {
    if (!orgId) throw new Error('No organization')
    const ref = doc(db, 'organizations', orgId, 'deliveries', id)
    await deleteDoc(ref)
    await fetchDeliveries()
  }

  return { deliveries, loading, error, refresh: fetchDeliveries, addDelivery, updateDelivery, removeDelivery }
}
