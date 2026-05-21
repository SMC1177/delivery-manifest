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
      desc.includes('rts')
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
