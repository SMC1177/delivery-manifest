// v2/src/pages/AdminDashboardPage.jsx
// Super-user view: cross-org usage for billing + billingConfig editor.
// Data comes exclusively from platformAdmin-gated callables — counts and
// org metadata only, never patient data.
import { Fragment, useEffect, useState } from 'react'
import { useAdminData } from '../hooks/useAdminData'

function formatMonth(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function getMonthsBetween(start, end) {
  const result = []
  const current = new Date(start + '-01')
  const last = new Date(end + '-01')
  while (current <= last) {
    result.push(formatMonth(current))
    current.setMonth(current.getMonth() + 1)
  }
  return result
}

function statusSummary(statusCounts) {
  if (!statusCounts) return ''
  const labels = { pending: 'P', shipped: 'S', in_transit: 'T', delivered: 'D', exception: 'E' }
  return Object.entries(labels)
    .map(([key, label]) => `${label}:${statusCounts[key] ?? 0}`)
    .join(' ')
}

function exportCsv(summary) {
  const months = summary.months || []
  const rows = []
  for (const org of summary.orgs) {
    for (const month of months) {
      const m = org.monthly?.[month] || {}
      rows.push([
        org.slug,
        org.name,
        month,
        m.ups ?? 0,
        m.fedex ?? 0,
        m.usps ?? 0,
        m.other ?? 0,
        m.total ?? 0,
        org.memberCount ?? 0,
        org.shipmentCount ?? 0,
        org.billingConfig?.model ?? 'unset',
      ])
    }
  }
  const header = 'slug,name,month,ups,fedex,usps,other,total,memberCount,shipmentCount,billingModel'
  const csv = [header, ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `usage-${months[0] ?? 'all'}-${months[months.length - 1] ?? 'all'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function BillingEditor({ org, onSave, saving }) {
  const [model, setModel] = useState(org.billingConfig?.model || '')
  const [baseFee, setBaseFee] = useState(org.billingConfig?.baseFee != null ? String(org.billingConfig.baseFee) : '')
  const [includedShipments, setIncludedShipments] = useState(org.billingConfig?.includedShipments != null ? String(org.billingConfig.includedShipments) : '')
  const [perShipmentRate, setPerShipmentRate] = useState(org.billingConfig?.perShipmentRate != null ? String(org.billingConfig.perShipmentRate) : '')
  const [notes, setNotes] = useState(org.billingConfig?.notes || '')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    setError('')
    setSaved(false)
    if (!model) {
      setError('Model is required')
      return
    }
    const config = {
      model,
      currency: 'usd',
      baseFee: baseFee === '' ? null : parseFloat(baseFee),
      includedShipments: includedShipments === '' ? null : parseInt(includedShipments, 10),
      perShipmentRate: perShipmentRate === '' ? null : parseFloat(perShipmentRate),
      notes: notes || null,
    }
    if (config.baseFee !== null && config.baseFee < 0) {
      setError('Base fee cannot be negative')
      return
    }
    if (config.includedShipments !== null && config.includedShipments < 0) {
      setError('Included shipments cannot be negative')
      return
    }
    if (config.perShipmentRate !== null && config.perShipmentRate < 0) {
      setError('Per-shipment rate cannot be negative')
      return
    }
    try {
      await onSave(org.slug, config)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err.message || 'Save failed')
    }
  }

  return (
    <div className="p-4 bg-slate-50 rounded-lg mt-2" data-testid={`admin-billing-editor-${org.slug}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select model</option>
            <option value="flat">Flat</option>
            <option value="per_shipment">Per Shipment</option>
            <option value="hybrid">Hybrid</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Base Fee ($)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={baseFee}
            onChange={e => setBaseFee(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Included Shipments</label>
          <input
            type="number"
            min="0"
            step="1"
            value={includedShipments}
            onChange={e => setIncludedShipments(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Per-Shipment Rate ($)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={perShipmentRate}
            onChange={e => setPerShipmentRate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value.slice(0, 2000))}
          maxLength={2000}
          rows={3}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {saved && <p className="text-sm text-green-600 mb-2">Saved</p>}
      <button
        onClick={handleSave}
        disabled={saving}
        data-testid={`admin-billing-save-${org.slug}`}
        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

export default function AdminDashboardPage() {
  const { summary, loading, saving, error, fetchSummary, saveBillingConfig } = useAdminData()

  const today = new Date()
  const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const [fromMonth, setFromMonth] = useState(formatMonth(prevMonth))
  const [toMonth, setToMonth] = useState(formatMonth(today))
  const [expandedOrg, setExpandedOrg] = useState(null)

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  const handleApply = () => {
    let months = getMonthsBetween(fromMonth, toMonth)
    if (months.length > 12) {
      months = months.slice(0, 12)
    }
    fetchSummary(months)
  }

  const handleExport = () => {
    if (!summary) return
    exportCsv(summary)
  }

  const toggleExpand = (slug) => {
    setExpandedOrg(prev => prev === slug ? null : slug)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Platform Admin</h1>
      <p className="text-sm text-slate-500 mb-6">Cross-organization usage & billing</p>

      {/* Month selector */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">From</label>
            <input
              type="month"
              value={fromMonth}
              onChange={e => setFromMonth(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">To</label>
            <input
              type="month"
              value={toMonth}
              onChange={e => setToMonth(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Apply
          </button>
          <button
            onClick={handleExport}
            data-testid="admin-export-csv"
            className="px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
          >
            Export CSV
          </button>
        </div>
        {getMonthsBetween(fromMonth, toMonth).length > 12 && (
          <p className="text-xs text-amber-600 mt-2">Range capped to 12 months.</p>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-6 mb-6">
          <p className="font-medium">Error</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && summary && summary.orgs.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-500">
          No organizations found.
        </div>
      )}

      {/* Org table */}
      {!loading && !error && summary && summary.orgs.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider">
                  <th className="p-3 font-medium">Org</th>
                  <th className="p-3 font-medium">Members</th>
                  <th className="p-3 font-medium">Lifetime Shipments</th>
                  {summary.months?.map(month => (
                    <th key={month} className="p-3 font-medium text-center" colSpan={5}>
                      {month}
                    </th>
                  ))}
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium">Billing</th>
                  <th className="p-3 font-medium"></th>
                </tr>
                <tr className="border-b border-slate-100 text-slate-400 text-xs">
                  <th></th>
                  <th></th>
                  <th></th>
                  {summary.months?.map(month => (
                    <Fragment key={month}>
                      <th className="p-1 font-medium text-center">UPS</th>
                      <th className="p-1 font-medium text-center">FedEx</th>
                      <th className="p-1 font-medium text-center">USPS</th>
                      <th className="p-1 font-medium text-center">Other</th>
                      <th className="p-1 font-medium text-center">Total</th>
                    </Fragment>
                  ))}
                  <th></th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.orgs.map(org => (
                  <Fragment key={org.slug}>
                    <tr
                      data-testid={`admin-org-row-${org.slug}`}
                      className="hover:bg-slate-50 cursor-pointer"
                      onClick={() => toggleExpand(org.slug)}
                    >
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{org.name}</div>
                        <div className="text-xs text-slate-400 font-mono">{org.slug}</div>
                      </td>
                      <td className="p-3 text-slate-600">{org.memberCount ?? 0}</td>
                      <td className="p-3 text-slate-600">{org.shipmentCount ?? 0}</td>
                      {summary.months?.map(month => {
                        const m = org.monthly?.[month] || {}
                        return (
                          <Fragment key={month}>
                            <td className="p-3 text-center text-slate-600">{m.ups ?? 0}</td>
                            <td className="p-3 text-center text-slate-600">{m.fedex ?? 0}</td>
                            <td className="p-3 text-center text-slate-600">{m.usps ?? 0}</td>
                            <td className="p-3 text-center text-slate-600">{m.other ?? 0}</td>
                            <td className="p-3 text-center font-medium text-slate-900">{m.total ?? 0}</td>
                          </Fragment>
                        )
                      })}
                      <td className="p-3 text-xs text-slate-500" title={org.statusCounts ? `Pending: ${org.statusCounts.pending}, Shipped: ${org.statusCounts.shipped}, In Transit: ${org.statusCounts.in_transit}, Delivered: ${org.statusCounts.delivered}, Exception: ${org.statusCounts.exception}` : ''}>
                        {statusSummary(org.statusCounts)}
                      </td>
                      <td className="p-3 text-slate-600">
                        {org.billingConfig?.model || 'unset'}
                      </td>
                      <td className="p-3 text-center">
                        <span className="text-slate-400">{expandedOrg === org.slug ? '▲' : '▼'}</span>
                      </td>
                    </tr>
                    {expandedOrg === org.slug && (
                      <tr key={`${org.slug}-editor`}>
                        <td colSpan={3 + summary.months.length * 5 + 3} className="p-0">
                          <BillingEditor
                            org={org}
                            onSave={saveBillingConfig}
                            saving={saving}
                          />
                        </td>
                      </tr>
                    )}
                    {org.error && (
                      <tr key={`${org.slug}-error`}>
                        <td colSpan={3 + summary.months.length * 5 + 3} className="p-3 text-red-600 text-sm">
                          Summary failed: {org.error}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
