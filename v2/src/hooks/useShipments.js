import { useState, useEffect, useCallback } from 'react'
import {
  collection,
  query,
  where,
  getDocs,

  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  arrayUnion,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { getCentralTimeDateString } from '../utils/dateUtils'

export { getCentralTimeDateString }

export function formatCentralTime(date) {
  if (!date) return '—'
  const d = date.toDate ? date.toDate() : new Date(date)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  }).format(d)
}

export function useShipments(orgSlug) {
  const { user } = useAuth()
  const [shipments, setShipments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchShipments = useCallback(async () => {
    if (!orgSlug) {
      setShipments([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'organizations', orgSlug, 'shipments')))
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      docs.sort((a, b) => {
        const dateA = a.date || ''
        const dateB = b.date || ''
        return dateB.localeCompare(dateA)
      })
      setShipments(docs)
      setError(null)
    } catch (err) {
      console.error('Shipments fetch error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgSlug])

  useEffect(() => { fetchShipments() }, [fetchShipments])

  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') fetchShipments() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [fetchShipments])

  /**
   * Add a shipment with duplicate detection.
   * - Same tracking number → merge Rx numbers into existing record
   * - Same date + overlapping Rx + same tracking → exact duplicate, skip
   * Returns { id, merged, skipped, message }
   */
  async function addShipment(data) {
    if (!orgSlug) throw new Error('No organization')
    const colRef = collection(db, 'organizations', orgSlug, 'shipments')
    const newRxNumbers = Array.isArray(data.rxNumbers) ? data.rxNumbers : []

    // Check for existing shipment with same tracking number
    if (data.trackingNumber && data.trackingNumber.trim()) {
      const trackingQuery = query(
        colRef,
        where('trackingNumber', '==', data.trackingNumber.trim())
      )
      const trackingSnap = await getDocs(trackingQuery)

      if (!trackingSnap.empty) {
        const existingDoc = trackingSnap.docs[0]
        const existing = existingDoc.data()
        const existingRx = Array.isArray(existing.rxNumbers) ? existing.rxNumbers : []

        // Find Rx numbers that aren't already on the record
        const newRx = newRxNumbers.filter((rx) => !existingRx.includes(rx))

        if (newRx.length === 0) {
          // All Rx numbers already exist — exact duplicate, skip
          return {
            id: existingDoc.id,
            merged: false,
            skipped: true,
            message: `Duplicate skipped — shipment for ${existing.patientName} with this tracking number already exists.`,
          }
        }

        // Merge new Rx numbers into existing record
        const ref = doc(db, 'organizations', orgSlug, 'shipments', existingDoc.id)
        await updateDoc(ref, {
          rxNumbers: arrayUnion(...newRx),
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        })

        await fetchShipments()
        return {
          id: existingDoc.id,
          merged: true,
          skipped: false,
          message: `Merged ${newRx.length} new Rx number${newRx.length === 1 ? '' : 's'} (${newRx.join(', ')}) into existing shipment for ${existing.patientName}.`,
        }
      }
    }

    // Rx-based dedup: same patient + same Rx numbers = likely duplicate (regardless of date)
    if (newRxNumbers.length > 0 && data.patientName) {
      const patientQuery = query(
        colRef,
        where('patientName', '==', data.patientName.trim())
      )
      const patientSnap = await getDocs(patientQuery)

      for (const d of patientSnap.docs) {
        const existing = d.data()
        const existingRx = Array.isArray(existing.rxNumbers) ? existing.rxNumbers : []
        // Check if ALL new Rx numbers already exist on an existing record
        const allRxExist = newRxNumbers.every((rx) => existingRx.includes(rx))

        if (allRxExist && newRxNumbers.length > 0) {
          return {
            id: d.id,
            merged: false,
            skipped: true,
            message: `Duplicate skipped — ${existing.patientName} already has a shipment with the same Rx numbers (${newRxNumbers.join(', ')}).`,
          }
        }
      }
    }

    // Check for same date + overlapping Rx (no tracking match)
    const shipDate = data.date || getCentralTimeDateString()
    if (newRxNumbers.length > 0) {
      const dateQuery = query(colRef, where('date', '==', shipDate))
      const dateSnap = await getDocs(dateQuery)

      for (const d of dateSnap.docs) {
        const existing = d.data()
        const existingRx = Array.isArray(existing.rxNumbers) ? existing.rxNumbers : []
        const overlap = newRxNumbers.some((rx) => existingRx.includes(rx))

        if (overlap) {
          return {
            id: d.id,
            merged: false,
            skipped: false,
            duplicate: true,
            existingPatient: existing.patientName,
            message: `A shipment on ${shipDate} for ${existing.patientName} already contains overlapping Rx numbers. Is this a new shipment?`,
          }
        }
      }
    }

    // No duplicates found — create new shipment
    const docRef = await addDoc(colRef, {
      ...data,
      date: shipDate,
      carrier: data.carrier || 'ups',
      status: data.status || 'pending',
      archived: false,
      deliveredAt: null,
      shippedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: user.uid,
      updatedBy: user.uid,
    })
    await fetchShipments()
    return { id: docRef.id, merged: false, skipped: false, message: null }
  }

  async function updateShipment(id, data) {
    if (!orgSlug) throw new Error('No organization')
    const ref = doc(db, 'organizations', orgSlug, 'shipments', id)
    const updates = { ...data, updatedAt: serverTimestamp(), updatedBy: user.uid }
    if (data.status === 'delivered' && !data.deliveredAt) {
      updates.deliveredAt = serverTimestamp()
    }
    if (data.status === 'shipped' && !data.shippedAt) {
      updates.shippedAt = serverTimestamp()
    }
    await updateDoc(ref, updates)
    await fetchShipments()
  }

  async function removeShipment(id) {
    if (!orgSlug) throw new Error('No organization')
    const ref = doc(db, 'organizations', orgSlug, 'shipments', id)
    await deleteDoc(ref)
    await fetchShipments()
  }

  return { shipments, loading, error, refresh: fetchShipments, addShipment, updateShipment, removeShipment }
}
