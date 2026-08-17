// RED spec for v2/src/components/ConflictReviewModal.jsx — that component does
// NOT exist yet, so this suite must fail to load (Cannot find module ...).
// Contract: renders the flagged-row list (old vs new identity values side by
// side), per-row Keep both/original/most recent controls, saves decisions to
// organizations/{slug}/settings/conflictReview via setDoc (merge), reports
// 'N rows flagged'. PURE curation — never writes shipment docs.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { setDoc } from 'firebase/firestore'
import ConflictReviewModal from '../components/ConflictReviewModal'

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({ id: 'conflictReview' })),
  setDoc: vi.fn(() => Promise.resolve()),
  serverTimestamp: vi.fn(() => 0),
}))
vi.mock('../lib/firebase', () => ({ db: {} }))

const FLAGGED = [
  {
    patientKey: 'jane smith',
    field: 'address',
    oldValue: '123 Old St',
    newValue: '200 Maple Blvd',
  },
  {
    patientKey: 'jane smith',
    field: 'phone',
    oldValue: '+1-555-0100',
    newValue: '+1-555-0199',
  },
]

function renderModal(props = {}) {
  return render(
    <ConflictReviewModal
      slug="woodlandsrx"
      flagged={FLAGGED}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...props}
    />,
  )
}

describe('ConflictReviewModal', () => {
  it('reports N rows flagged', () => {
    renderModal()
    expect(screen.getByText(/2 rows flagged/i)).toBeInTheDocument()
  })

  it('renders old vs new identity values side by side', () => {
    renderModal()
    expect(screen.getByText('123 Old St')).toBeInTheDocument()
    expect(screen.getByText('200 Maple Blvd')).toBeInTheDocument()
    expect(screen.getByText('+1-555-0100')).toBeInTheDocument()
    expect(screen.getByText('+1-555-0199')).toBeInTheDocument()
  })

  it('offers Keep both / original / most recent per row', () => {
    renderModal()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent).filter(Boolean).join(' ')
    expect(labels).toMatch(/Keep both/i)
    expect(labels).toMatch(/Keep original/i)
    expect(labels).toMatch(/Keep most recent/i)
  })

  it('saves decisions to the conflictReview settings doc on submit', () => {
    renderModal()
    fireEvent.click(screen.getAllByText(/Keep both/i)[0])
    fireEvent.click(screen.getByRole('button', { name: /save decisions/i }))
    expect(setDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conflicts: expect.arrayContaining([
          expect.objectContaining({ decision: 'keepBoth', patientKey: 'jane smith' }),
        ]),
      }),
      expect.objectContaining({ merge: true }),
    )
  })
})
