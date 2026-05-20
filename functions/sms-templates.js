/**
 * Render an SMS template by substituting {{placeholder}} markers.
 * Throws if a placeholder in the template has no matching var in `vars`.
 */
export function renderTemplate(template, vars) {
  const required = new Set()
  const PLACEHOLDER = /\{\{(\w+)\}\}/g
  let match
  while ((match = PLACEHOLDER.exec(template)) !== null) {
    required.add(match[1])
  }
  for (const name of required) {
    if (!(name in vars)) {
      throw new Error(`Missing template variable: ${name}`)
    }
  }
  return template.replace(PLACEHOLDER, (_, name) => String(vars[name]))
}

/**
 * Validate that an opt-in invite template contains the legally required
 * STOP and YES instructions. Case-insensitive substring search.
 */
export function validateOptInInvite(body) {
  if (!/yes/i.test(body)) {
    throw new Error('Opt-in invite template must contain YES instruction')
  }
  if (!/stop/i.test(body)) {
    throw new Error('Opt-in invite template must contain STOP instruction')
  }
}
