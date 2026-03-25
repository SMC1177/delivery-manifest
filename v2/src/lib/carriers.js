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
]
