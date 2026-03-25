import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'

const MAX_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15

function emailToDocId(email) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

export async function checkRateLimit(email) {
  const docId = emailToDocId(email)
  const ref = doc(db, 'loginAttempts', docId)
  const snap = await getDoc(ref)

  if (!snap.exists()) return { locked: false, attemptsLeft: MAX_ATTEMPTS }

  const data = snap.data()
  if (data.lockedUntil) {
    const lockedUntil = data.lockedUntil.toDate ? data.lockedUntil.toDate() : new Date(data.lockedUntil)
    if (lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((lockedUntil - new Date()) / 60000)
      return { locked: true, minutesLeft }
    }
  }

  return { locked: false, attemptsLeft: MAX_ATTEMPTS - (data.attempts || 0) }
}

export async function recordFailedAttempt(email) {
  const docId = emailToDocId(email)
  const ref = doc(db, 'loginAttempts', docId)
  const snap = await getDoc(ref)

  let attempts = 1
  if (snap.exists()) {
    const data = snap.data()
    // Reset if lockout has expired
    if (data.lockedUntil) {
      const lockedUntil = data.lockedUntil.toDate ? data.lockedUntil.toDate() : new Date(data.lockedUntil)
      if (lockedUntil <= new Date()) {
        attempts = 1
      } else {
        attempts = (data.attempts || 0) + 1
      }
    } else {
      attempts = (data.attempts || 0) + 1
    }
  }

  const update = {
    attempts,
    lastAttempt: serverTimestamp(),
    lockedUntil: attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
      : null,
  }

  await setDoc(ref, update)
  return { locked: attempts >= MAX_ATTEMPTS, attemptsLeft: MAX_ATTEMPTS - attempts }
}

export async function clearLoginAttempts(email) {
  const docId = emailToDocId(email)
  const ref = doc(db, 'loginAttempts', docId)
  await setDoc(ref, { attempts: 0, lastAttempt: serverTimestamp(), lockedUntil: null })
}
