import { useState } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'

const functions = getFunctions()
const trackFedExFn = httpsCallable(functions, 'trackFedEx')

/**
 * Hook to fetch FedEx tracking status via Cloud Function.
 *
 * Usage:
 *   const { trackingData, loading, error, fetchTracking } = useFedExTracking()
 *   await fetchTracking('789456123012')
 */
export function useFedExTracking() {
  const [trackingData, setTrackingData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function fetchTracking(trackingNumber) {
    setLoading(true)
    setError(null)
    setTrackingData(null)
    try {
      const result = await trackFedExFn({ trackingNumber })
      setTrackingData(result.data)
      return result.data
    } catch (err) {
      setError(err.message || 'Failed to fetch tracking info')
      return null
    } finally {
      setLoading(false)
    }
  }

  return { trackingData, loading, error, fetchTracking }
}
