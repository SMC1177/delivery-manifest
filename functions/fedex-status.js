/**
 * Map FedEx status codes to our app status values.
 *
 * FedEx status codes reference:
 * - DL = Delivered
 * - IT = In Transit, IX = In Transit (international), OD = Out for Delivery
 * - AR = Arrived at facility, DP = Departed facility, PU = Picked Up
 * - DE = Delivery Exception, CA = Cancelled, SE = Shipment Exception
 * - HP = Hold at location, RS = Return to Shipper
 * - PX = Picked up (pre-shipment), OC = Order Created, SH = Shipped
 */
export function mapFedExStatus(statusCode) {
  if (!statusCode) return null
  const code = statusCode.toUpperCase()
  const delivered = ['DL']
  const inTransit = ['IT', 'IX', 'OD', 'AR', 'DP', 'PU']
  const exception = ['DE', 'CA', 'SE', 'HP', 'RS']
  const shipped = ['PX', 'OC', 'SH']

  if (delivered.includes(code)) return 'delivered'
  if (inTransit.includes(code)) return 'in_transit'
  if (exception.includes(code)) return 'exception'
  if (shipped.includes(code)) return 'shipped'
  return null
}
