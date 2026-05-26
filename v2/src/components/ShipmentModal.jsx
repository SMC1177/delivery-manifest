import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useOrgSettings } from '../hooks/useOrgSettings'
import { CARRIER_OPTIONS, getCarrierName } from '../lib/carriers'

const emptyForm = {
  patientName: '',
  address: '',
  phone: '',
  dob: '',
  rxNumbers: '',
  trackingNumber: '',
  carrier: 'ups',
  status: 'pending',
  notes: '',
}

export default function ShipmentModal({ isOpen, onClose, onSubmit, shipment }) {
  const { orgSlug } = useAuth()
  const { isFieldEnabled } = useOrgSettings(orgSlug)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const isEdit = !!shipment

  useEffect(() => {
    if (shipment) {
      setForm({
        patientName: shipment.patientName || '',
        address: shipment.address || '',
        phone: shipment.phone || '',
        dob: shipment.dob || '',
        rxNumbers: Array.isArray(shipment.rxNumbers) ? shipment.rxNumbers.join(', ') : '',
        trackingNumber: shipment.trackingNumber || '',
        carrier: shipment.carrier || 'ups',
        status: shipment.status || 'pending',
        notes: shipment.notes || '',
      })
    } else {
      setForm(emptyForm)
    }
  }, [shipment, isOpen])

  if (!isOpen) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSubmit({
        ...form,
        rxNumbers: form.rxNumbers
          .split(',')
          .map((rx) => rx.trim())
          .filter(Boolean),
      })
      onClose()
    } catch (err) {
      console.error(err)
      window.alert(`Save failed: ${err.message || 'Unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900 mb-4">
          {isEdit ? 'Edit Shipment' : 'Add New Shipment'}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Patient Name *</label>
            <input
              name="patientName"
              required
              value={form.patientName}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {isFieldEnabled('address') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
              <input
                name="address"
                value={form.address}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          {isFieldEnabled('phone') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
              <input
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          {isFieldEnabled('dob') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date of Birth</label>
              <input
                name="dob"
                type="date"
                value={form.dob}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Rx Numbers <span className="text-slate-400 font-normal">(comma-separated)</span>
            </label>
            <input
              name="rxNumbers"
              value={form.rxNumbers}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="RX001, RX002"
            />
          </div>

          {isFieldEnabled('carrier') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Carrier</label>
              <select
                name="carrier"
                value={form.carrier}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {CARRIER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {getCarrierName(form.carrier)} Tracking Number
            </label>
            <input
              name="trackingNumber"
              value={form.trackingNumber}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder={form.carrier === 'fedex' ? '7489...' : form.carrier === 'usps' ? '9400...' : '1Z999AA...'}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
            <select
              name="status"
              value={form.status}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="pending">Pending</option>
              <option value="shipped">Shipped</option>
              <option value="in_transit">In Transit</option>
              <option value="delivered">Delivered</option>
              <option value="exception">Exception</option>
            </select>
          </div>

          {isFieldEnabled('notes') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <textarea
                name="notes"
                value={form.notes}
                onChange={handleChange}
                rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Add Shipment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
