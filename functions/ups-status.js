/**
 * Map UPS status type codes to our app status values.
 *
 * UPS status type codes:
 * - M  = Manifest Pickup / Order Created
 * - P  = Pickup
 * - I  = In Transit
 * - D  = Delivered
 * - X  = Exception
 * - RS = Returned to Shipper
 * - MV = Billing Information Voided
 * - DO = Delivered Origin CFS (freight)
 * - DD = Delivered Destination CFS (freight)
 */
export function mapUpsStatus(statusType) {
  if (!statusType) return null
  const type = statusType.toUpperCase().trim()

  const delivered = ['D']
  const inTransit = ['I', 'DO', 'DD']
  const exception = ['X', 'RS', 'MV']
  const shipped = ['M', 'P']

  if (delivered.includes(type)) return 'delivered'
  if (inTransit.includes(type)) return 'in_transit'
  if (exception.includes(type)) return 'exception'
  if (shipped.includes(type)) return 'shipped'
  return null
}
