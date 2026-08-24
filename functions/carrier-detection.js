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

const CARRIER_TRACKING_URLS = {
  ups: (tn) => `https://www.ups.com/track?tracknum=${tn}`,
  usps: (tn) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`,
  fedex: (tn) => `https://www.fedex.com/fedextrack/?trknbr=${tn}`,
}

const CARRIER_LABELS = { ups: 'UPS', usps: 'USPS', fedex: 'FedEx' }

/**
 * Carrier tracking URL for a tracking number, or the bare trimmed number when
 * no carrier pattern matches — the message stays sendable and truthful rather
 * than failing or carrying a dead link (operator ruling). Blank stays blank.
 */
export function trackingUrlFor(trackingNumber) {
  if (!trackingNumber || typeof trackingNumber !== 'string') return ''
  const tn = trackingNumber.trim()
  if (!tn) return ''
  const carrier = detectCarrier(tn)
  const build = carrier && CARRIER_TRACKING_URLS[carrier]
  return build ? build(tn) : tn
}

/** Human label for the detected carrier, '' when unrecognized or blank. */
export function carrierLabel(trackingNumber) {
  if (!trackingNumber || typeof trackingNumber !== 'string') return ''
  const carrier = detectCarrier(trackingNumber.trim())
  return (carrier && CARRIER_LABELS[carrier]) || ''
}

