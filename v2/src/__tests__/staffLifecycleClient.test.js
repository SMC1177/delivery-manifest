// v2/src/__tests__/staffLifecycleClient.test.js
// RED-FIRST contract for the staff-lifecycle wire-up (u0-red-wire-contract).
//
// HALF 1 — the client side: every wrapper must call httpsCallable with a name
// TAKEN FROM STAFF_LIFECYCLE_CALLABLES (never a retyped literal), forward the
// payload keys the deployed callables actually read, return res.data, and
// rethrow rejections with the server's HttpsError message (and code) intact.
//
// HALF 2 — the deployable side (the LOAD-BEARING half): every test below mocks
// httpsCallable, so it can only ever assert the string the author typed — a
// client calling 'resendInvite' against a deployed 'resendStaffInvite' passes
// every mocked test and 404s for a real admin on click. Reading functions/index.js
// from disk (same readFileSync + resolve + fileURLToPath idiom as
// functions/__tests__/index-compat.test.js) is what turns that typo into a
// test-time failure instead of a production not-found.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(),
}))

import { httpsCallable } from 'firebase/functions'
import {
  STAFF_LIFECYCLE_CALLABLES,
  resendStaffInvite,
  removeStaffAccount,
  linkExistingStaff,
} from '../utils/staffLifecycleClient'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SLUG = 'acme'
const MEMBER_ID = 'member-9f2c'
const EMAIL = 'nurse@acme.example'
const NAME = 'Avery Nurse'
const ROLE = 'nurse'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('staffLifecycleClient wrappers — HALF 1 (client side)', () => {
  // Wrapper contract, matching the deployed callables in functions/staff-lifecycle.js
  // (committed in 9277b31b):
  //   resendStaffInvite(slug, memberId)  -> call({ slug, memberId })  -> { email, link }
  //   removeStaffAccount(slug, memberId) -> call({ slug, memberId })  -> { success }
  //   linkExistingStaff(slug, email, name, role) -> call({ slug, email, name, role }) -> { success }
  // Each wrapper creates its callable per invocation with
  // httpsCallable(getFunctions(), NAME) — the SendTextModal.jsx / useAdminData.js
  // convention — so a test can point httpsCallable at a fresh call mock.
  const cases = [
    {
      wrapper: resendStaffInvite,
      key: 'resendStaffInvite',
      args: [SLUG, MEMBER_ID],
      payload: { slug: SLUG, memberId: MEMBER_ID },
      data: { email: EMAIL, link: 'https://verify.example/abc123' },
    },
    {
      wrapper: removeStaffAccount,
      key: 'removeStaffAccount',
      args: [SLUG, MEMBER_ID],
      payload: { slug: SLUG, memberId: MEMBER_ID },
      data: { success: true },
    },
    {
      wrapper: linkExistingStaff,
      key: 'linkExistingStaff',
      args: [SLUG, EMAIL, NAME, ROLE],
      payload: { slug: SLUG, email: EMAIL, name: NAME, role: ROLE },
      data: { success: true },
    },
  ]

  for (const { wrapper, key, args, payload, data } of cases) {
    it(`${key} calls httpsCallable with the name from STAFF_LIFECYCLE_CALLABLES and forwards the deployed payload`, async () => {
      const call = vi.fn().mockResolvedValue({ data })
      httpsCallable.mockReturnValue(call)

      const result = await wrapper(...args)

      // The name is taken FROM THE CONSTANT, not a literal retyped here: if the
      // test and the client can never disagree, a rename has to change both.
      expect(httpsCallable).toHaveBeenCalledWith(
        expect.anything(),
        STAFF_LIFECYCLE_CALLABLES[key],
      )
      // Exact payload object — a wrapper sending { orgSlug } instead of { slug }
      // fails right here, before any admin clicks anything.
      expect(call).toHaveBeenCalledWith(payload)
      expect(result).toEqual(data)
    })

    it(`${key} rethrows a rejected callable with the server message verbatim`, async () => {
      const serverErr = new Error('Cannot remove the last remaining admin of the organization')
      serverErr.code = 'functions/failed-precondition'
      const call = vi.fn().mockRejectedValue(serverErr)
      httpsCallable.mockReturnValue(call)

      const caught = await wrapper(...args).then(
        () => { throw new Error('wrapper swallowed the callable rejection') },
        (e) => e,
      )

      // Refusals like the last-admin guard are text an admin must read; the code
      // is what lets the UI tell not-found from permission-denied. Both must
      // survive the trip through the wrapper untouched.
      expect(caught.message).toBe('Cannot remove the last remaining admin of the organization')
      expect(caught.code).toBe('functions/failed-precondition')
    })
  }

  it('STAFF_LIFECYCLE_CALLABLES is frozen and names exactly the three deployed callables', () => {
    expect(Object.isFrozen(STAFF_LIFECYCLE_CALLABLES)).toBe(true)
    expect(Object.keys(STAFF_LIFECYCLE_CALLABLES)).toEqual([
      'resendStaffInvite',
      'removeStaffAccount',
      'linkExistingStaff',
    ])
  })
})

describe('staffLifecycleClient — HALF 2 (deployable surface)', () => {
  // Load-bearing: functions/index.js is the deployable truth, and it is read from
  // disk (never imported — importing it would register every trigger in the project
  // and pull in Firebase Admin). This guards the failure no unit test can see,
  // because the mock has no deployment requirement: every wrapper test above mocks
  // httpsCallable, so a client pointing at a callable that does not exist passes
  // green and a real admin gets not-found on click.
  const indexJs = readFileSync(resolve(__dirname, '../../../functions/index.js'), 'utf8')
  const lifecycleJs = readFileSync(
    resolve(__dirname, '../../../functions/staff-lifecycle.js'),
    'utf8',
  )

  it('every STAFF_LIFECYCLE_CALLABLES value appears in functions/index.js export statements', () => {
    for (const [key, deployedName] of Object.entries(STAFF_LIFECYCLE_CALLABLES)) {
      expect(
        indexJs,
        `STAFF_LIFECYCLE_CALLABLES.${key} is "${deployedName}" but functions/index.js does not ` +
          `export that name. No mocked httpsCallable test can catch this — a wrapper calling a ` +
          `name the deployment does not export passes every test here and 404s for a real admin ` +
          `on click. Fix the constant (or the deployment) so the two agree.`,
      ).toContain(deployedName)
    }
  })

  it('the deployed callables read exactly the payload keys the wrappers forward', () => {
    // Same blindness applies to payload keys: a client sending { orgSlug } to a
    // callable reading { slug } passes every mocked test and fails live. Pin the
    // destructuring the deployed callables actually do.
    expect(lifecycleJs).toContain('const { slug, memberId } = request.data')
    expect(lifecycleJs).toContain('const { slug, email, name, role } = request.data')
  })
})
