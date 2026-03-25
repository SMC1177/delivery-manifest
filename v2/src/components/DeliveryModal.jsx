import { useState, useEffect } from 'react'

const emptyForm = {
  patientName: '',
  address: '',
  phone: '',
  rxNumbers: '',
  trackingNumber: '',
  status: 'pending',
  notes: '',
}

export default function DeliveryModal({ isOpen, onClose, onSubmit, delivery }) {
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const isEdit = !!delivery

  useEffect(() => {
    if (delivery) {
      setForm({
        patientName: delivery.patientName || '',
        address: delivery.address || '',
        phone: delivery.phone || '',
        rxNumbers: Array.isArray(delivery.rxNumbers) ? delivery.rxNumbers.join(', ') : '',
        trackingNumber: delivery.trackingNumber || '',
        status: delivery.status || 'pending',
        notes: delivery.notes || '',
      })
    } else {
      setForm(emptyForm)
    }
  }, [delivery, isOpen])

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
          {isEdit ? 'Edit Delivery' : 'Add New Delivery'}
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

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
            <input
              name="address"
              value={form.address}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

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

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              RX Numbers <span className="text-slate-400 font-normal">(comma-separated)</span>
            </label>
            <input
              name="rxNumbers"
              value={form.rxNumbers}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="RX001, RX002"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Number</label>
            <input
              name="trackingNumber"
              value={form.trackingNumber}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="1Z999AA..."
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
              <option value="out">Out for Delivery</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
            </select>
          </div>

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
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Add Delivery'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
