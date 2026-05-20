/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX).
 * Throws if input cannot be normalized to a valid 10-digit US number.
 */
export function normalizePhone(input) {
  if (input === null || input === undefined || input === '') {
    throw new Error('Invalid phone: empty')
  }
  const str = String(input).trim()

  if (str.startsWith('+') && !str.startsWith('+1')) {
    throw new Error('Invalid phone: only US numbers supported in v1')
  }

  const digits = str.replace(/[^\d]/g, '')

  let tenDigits
  if (digits.length === 10) {
    tenDigits = digits
  } else if (digits.length === 11 && digits.startsWith('1')) {
    tenDigits = digits.slice(1)
  } else {
    throw new Error(`Invalid phone: expected 10 digits, got "${str}"`)
  }

  if (!/^\d{10}$/.test(tenDigits)) {
    throw new Error(`Invalid phone: "${str}"`)
  }

  return '+1' + tenDigits
}

/**
 * Mask a phone number for audit logs: +12815550123 → ***-***-0123
 */
export function maskPhone(e164) {
  if (typeof e164 !== 'string' || e164.length < 4) return '***'
  return '***-***-' + e164.slice(-4)
}
