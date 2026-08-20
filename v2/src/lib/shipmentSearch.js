/**
 * Client-side shipment search.
 *
 * Split out of DashboardPage's filter for two reasons: the behaviour becomes
 * assertable on its own, and the expensive half can run once per SHIPMENT
 * instead of once per keystroke. The haystack is a function of the shipment
 * alone; only the cheap includes() depends on what was typed.
 */

/**
 * Below this many characters the search does not filter at all.
 *
 * The first one or two characters match nearly every row, so they pay for a
 * full scan and then render the largest possible result set — the worst case
 * on both axes at once. Waiting for the third character costs nothing and
 * skips exactly the queries that cannot be useful.
 */
export const MIN_SEARCH_CHARS = 3

/**
 * Build the lowercased text a shipment is searched against.
 *
 * Depends on the SHIPMENT ONLY, never on the query — which is what makes it
 * safe to compute once per row and reuse across every keystroke.
 */
export function buildSearchHaystack(shipment) {
  if (!shipment) return ''
  const rx = Array.isArray(shipment.rxNumbers) ? shipment.rxNumbers : []
  return [shipment.patientName, shipment.address, shipment.trackingNumber, ...rx]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * True when a row should be shown for this query.
 *
 * A query shorter than MIN_SEARCH_CHARS matches EVERYTHING rather than
 * nothing: typing the first letter must never blank the table.
 */
export function matchesSearchQuery(haystack, query) {
  const q = (query || '').trim().toLowerCase()
  if (q.length < MIN_SEARCH_CHARS) return true
  return (haystack || '').includes(q)
}
