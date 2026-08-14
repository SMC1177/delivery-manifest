import { TEMPLATE_VARS } from '../sms-templates.js'

/**
 * Batched-message variables.
 *
 * The collapse itself already happened: the queue keys ONE document per tracking
 * number and accumulates shipment ids onto it, so a box of prescriptions arrives
 * here as a single item. All that remains is turning that item into template
 * variables, which makes this module pure.
 *
 * TEMPLATE_VARS is an allowlist and validateTemplatePlaceholders rejects anything
 * outside it, so a template author cannot reference a drug name today. Batching
 * extends that list by exactly ONE name, and buildBatchedVars constructs its
 * result field by field rather than spreading its input — a spread is how a
 * clinical field would end up on a patient's phone.
 */
export const BATCHED_TEMPLATE_VARS = [...TEMPLATE_VARS, 'prescriptionCount']

function requireVar(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`buildBatchedVars: ${name} is required`)
  }
  return String(value)
}

export function buildBatchedVars({ item, pharmacyName, patientName, pharmacyPhone }) {
  const shipmentIds = item && Array.isArray(item.shipmentIds) ? item.shipmentIds : []

  return {
    pharmacyName: requireVar(pharmacyName, 'pharmacyName'),
    patientName: requireVar(patientName, 'patientName'),
    pharmacyPhone: requireVar(pharmacyPhone, 'pharmacyPhone'),
    // A queued notification always represents a real delivery, so an item that
    // arrived without shipment ids still covers at least one prescription.
    // Rendering "your 0 prescriptions" would be worse than rounding up to the
    // one we know exists.
    prescriptionCount: Math.max(1, shipmentIds.length),
  }
}
