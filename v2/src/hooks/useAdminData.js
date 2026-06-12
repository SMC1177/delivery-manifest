// v2/src/hooks/useAdminData.js
// Data layer for AdminDashboardPage. Wraps the platformAdmin-gated
// callables getOrgUsageSummary / updateOrgBillingConfig so the page
// stays presentational and tests can mock this hook.
import { useState, useCallback } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'

export function useAdminData() {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const fetchSummary = useCallback(async (months) => {
    setLoading(true)
    setError(null)
    try {
      const getOrgUsageSummary = httpsCallable(getFunctions(), 'getOrgUsageSummary')
      const params = months !== undefined ? { months } : {}
      const result = await getOrgUsageSummary(params)
      setSummary(result.data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const saveBillingConfig = useCallback(async (orgSlug, billingConfig) => {
    setSaving(true)
    setError(null)
    try {
      const updateOrgBillingConfig = httpsCallable(getFunctions(), 'updateOrgBillingConfig')
      await updateOrgBillingConfig({ orgSlug, billingConfig })
      // Re-fetch to reflect changes
      if (summary?.months !== undefined) {
        await fetchSummary(summary.months)
      }
    } catch (err) {
      setError(err.message)
      throw err // rethrow so the editor form can react
    } finally {
      setSaving(false)
    }
  }, [summary, fetchSummary])

  return { summary, loading, saving, error, fetchSummary, saveBillingConfig }
}
