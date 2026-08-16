/**
 * Render an SMS template by substituting {{placeholder}} markers.
 * Throws if a placeholder in the template has no matching var in `vars`.
 */
/**
 * The placeholder names a template may reference.
 *
 * KEEP IN SYNC with the vars object built in sms-send.js - that object is what
 * renderTemplate actually receives at send time, so a name listed here but not
 * supplied there would pass validation and then fail mid-send.
 */
export const TEMPLATE_VARS = ['pharmacyName', 'patientName', 'pharmacyPhone', 'prescriptionCount']

/**
 * Validate that a template only references known placeholders.
 * Throws naming every unknown placeholder; returns nothing on success.
 *
 * Exists so a bad template is rejected when it is SAVED rather than at the
 * moment the app tries to text a patient.
 */
export function validateTemplatePlaceholders(body) {
  if (typeof body !== 'string' || body.length === 0) return
  // Declared locally: a shared /g regex carries lastIndex between calls.
  const PLACEHOLDER = /\{\{(\w+)\}\}/g
  const unknown = new Set()
  let match
  while ((match = PLACEHOLDER.exec(body)) !== null) {
    if (!TEMPLATE_VARS.includes(match[1])) {
      unknown.add(match[1])
    }
  }
  if (unknown.size > 0) {
    const names = [...unknown].map((n) => `{{${n}}}`).join(', ')
    throw new Error(
      `Unknown template placeholder: ${names}. Allowed: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')}`
    )
  }
}

export class NoTemplateFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoTemplateFoundError'
  }
}

export function resolveTemplate({ language, templateKey, settings, patientLanguage }) {
  // w8-6 language resolution: patient override → org default → legacy English.
  const byLang = settings?.templatesByLang || {}
  if (patientLanguage && byLang[patientLanguage]?.[templateKey]) return byLang[patientLanguage][templateKey]
  const orgLang = language || settings?.defaultLanguage || settings?.language || 'en'
  if (orgLang && byLang[orgLang]?.[templateKey]) return byLang[orgLang][templateKey]
  const legacy = settings?.templates?.[templateKey]
  if (legacy) return legacy
  throw new NoTemplateFoundError(`unknown template "${templateKey}" for language "${orgLang}" (patient "${patientLanguage || 'none'}")`)
}

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
