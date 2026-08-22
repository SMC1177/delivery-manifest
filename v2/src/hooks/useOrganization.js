import { useState, useEffect } from 'react'
import {
  doc,
  getDoc,
  collection,
  onSnapshot,
  setDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { resendStaffInvite, removeStaffAccount, linkExistingStaff } from '../utils/staffLifecycleClient'

export function useOrganization() {
  const { orgSlug: orgId, userData } = useAuth()
  const [org, setOrg] = useState(null)
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) {
      setOrg(null)
      setMembers([])
      setLoading(false)
      return
    }

    // Load org info
    getDoc(doc(db, 'organizations', orgId)).then((snap) => {
      if (snap.exists()) setOrg({ id: snap.id, ...snap.data() })
    })

    // Subscribe to members
    const unsub = onSnapshot(collection(db, 'organizations', orgId, 'members'), (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })

    return unsub
  }, [orgId])

  async function addMember(email, name, role = 'driver') {
    if (!orgId) throw new Error('No organization')
    // Create a placeholder member doc using the email as the temp ID
    // The user will need to register and then be linked
    const memberId = email.replace(/[^a-zA-Z0-9]/g, '_')
    await setDoc(doc(db, 'organizations', orgId, 'members', memberId), {
      name,
      email,
      role,
      joinedAt: serverTimestamp(),
      pending: true,
    })
  }

  async function updateMemberRole(memberId, role) {
    if (!orgId) throw new Error('No organization')
    await updateDoc(doc(db, 'organizations', orgId, 'members', memberId), { role })
  }

  async function updateOrgSettings(updates) {
    if (!orgId) throw new Error('No organization')
    // Separate top-level org fields from nested settings
    const topLevelKeys = ['name', 'logoUrl', 'showNameWithLogo']
    const topLevelUpdates = {}
    const settingsUpdates = {}

    for (const [key, value] of Object.entries(updates)) {
      if (topLevelKeys.includes(key)) {
        topLevelUpdates[key] = value
      } else {
        settingsUpdates[`settings.${key}`] = value
      }
    }

    const docUpdates = {
      ...topLevelUpdates,
      ...settingsUpdates,
      updatedAt: serverTimestamp(),
    }

    await updateDoc(doc(db, 'organizations', orgId), docUpdates)
    setOrg((prev) => {
      const newOrg = { ...prev, ...topLevelUpdates }
      if (Object.keys(settingsUpdates).length > 0) {
        const newSettings = { ...(prev?.settings || {}) }
        for (const [key, value] of Object.entries(updates)) {
          if (!topLevelKeys.includes(key)) {
            newSettings[key] = value
          }
        }
        newOrg.settings = newSettings
      }
      return newOrg
    })
  }

  async function removeMember(memberId) {
    if (!orgId) throw new Error('No organization')
    return removeStaffAccount(orgId, memberId)
  }

  async function resendInvite(memberId) {
    if (!orgId) throw new Error('No organization')
    return resendStaffInvite(orgId, memberId)
  }

  async function linkExisting(email, name, role) {
    if (!orgId) throw new Error('No organization')
    return linkExistingStaff(orgId, email, name, role)
  }

  const isAdmin = userData?.role === 'admin'

  return { org, members, loading, isAdmin, addMember, updateMemberRole, removeMember, resendInvite, linkExisting, updateOrgSettings }
}
