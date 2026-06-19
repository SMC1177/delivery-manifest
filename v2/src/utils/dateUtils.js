// Shared Central Time (America/Chicago) date helper.
// Extracted from useDeliveries.js / useShipments.js (were byte-identical copies).
export function getCentralTimeDateString(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'America/Chicago',
    })
    const parts = formatter.formatToParts(date)
    const year = parts.find((p) => p.type === 'year').value
    const month = parts.find((p) => p.type === 'month').value
    const day = parts.find((p) => p.type === 'day').value
    return `${year}-${month}-${day}`
  } catch {
    return date.toISOString().slice(0, 10)
  }
}
