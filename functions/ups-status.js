/**
 * Map UPS status context to our app status values.
 *
 * Accepts { type, code, description } from the UPS REST API package object.
 *
 * Priority order:
 * 1. Letter type codes (most reliable — UPS enumerates these precisely)
 * 2. Description substring matching (fallback when type is absent, e.g. code=005)
 * 3. Stable numeric codes (non-overloaded only)
 * 4. null — unknown, sync pipeline preserves existing Firestore status
 *
 * UPS letter codes (type field):
 * - D  = Delivered
 * - I  = In Transit
 * - O  = Out for Delivery
 * - X  = Exception
 * - RS = Returned to Shipper
 * - MV = Billing Information Voided
 * - DO = Delivered Origin CFS (freight — in transit, not final delivery)
 * - DD = Delivered Destination CFS (freight — in transit, not final delivery)
 * - M  = Manifest/Label Created
 * - P  = Pickup
 *
 * UPS REST API v1 numeric statusCode values:
 * - 002 = In Transit
 * - 003 = Delivered
 * - 004 = Out for Delivery
 * - 005 = Overloaded — used for delivered, returning, in-transit, and exception events
 * - 006 = Pickup / Origin Scan
 * - 007 = Label Created / Void
 */
export function mapUpsStatus(status) {
  if (!status) return null
  const { type, code, description } = status
  const letterCode = (type || '').toUpperCase().trim()
  const numericCode = (code || '').trim()
  const desc = (description || '').toLowerCase().trim()

  // 1. Letter type codes — check FIRST, they are the most reliable UPS signal
  if (letterCode === 'D') return 'delivered'
  if (letterCode === 'I' || letterCode === 'O') return 'in_transit'
  if (letterCode === 'DO' || letterCode === 'DD') return 'in_transit'  // freight CFS, not final delivery
  if (letterCode === 'X' || letterCode === 'RS' || letterCode === 'MV') return 'exception'
  if (letterCode === 'M' || letterCode === 'P') return 'shipped'

  // 2. Description matching — only reached when type is absent (e.g. currentStatus has no type field)
  if (desc) {
    // Return to sender/shipper — check before generic 'delivered' to avoid false positives
    if (
      desc.includes('return to sender') ||
      desc.includes('returned to sender') ||
      desc.includes('returning to sender') ||
      desc.includes('return to shipper') ||
      desc.includes('returned to shipper') ||
      /\brts\b/.test(desc)
    ) return 'exception'

    if (desc.includes('delivered') || desc.includes('left at')) return 'delivered'

    if (
      desc.includes('exception') ||
      desc.includes('delay') ||
      desc.includes('attempted') ||
      desc.includes('receiver was not available') ||
      desc.includes('held at access point') ||
      desc.includes('disposed') ||
      desc.includes('non-delivery')
    ) return 'exception'

    if (
      desc.includes('out for delivery') ||
      desc.includes('loaded on delivery vehicle') ||
      desc.includes('delivery today') ||
      desc.includes('on the way')
    ) return 'in_transit'

    if (
      desc.includes('in transit') ||
      desc.includes('departed') ||
      desc.includes('arrived at') ||
      desc.includes('origin scan') ||
      desc.includes('carrier pickup') ||
      desc.includes('at facility')
    ) return 'in_transit'

    if (
      desc.includes('label created') ||
      desc.includes('shipment ready for ups') ||
      desc.includes('order processed') ||
      desc.includes('manifest')
    ) return 'shipped'
  }

  // 3. Stable numeric codes (non-overloaded only — 005 is excluded, it's ambiguous)
  if (numericCode === '003') return 'delivered'
  if (numericCode === '002' || numericCode === '004') return 'in_transit'
  if (numericCode === '006' || numericCode === '007') return 'shipped'

  return null
}

/**
 * Derive the best status context from a UPS API package object.
 *
 * Prefers the newest activity scan's status over `currentStatus`, because
 * UPS sometimes returns a stale `currentStatus` from a prior/reused tracking
 * number. Sorts activity entries newest-first by concatenated date+time.
 *
 * @param {object} pkg  UPS package object with shape { currentStatus, activity }
 * @returns {{ type: string|null, code: string|null, description: string|null }}
 */
export function deriveUpsStatusContext(pkg) {
  if (!pkg) return { type: null, code: null, description: null }

  const activity = Array.isArray(pkg.activity) ? pkg.activity : []

  // Sort newest-first by concatenated date+time
  const sorted = [...activity].sort(
    (a, b) =>
      (`${b.date || ''}${b.time || ''}`).localeCompare(
        `${a.date || ''}${a.time || ''}`
      )
  )

  const latest = sorted[0]

  // Prefer latest activity.status over currentStatus
  const src = latest?.status || pkg.currentStatus || null

  const description =
    src?.description ||
    latest?.description ||
    pkg.currentStatus?.description ||
    null

  return {
    type: src?.type || null,
    code: src?.code || null,
    description
  }
}

/**
 * Detect a stale/reused-tracking-number "delivered" event.
 *
 * Returns true when the delivery calendar day is STRICTLY BEFORE the
 * shipment's creation calendar day — implying a prior tracking record,
 * not the current shipment. Same-day or later delivery returns false.
 *
 * @param {string|Date|null|undefined} deliveryDate  'YYYYMMDD' string, Date, or falsy
 * @param {*} createdAt  Firestore Timestamp, { _seconds }, Date, ISO string, or falsy
 * @returns {boolean}
 */
export function isStaleDelivery(deliveryDate, createdAt) {
  // --- Normalize deliveryDate to a UTC Date at midnight ---
  let dd = null
  if (deliveryDate instanceof Date) {
    dd = new Date(Date.UTC(
      deliveryDate.getUTCFullYear(),
      deliveryDate.getUTCMonth(),
      deliveryDate.getUTCDate()
    ))
  } else if (typeof deliveryDate === 'string' && /^\d{8}$/.test(deliveryDate)) {
    const y = +deliveryDate.slice(0, 4)
    const m = +deliveryDate.slice(4, 6) - 1
    const d = +deliveryDate.slice(6, 8)
    dd = new Date(Date.UTC(y, m, d))
  }
  if (!dd || isNaN(dd.getTime())) return false

  // --- Normalize createdAt to a UTC Date at midnight ---
  let ca = null
  if (createdAt instanceof Date) {
    ca = createdAt
  } else if (createdAt && typeof createdAt.toDate === 'function') {
    // Firestore Timestamp
    ca = createdAt.toDate()
  } else if (createdAt && typeof createdAt._seconds === 'number') {
    ca = new Date(createdAt._seconds * 1000)
  } else if (typeof createdAt === 'string') {
    ca = new Date(createdAt)
  }
  if (!ca || isNaN(ca.getTime())) return false

  // Compare at DAY granularity (UTC midnight)
  const caDay = new Date(Date.UTC(
    ca.getUTCFullYear(),
    ca.getUTCMonth(),
    ca.getUTCDate()
  ))

  return dd.getTime() < caDay.getTime()
}
