import { useState } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'

const functions = getFunctions()
const trackUpsFn = httpsCallable(functions, 'trackUps')

/**
 * Hook to fetch UPS tracking status via Cloud Function.
 *
 * Usage:
 *   const { trackingData, loading, error, fetchTracking } = useUpsTracking()
 *   await fetchTracking('1Z999AA10123456784')
 */
export function useUpsTracking() {
  const [trackingData, setTrackingData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function fetchTracking(trackingNumber) {
    setLoading(true)
    setError(null)
    setTrackingData(null)
    try {
      const result = await trackUpsFn({ trackingNumber })
      setTrackingData(result.data)
      return result.data
    } catch (err) {
      setError(err.message || 'Failed to fetch UPS tracking info')
      return null
    } finally {
      setLoading(false)
    }
  }

  return { trackingData, loading, error, fetchTracking }
}
