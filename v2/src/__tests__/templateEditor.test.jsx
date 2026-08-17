import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import TextMessagingSection from '../components/TextMessagingSection'

vi.mock('../hooks/useTextMessagingSettings', () => ({ useTextMessagingSettings: vi.fn() }))
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(),
}))

import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'

const save = vi.fn()

const TEMPLATES = {
  optInInvite: 'Reply YES to get delivery updates. Reply STOP to opt out.',
  optInConfirm: 'Thanks! You are now subscribed.',
  optOutConfirm: 'You are now unsubscribed.',
  nonKeywordRedirect: 'This number is for delivery updates only.',
  outForDelivery: 'Your prescription is out for delivery today.',
  delivered: 'Your prescription has been delivered.',
  addressIssue: 'There is an issue with your delivery address.',
}

function mockSettings(overrides = {}) {
  useTextMessagingSettings.mockReturnValue({
    data: { enabled: true, optInPolicy: 'double_opt_in', templates: TEMPLATES, ...overrides },
    loading: false,
    save,
  })
}

function renderSection() {
  return render(
    <TextMessagingSection
      slug="acme"
      enabledFields={['phone']}
      addToast={vi.fn()}
      logAction={vi.fn()}
      currentUid="uid-1"
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettings()
})

describe('<TextMessagingSection /> template editor', () => {
  it('does not write on keystrokes — typing several characters calls save zero times (write-storm guard)', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    fireEvent.focus(invite)
    // Simulate an operator typing a phrase one character at a time.
    fireEvent.change(invite, { target: { value: 'Reply YES to get delivery updates. Reply STOP to opt out. ' } })
    fireEvent.change(invite, { target: { value: 'Reply YES to get delivery updates. Reply STOP to opt out. N' } })
    fireEvent.change(invite, { target: { value: 'Reply YES to get delivery updates. Reply STOP to opt out. No' } })
    fireEvent.change(invite, { target: { value: 'Reply YES to get delivery updates. Reply STOP to opt out. Now' } })
    // No blur yet: the draft must live locally, not in Firestore or the audit log.
    expect(save).toHaveBeenCalledTimes(0)
  })

  it('blur after editing commits exactly one save with the new value under templates for that key', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    const newBody = 'Reply YES to get delivery updates. Reply STOP to opt out. Now!'
    invite.focus()
    // Blur only reaches React if the element genuinely holds focus: React 19 wires onBlur
    // to the native focusout event, which fires only from a real focus owner. Prove it.
    expect(document.activeElement).toBe(invite)
    fireEvent.change(invite, { target: { value: newBody } })
    // The draft updated while focused.
    expect(screen.getByDisplayValue(newBody)).toBeInTheDocument()
    invite.blur()
    // Leaving the field must not clobber the draft back to the stored template.
    expect(screen.getByDisplayValue(newBody)).toBeInTheDocument()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].templates.optInInvite).toBe(newBody)
  })

  it('focus-and-leave without any change does not call save', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    invite.focus()
    expect(document.activeElement).toBe(invite)
    invite.blur()
    expect(save).toHaveBeenCalledTimes(0)
  })

  it('shows an inline error naming YES when the opt-in invitation loses the word YES', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    fireEvent.focus(invite)
    fireEvent.change(invite, { target: { value: 'Reply STOP to opt out.' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/YES/)
  })

  it('shows an inline error naming STOP when the opt-in invitation loses the word STOP', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    fireEvent.focus(invite)
    fireEvent.change(invite, { target: { value: 'Reply YES to get delivery updates.' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/STOP/)
  })

  it('accepts lowercase yes and stop — the UI must not be stricter than the server rule', () => {
    renderSection()
    const invite = screen.getByDisplayValue(TEMPLATES.optInInvite)
    fireEvent.focus(invite)
    fireEvent.change(invite, { target: { value: 'reply yes to get delivery updates. reply stop to opt out.' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not invent the YES/STOP requirement for other templates', () => {
    renderSection()
    const delivered = screen.getByDisplayValue(TEMPLATES.delivered)
    fireEvent.focus(delivered)
    fireEvent.change(delivered, { target: { value: 'Your order is on its way to you.' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // ---- SLICE 3 additions: EN + one language editor ----
  it('shows a language toggle with English and a second language (es/fr)', () => {
    renderSection()
    expect(screen.getByRole('button', { name: /English/i })).toBeInTheDocument()
    // second-language selector exists (es by default)
    expect(screen.getByRole('button', { name: /Spanish/i })).toBeInTheDocument()
  })

  it('selecting the second language shows a second input per template row', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    // EN input still present; a Spanish optInInvite input appears (empty or draft)
    expect(screen.getByDisplayValue(TEMPLATES.optInInvite)).toBeInTheDocument()
    expect(screen.getByLabelText(/Spanish.*Opt-in invitation/i)).toBeInTheDocument()
  })

  it('editing the second-language input commits to templatesByLang on blur, not templates', () => {
    mockSettings({ templatesByLang: { es: {} } })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    const esInvite = screen.getByLabelText(/Spanish.*Opt-in invitation/i)
    esInvite.focus()
    expect(document.activeElement).toBe(esInvite)
    fireEvent.change(esInvite, { target: { value: '¡Hola de {{pharmacyName}}! Responde SÍ para recibir actualizaciones.' } })
    esInvite.blur()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].templatesByLang.es.optInInvite).toContain('¡Hola de')
  })

  it('never auto-saves a draft — the draft is shown only via an explicit use-draft action', () => {
    mockSettings({ templatesByLang: { es: {} } })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    // Draft text is NOT in the input until the operator clicks "Use draft";
    // scope the button to the opt-in invitation row (every row shows one).
    const esInvite = screen.getByLabelText(/Spanish.*Opt-in invitation/i)
    expect(esInvite.value).toBe('')
    const row = esInvite.closest('div')
    const useDraftButton = within(row).getByRole('button', { name: /use draft/i })
    fireEvent.click(useDraftButton)
    // Re-query after the state update commits (the pre-click reference can be stale)
    expect(screen.getByLabelText(/Spanish.*Opt-in invitation/i).value.length).toBeGreaterThan(0)
    // No save happened from merely revealing the draft
    expect(save).toHaveBeenCalledTimes(0)
  })
})
