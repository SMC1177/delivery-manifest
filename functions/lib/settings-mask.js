// functions/lib/settings-mask.js
// Secret masking for the platform-admin settings remote-assist.
// READ path: maskSecrets() — admin UI sees that a secret IS set, never its value.
//   Arrays under secret-keyed properties have every string element masked;
//   nested objects under secret keys have all string values masked.
// WRITE path: stripMaskMarkers() — saving a masked form back cannot
//   overwrite a real stored secret with the mask string.
// Keep patterns and marker here ONLY — both callables import from this file.

export const MASK_MARKER = '•••set'

export const SECRET_FIELD_PATTERNS = [
  /secret/i, /token/i, /password/i, /api[_-]?key/i, /jwt/i, /credential/i, /private/i,
]

export function isSecretKey(key) {
  return SECRET_FIELD_PATTERNS.some(pattern => pattern.test(key))
}

function maskAllStrings(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) {
    return obj.map(item =>
      typeof item === 'string' && item.length > 0 ? MASK_MARKER
      : (item && typeof item === 'object') ? maskAllStrings(item)
      : item
    )
  }
  const result = {}
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) {
      result[key] = MASK_MARKER
    } else if (val && typeof val === 'object') {
      result[key] = maskAllStrings(val)
    } else {
      result[key] = val
    }
  }
  return result
}

export function maskSecrets(value) {
  // Handle primitives and null
  if (value === null || typeof value !== 'object') {
    return value
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const result = []
    for (const item of value) {
      result.push(maskSecrets(item))
    }
    return result
  }

  // Handle objects (including plain objects, Date, etc.)
  const result = {}
  for (const key of Object.keys(value)) {
    const val = value[key]
    if (isSecretKey(key)) {
      if (typeof val === 'string' && val.length > 0) {
        result[key] = MASK_MARKER
      } else if (Array.isArray(val)) {
        result[key] = val.map((el) =>
          typeof el === 'string' && el.length > 0 ? MASK_MARKER
          : (el && typeof el === 'object') ? maskAllStrings(el)
          : el
        )
      } else if (val && typeof val === 'object') {
        result[key] = maskAllStrings(val)
      } else {
        result[key] = val
      }
    } else {
      result[key] = maskSecrets(val)
    }
  }
  return result
}

export function stripMaskMarkers(value) {
  // Handle primitives and null
  if (value === null || typeof value !== 'object') {
    return value
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const result = []
    for (const item of value) {
      const stripped = stripMaskMarkers(item)
      // Keep non-marker items; if item is an object, it's already recursed
      if (stripped !== MASK_MARKER) {
        result.push(stripped)
      }
    }
    return result
  }

  // Handle objects
  const result = {}
  for (const key of Object.keys(value)) {
    const val = value[key]
    if (val === MASK_MARKER) {
      // Skip this property entirely
      continue
    }
    result[key] = stripMaskMarkers(val)
  }
  return result
}
