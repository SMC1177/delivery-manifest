const carriers = {
  ups: {
    name: 'UPS',
    trackingUrl: (trackingNumber) =>
      `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`,
  },
  fedex: {
    name: 'FedEx',
    trackingUrl: (trackingNumber) =>
      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`,
  },
  usps: {
    name: 'USPS',
    trackingUrl: (trackingNumber) =>
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
  },
}

export function getTrackingUrl(carrier, trackingNumber) {
  const key = (carrier || '').toLowerCase()
  const c = carriers[key]
  if (!c || !trackingNumber) return null
  return c.trackingUrl(trackingNumber)
}

export function getCarrierName(carrier) {
  const key = (carrier || '').toLowerCase()
  return carriers[key]?.name || carrier
}

export const CARRIER_OPTIONS = [
  { value: 'ups', label: 'UPS' },
  { value: 'fedex', label: 'FedEx' },
  { value: 'usps', label: 'USPS' },
]

/**
 * Detect carrier from tracking number format.
 * Returns lowercase carrier key or null if unrecognized.
 *
 * Patterns:
 * - UPS: starts with "1Z" (18 alphanumeric chars)
 * - USPS: starts with "9", 20-22 digits
 * - FedEx: 12 or 15 digits
 */
export function detectCarrier(trackingNumber) {
  if (!trackingNumber || typeof trackingNumber !== 'string') return null
  const tn = trackingNumber.trim()
  if (/^1Z/i.test(tn)) return 'ups'
  if (/^9\d{19,21}$/.test(tn)) return 'usps'
  if (/^\d{12}$/.test(tn) || /^\d{15}$/.test(tn)) return 'fedex'
  return null
}
