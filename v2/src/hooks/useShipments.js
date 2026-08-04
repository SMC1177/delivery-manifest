import { useState, useEffect, useCallback, useRef } from 'react'
import {
  collection,
  query,
  where,
  getDocs,
  getCountFromServer,
  limit,
  orderBy,
  startAfter,
  startAt,
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

export function useShipments(orgSlug, options = {}) {
  const { user } = useAuth()
  const { archived = false, backfillComplete = false, searchBackfillComplete = false, pageSize = 25, status, dateFrom, dateTo, search = '' } = options
  const [shipments, setShipments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [hasPrev, setHasPrev] = useState(false)
  const cursorStackRef = useRef([])
  const pageFirstDocRef = useRef(null)
  const pageLastDocRef = useRef(null)
  const isSearchActiveRef = useRef(false)

  const [total, setTotal] = useState(0)
  const [statusCounts, setStatusCounts] = useState({})
  const [countsLoading, setCountsLoading] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [searchCapReached, setSearchCapReached] = useState(false)

  const fetchShipments = useCallback(async () => {
    if (!orgSlug) {
      setShipments([])
      setLoading(false)
      return
    }
    if (isSearchActiveRef.current) return
    setLoading(true)
    try {
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      if (!searchBackfillComplete) {
        const constraints = archived
          ? [where('archived', '==', true)]
          : backfillComplete
            ? [where('archived', '==', false)]
            : []
        const snap = await getDocs(query(colRef, ...constraints))
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        docs.sort((a, b) => {
          const dateA = a.date || ''
          const dateB = b.date || ''
          return dateB.localeCompare(dateA)
        })
        setShipments(docs)
      } else {
        const constraints = [where('archived', '==', false)]
        if (status && status !== 'all') {
          constraints.push(where('status', '==', status))
        }
        if (dateFrom) {
          constraints.push(where('date', '>=', dateFrom))
        }
        if (dateTo) {
          constraints.push(where('date', '<=', dateTo))
        }
        constraints.push(orderBy('date', 'desc'))
        constraints.push(limit(pageSize))
        const snap = await getDocs(query(colRef, ...constraints))
        cursorStackRef.current = []
        pageFirstDocRef.current = snap.docs.length > 0 ? snap.docs[0] : null
        pageLastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        setShipments(docs)
        setCurrentPage(1)
        setHasNext(snap.docs.length === pageSize)
        setHasPrev(false)
      }
      setError(null)
    } catch (err) {
      console.error('Shipments fetch error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgSlug, archived, backfillComplete, searchBackfillComplete, pageSize, status, dateFrom, dateTo])

  useEffect(() => { fetchShipments() }, [fetchShipments])

  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') fetchShipments() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [fetchShipments])

  // Server-side counts (only when searchBackfillComplete is true)
  const STATUS_VALUES = ['pending', 'shipped', 'in_transit', 'delivered', 'exception']
  useEffect(() => {
    if (!orgSlug || !searchBackfillComplete) return
    let cancelled = false
    setCountsLoading(true)

    async function fetchCounts() {
      try {
        const colRef = collection(db, 'organizations', orgSlug, 'shipments')
        const baseConstraints = [where('archived', '==', false)]
        if (dateFrom) baseConstraints.push(where('date', '>=', dateFrom))
        if (dateTo) baseConstraints.push(where('date', '<=', dateTo))

        const isStatusActive = status && status !== 'all'
        const totalConstraints = isStatusActive
          ? [...baseConstraints, where('status', '==', status)]
          : baseConstraints

        const [totalSnap, allSnap, ...statusSnaps] = await Promise.all([
          getCountFromServer(query(colRef, ...totalConstraints)),
          getCountFromServer(query(colRef, ...baseConstraints)),
          ...STATUS_VALUES.map(s =>
            getCountFromServer(query(colRef, ...baseConstraints, where('status', '==', s)))
          ),
        ])

        if (cancelled) return

        const counts = { all: allSnap.data().count }
        STATUS_VALUES.forEach((s, i) => {
          counts[s] = statusSnaps[i].data().count
        })

        setTotal(totalSnap.data().count)
        setStatusCounts(counts)
        setError(null)
      } catch (err) {
        if (!cancelled) {
          console.error('Counts query failed:', err)
          setError(err.message || 'Failed to load filter counts')
        }
      } finally {
        if (!cancelled) setCountsLoading(false)
      }
    }

    fetchCounts()
    return () => { cancelled = true }
  }, [orgSlug, searchBackfillComplete, status, dateFrom, dateTo])

  // Client-side counts (when searchBackfillComplete is false, derive from loaded array)
  useEffect(() => {
    if (searchBackfillComplete) return
    const counts = { all: shipments.length }
    for (const s of shipments) {
      counts[s.status] = (counts[s.status] || 0) + 1
    }
    setTotal(shipments.length)
    setStatusCounts(counts)
  }, [shipments, searchBackfillComplete])

  // Server-side bounded search (only when searchBackfillComplete is true and search is non-empty)
  useEffect(() => {
    if (!orgSlug || !searchBackfillComplete) return
    const q = (search || '').trim().toLowerCase()
    if (!q) {
      setIsSearching(false)
      setSearchCapReached(false)
      isSearchActiveRef.current = false
      fetchShipments()
      return
    }

    let cancelled = false
    setIsSearching(true)
    isSearchActiveRef.current = true
    setLoading(true)

    async function runSearch() {
      try {
        const colRef = collection(db, 'organizations', orgSlug, 'shipments')
        const SEARCH_CAP = 300

        // Query 1: patient-name prefix (lowercase, Firestore inequality requires orderBy on the same field)
        const nameQ = query(
          colRef,
          where('archived', '==', false),
          where('patientNameLower', '>=', q),
          where('patientNameLower', '<=', q + '\uf8ff'),
          orderBy('patientNameLower'),
          limit(SEARCH_CAP)
        )

        // Query 2: exact tracking number
        const trackingQ = query(
          colRef,
          where('archived', '==', false),
          where('trackingNumber', '==', search.trim()),
          limit(SEARCH_CAP)
        )

        // Query 3: exact Rx number via array-contains
        const rxQ = query(
          colRef,
          where('archived', '==', false),
          where('rxNumbers', 'array-contains', search.trim()),
          limit(SEARCH_CAP)
        )

        const results = await Promise.allSettled([
          getDocs(nameQ),
          getDocs(trackingQ),
          getDocs(rxQ),
        ])

        if (cancelled) return

        // If any query failed, surface the error — partial results are silently wrong
        for (const r of results) {
          if (r.status === 'rejected') {
            throw r.reason
          }
        }

        // Merge and deduplicate by document id
        const seen = new Set()
        const merged = []
        for (const r of results) {
          for (const d of r.value.docs) {
            if (!seen.has(d.id)) {
              seen.add(d.id)
              merged.push({ id: d.id, ...d.data() })
            }
          }
        }

        const capped = merged.length >= SEARCH_CAP
        const final = merged.slice(0, SEARCH_CAP)

        setShipments(final)
        setSearchCapReached(capped)
        setError(null)
      } catch (err) {
        if (!cancelled) {
          console.error('Search error:', err)
          setError(err.message || 'Search failed')
          setIsSearching(false)
          isSearchActiveRef.current = false
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    runSearch()
    return () => { cancelled = true }
  }, [orgSlug, searchBackfillComplete, search])

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

    // Rx-based dedup: same patient + same Rx numbers + same refill number = duplicate (regardless of date)
    if (newRxNumbers.length > 0 && data.patientName) {
      const patientQuery = query(
        colRef,
        where('patientName', '==', data.patientName.trim())
      )
      const patientSnap = await getDocs(patientQuery)
      // Refill numbers compare as trimmed, lowercased strings so "2", " 2", and 2
      // are equivalent, and a missing value on either side becomes "" instead of
      // comparing undefined to null. Both sides missing still compares equal.
      const newRefill = String(data.refillNumber ?? '').trim().toLowerCase()

      for (const d of patientSnap.docs) {
        const existing = d.data()
        const existingRx = Array.isArray(existing.rxNumbers) ? existing.rxNumbers : []
        const existingRefill = String(existing.refillNumber ?? '').trim().toLowerCase()
        // Check if ALL new Rx numbers already exist on an existing record with the same refill number
        const allRxExist = newRxNumbers.every((rx) => existingRx.includes(rx))

        if (allRxExist && newRxNumbers.length > 0 && existingRefill === newRefill) {
          return {
            id: d.id,
            merged: false,
            skipped: true,
            message: `Duplicate skipped — ${existing.patientName} already has a shipment with the same Rx numbers (${newRxNumbers.join(', ')}) and refill number ${newRefill || '(none)'}.`,
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
      patientNameLower: (typeof data.patientName === 'string' ? data.patientName : '').trim().toLowerCase(),
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
    // patientNameLower tracks patientName so renamed/corrected patients stay
    // findable in prefix search. Unlike `archived` — stamped once at creation
    // and never touched on update — this field MUST stay in sync on every
    // update that carries a patientName property.
    if ('patientName' in data) {
      updates.patientNameLower = (typeof data.patientName === 'string' ? data.patientName : '').trim().toLowerCase()
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

  const nextPage = useCallback(async () => {
    if (isSearching || !hasNext || !pageLastDocRef.current || !orgSlug) return
    setLoading(true)
    try {
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      const constraints = [where('archived', '==', false)]
      if (status && status !== 'all') {
        constraints.push(where('status', '==', status))
      }
      if (dateFrom) {
        constraints.push(where('date', '>=', dateFrom))
      }
      if (dateTo) {
        constraints.push(where('date', '<=', dateTo))
      }
      constraints.push(orderBy('date', 'desc'))
      if (pageFirstDocRef.current) {
        cursorStackRef.current.push(pageFirstDocRef.current)
      }
      constraints.push(startAfter(pageLastDocRef.current))
      constraints.push(limit(pageSize))
      const snap = await getDocs(query(colRef, ...constraints))
      pageFirstDocRef.current = snap.docs.length > 0 ? snap.docs[0] : null
      pageLastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setShipments(docs)
      setCurrentPage(p => p + 1)
      setHasNext(snap.docs.length === pageSize)
      setHasPrev(true)
      setError(null)
    } catch (err) {
      console.error('Shipments nextPage error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgSlug, status, dateFrom, dateTo, pageSize, hasNext, isSearching])

  const prevPage = useCallback(async () => {
    if (isSearching || !hasPrev || cursorStackRef.current.length === 0 || !orgSlug) return
    setLoading(true)
    try {
      const colRef = collection(db, 'organizations', orgSlug, 'shipments')
      const constraints = [where('archived', '==', false)]
      if (status && status !== 'all') {
        constraints.push(where('status', '==', status))
      }
      if (dateFrom) {
        constraints.push(where('date', '>=', dateFrom))
      }
      if (dateTo) {
        constraints.push(where('date', '<=', dateTo))
      }
      constraints.push(orderBy('date', 'desc'))
      const cursor = cursorStackRef.current.pop()
      constraints.push(startAt(cursor))
      constraints.push(limit(pageSize))
      const snap = await getDocs(query(colRef, ...constraints))
      pageFirstDocRef.current = snap.docs.length > 0 ? snap.docs[0] : null
      pageLastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setShipments(docs)
      setCurrentPage(p => p - 1)
      setHasNext(true)
      setHasPrev(cursorStackRef.current.length > 0)
      setError(null)
    } catch (err) {
      console.error('Shipments prevPage error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgSlug, status, dateFrom, dateTo, pageSize, hasPrev, isSearching])

  return { shipments, loading, error, total, statusCounts, countsLoading, isSearching, searchCapReached, refresh: fetchShipments, addShipment, updateShipment, removeShipment, nextPage, prevPage, currentPage, hasNext, hasPrev }
}
