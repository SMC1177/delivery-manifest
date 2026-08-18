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


  // ---- FINAL ITEM: org-default language dropdown (w8-6 follow-up) ----
  it('shows a Default message language dropdown defaulting to English', () => {
    renderSection()
    const select = screen.getByLabelText(/default message language/i)
    expect(select).toBeInTheDocument()
    expect(select.value).toBe('en')
  })

  it('reflects a stored defaultLanguage', () => {
    mockSettings({ defaultLanguage: 'es' })
    renderSection()
    expect(screen.getByLabelText(/default message language/i).value).toBe('es')
  })

  it('commits the chosen language to settings.defaultLanguage via save', () => {
    renderSection()
    const select = screen.getByLabelText(/default message language/i)
    fireEvent.change(select, { target: { value: 'fr' } })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultLanguage: 'fr' }))
  })
})
describe('<TextMessagingSection /> second-language save is visible', () => {
  it('typing in the second-language input alone does not write (write-storm guard, es path)', () => {
    mockSettings({ templatesByLang: { es: {} } })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    const esInvite = screen.getByLabelText(/Spanish.*Opt-in invitation/i)
    fireEvent.focus(esInvite)
    fireEvent.change(esInvite, { target: { value: 'Responde S' } })
    fireEvent.change(esInvite, { target: { value: 'Responde SI' } })
    fireEvent.change(esInvite, { target: { value: 'Responde SI para' } })
    // No blur and no Save click: the draft must live locally, exactly as the
    // English path does since 9ccae098.
    expect(save).toHaveBeenCalledTimes(0)
  })

  // THE BUG. An operator has no way to know their translation was kept. There is
  // no Save control, and the only writer fires on blur of a field the Use draft
  // button filled for them - so the gesture nobody performs is the only one that
  // persists. Approving a translation must be an explicit act with visible
  // confirmation, because code is invisible to the person using the screen.
  it('an explicit Save control persists the second-language template and confirms it to the operator', async () => {
    const addToast = vi.fn()
    mockSettings({ templatesByLang: { es: {} } })
    render(
      <TextMessagingSection
        slug="acme"
        enabledFields={['phone']}
        addToast={addToast}
        logAction={vi.fn()}
        currentUid="uid-1"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    const esInvite = screen.getByLabelText(/Spanish.*Opt-in invitation/i)
    fireEvent.change(esInvite, { target: { value: 'Responde SI para recibir actualizaciones.' } })

    const row = esInvite.closest('div')
    const saveButton = within(row).getByRole('button', { name: /save/i })
    expect(saveButton).toBeTruthy()

    fireEvent.click(saveButton)
    await Promise.resolve()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].templatesByLang.es.optInInvite).toContain('Responde SI')

    // The operator must SEE that it saved - a silent success is the defect.
    expect(addToast).toHaveBeenCalled()
    const toastText = addToast.mock.calls.map((c) => String(c[0])).join(' ')
    expect(toastText).toMatch(/saved/i)
  })
})

describe('<TextMessagingSection /> second-language save confirms on the real gesture', () => {
  // A mouse click on Save fires focusout on the textarea BEFORE the click lands,
  // so the blur path commits first. If the confirmation is tied to whether the
  // button handler did the write, the operator sees nothing - the original defect,
  // reproduced by its own fix and invisible to a green suite.
  it('confirms to the operator when blur commits first, as a real click does', async () => {
    const addToast = vi.fn()
    mockSettings({ templatesByLang: { es: {} } })
    render(
      <TextMessagingSection
        slug="acme"
        enabledFields={['phone']}
        addToast={addToast}
        logAction={vi.fn()}
        currentUid="uid-1"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Spanish/i }))
    const esInvite = screen.getByLabelText(/Spanish.*Opt-in invitation/i)
    fireEvent.focus(esInvite)
    fireEvent.change(esInvite, { target: { value: 'Responde SI para recibir actualizaciones.' } })

    // The browser blurs the field before the click reaches the button.
    fireEvent.blur(esInvite)
    await Promise.resolve()

    // Exactly one write, whichever path performed it.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].templatesByLang.es.optInInvite).toContain('Responde SI')

    // And the operator must SEE it, because a save they cannot observe is
    // indistinguishable from one that never happened.
    expect(addToast).toHaveBeenCalled()
    const toastText = addToast.mock.calls.map((c) => String(c[0])).join(' ')
    expect(toastText).toMatch(/saved/i)
  })
})
