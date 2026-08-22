import { getFunctions, httpsCallable } from 'firebase/functions'

export const STAFF_LIFECYCLE_CALLABLES = Object.freeze({
  resendStaffInvite: 'resendStaffInvite',
  removeStaffAccount: 'removeStaffAccount',
  linkExistingStaff: 'linkExistingStaff',
})

function invoke(name, args) {
  const callable = httpsCallable(getFunctions(), name)
  return callable(args).then((result) => result.data)
}

export function resendStaffInvite(slug, memberId) {
  return invoke(STAFF_LIFECYCLE_CALLABLES.resendStaffInvite, { slug, memberId })
}

export function removeStaffAccount(slug, memberId) {
  return invoke(STAFF_LIFECYCLE_CALLABLES.removeStaffAccount, { slug, memberId })
}

export function linkExistingStaff(slug, email, name, role) {
  return invoke(STAFF_LIFECYCLE_CALLABLES.linkExistingStaff, { slug, email, name, role })
}
