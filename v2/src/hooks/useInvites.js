import { useState, useEffect } from 'react'
import {
  collection,
  query,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  getDocs,
  where,
  updateDoc,
  arrayUnion,
  increment,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'

function generateCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  for (let i = 0; i < length; i++) {
    code += chars[arr[i] % chars.length]
  }
  return code
}

export function useInvites(orgSlug) {
  const { user } = useAuth()
  const [invites, setInvites] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgSlug) {
      setInvites([])
      setLoading(false)
      return
    }

    const colRef = collection(db, 'organizations', orgSlug, 'invites')
    const unsub = onSnapshot(
      query(colRef),
      (snap) => {
        setInvites(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setLoading(false)
      },
      (err) => {
        console.error('Invites error:', err)
        setLoading(false)
      }
    )

    return unsub
  }, [orgSlug])

  async function createInvite({ role = 'staff', maxUses = 1, expiresInHours = 72 }) {
    if (!orgSlug || !user) throw new Error('No organization')
    const code = generateCode()
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)

    const colRef = collection(db, 'organizations', orgSlug, 'invites')
    await addDoc(colRef, {
      code,
      role,
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      expiresAt,
      maxUses,
      usedCount: 0,
      usedBy: [],
    })

    return code
  }

  async function deleteInvite(inviteId) {
    if (!orgSlug) throw new Error('No organization')
    await deleteDoc(doc(db, 'organizations', orgSlug, 'invites', inviteId))
  }

  return { invites, loading, createInvite, deleteInvite }
}

export async function findInviteByCode(slug, code) {
  const colRef = collection(db, 'organizations', slug, 'invites')
  const q = query(colRef, where('code', '==', code))
  const snap = await getDocs(q)
  if (snap.empty) return null
  const inviteDoc = snap.docs[0]
  return { id: inviteDoc.id, ...inviteDoc.data() }
}

export async function redeemInvite(slug, inviteId, userId) {
  const ref = doc(db, 'organizations', slug, 'invites', inviteId)
  await updateDoc(ref, {
    usedCount: increment(1),
    usedBy: arrayUnion(userId),
  })
}
