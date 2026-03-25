import { useState, useEffect, useCallback, useRef } from 'react'

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart']
const WARNING_BEFORE_MS = 5 * 60 * 1000 // 5 minutes before timeout
const THROTTLE_MS = 30000 // Only reset timers at most every 30s on activity

export function useSessionTimeout(timeoutMinutes = 30, onTimeout) {
  const [showWarning, setShowWarning] = useState(false)
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const timeoutRef = useRef(null)
  const warningRef = useRef(null)
  const countdownRef = useRef(null)
  const lastResetRef = useRef(Date.now())
  const showWarningRef = useRef(false)

  const timeoutMs = timeoutMinutes * 60 * 1000
  const warningMs = timeoutMs - WARNING_BEFORE_MS

  const clearAllTimers = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (warningRef.current) clearTimeout(warningRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
  }, [])

  const startTimers = useCallback(() => {
    clearAllTimers()
    lastResetRef.current = Date.now()
    showWarningRef.current = false
    setShowWarning(false)

    warningRef.current = setTimeout(() => {
      showWarningRef.current = true
      setShowWarning(true)
      setRemainingSeconds(Math.round(WARNING_BEFORE_MS / 1000))
      countdownRef.current = setInterval(() => {
        setRemainingSeconds((prev) => {
          if (prev <= 1) {
            clearInterval(countdownRef.current)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }, warningMs)

    timeoutRef.current = setTimeout(() => {
      showWarningRef.current = false
      setShowWarning(false)
      clearAllTimers()
      onTimeout?.()
    }, timeoutMs)
  }, [timeoutMs, warningMs, onTimeout, clearAllTimers])

  const dismissWarning = useCallback(() => {
    startTimers()
  }, [startTimers])

  useEffect(() => {
    startTimers()

    const handleActivity = () => {
      // Don't reset if warning is showing (user must click dismiss)
      if (showWarningRef.current) return
      // Throttle resets
      if (Date.now() - lastResetRef.current < THROTTLE_MS) return
      startTimers()
    }

    ACTIVITY_EVENTS.forEach((event) => document.addEventListener(event, handleActivity, { passive: true }))

    return () => {
      ACTIVITY_EVENTS.forEach((event) => document.removeEventListener(event, handleActivity))
      clearAllTimers()
    }
  }, [startTimers, clearAllTimers])

  return { showWarning, remainingSeconds, dismissWarning }
}
