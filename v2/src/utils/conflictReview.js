// Pure conflict-review utilities for the curation layer of import conflicts.
// Identity fields ONLY (address/phone/patientName/dob) are compared; decisions
// are recorded but NEVER applied to shipment docs. No Firestore access, no
// mutation of inputs. Patient key = normalized (trim + lowercase) patient name.
import { normalizePatientKey } from './patientGrouping'

export const IDENTITY_FIELDS = ['address', 'phone', 'patientName', 'dob']

// Comparison helper: missing values are treated as ''.
const norm = (value) => (value == null ? '' : value)

// Build the last-accepted identity map from incoming rows (first import).
// Keyed by normalized patient name; missing identity fields stored as ''.
export function seedLastAccepted(incoming) {
  const seeded = {}
  for (const row of incoming) {
    const key = normalizePatientKey(row.patientName)
    const identity = {}
    for (const field of IDENTITY_FIELDS) {
      identity[field] = norm(row[field])
    }
    seeded[key] = identity
  }
  return seeded
}

// Compare incoming rows against the stored last-accepted identity and flag any
// identity field that differs. Empty array when identical or no lastAccepted
// exists for that patient key yet.
export function diffFlaggedRows({ incoming, lastAccepted }) {
  const flags = []
  for (const row of incoming) {
    const key = normalizePatientKey(row.patientName)
    const accepted = lastAccepted[key]
    if (!accepted) continue
    for (const field of IDENTITY_FIELDS) {
      const newValue = norm(row[field])
      const oldValue = norm(accepted[field])
      if (newValue !== oldValue) {
        flags.push({ patientKey: key, field, oldValue, newValue })
      }
    }
  }
  return flags
}

// Record a decision on a conflict without mutating the input conflict object.
export function applyDecision(conflict, decision) {
  return { ...conflict, decision }
}
