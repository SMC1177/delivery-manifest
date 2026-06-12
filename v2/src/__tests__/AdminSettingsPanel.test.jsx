import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../hooks/useAdminData', () => ({
  useAdminData: vi.fn(),
}))

import { useAdminData } from '../hooks/useAdminData'
import AdminSettingsPanel from '../components/AdminSettingsPanel'

describe('AdminSettingsPanel', () => {
  const mockFetchOrgSettings = vi.fn()
  const mockSaveOrgSettings = vi.fn()

  const defaultMockReturn = {
    orgSettings: {},
    settingsLoading: false,
    settingsError: null,
    fetchOrgSettings: mockFetchOrgSettings,
    saveOrgSettings: mockSaveOrgSettings,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useAdminData).mockReturnValue(defaultMockReturn)
  })

  it('calls fetchOrgSettings on mount when orgSettings is empty', () => {
    render(<AdminSettingsPanel orgSlug="acme" />)
    expect(mockFetchOrgSettings).toHaveBeenCalledWith('acme')
  })

  it('renders panel with org and doc textareas when data is present', () => {
    const orgSettings = {
      acme: {
        orgSlug: 'acme',
        org: { name: 'Acme RX', enabledFields: ['phone'] },
        settingsDocs: {
          textMessaging: {
            optInPolicy: 'double_opt_in',
            webhookToken: '•••set',
          },
        },
      },
    }
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      orgSettings,
    })
    render(<AdminSettingsPanel orgSlug="acme" />)

    expect(screen.getByTestId('admin-settings-panel-acme')).toBeInTheDocument()
    const orgTextarea = screen.getByTestId('admin-settings-doc-org')
    expect(orgTextarea).toBeInTheDocument()
    expect(orgTextarea.value).toContain('Acme RX')

    const docTextarea = screen.getByTestId('admin-settings-doc-textMessaging')
    expect(docTextarea).toBeInTheDocument()
    expect(docTextarea.value).toContain('•••set')
    expect(docTextarea.value).toContain('double_opt_in')
  })

  it('disables save button when reason is empty, enables after reason entered', () => {
    const orgSettings = {
      acme: {
        orgSlug: 'acme',
        org: { name: 'Acme RX', enabledFields: ['phone'] },
        settingsDocs: {
          textMessaging: {
            optInPolicy: 'double_opt_in',
            webhookToken: '•••set',
          },
        },
      },
    }
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      orgSettings,
    })
    render(<AdminSettingsPanel orgSlug="acme" />)

    const saveButton = screen.getByTestId('admin-settings-save-acme-textMessaging')
    expect(saveButton).toBeDisabled()

    const reasonInput = screen.getByTestId('admin-settings-reason-acme')
    fireEvent.change(reasonInput, { target: { value: 'fixing opt-in policy' } })
    expect(saveButton).not.toBeDisabled()
  })

  it('shows inline error and does not call saveOrgSettings for invalid JSON', () => {
    const orgSettings = {
      acme: {
        orgSlug: 'acme',
        org: { name: 'Acme RX', enabledFields: ['phone'] },
        settingsDocs: {
          textMessaging: {
            optInPolicy: 'double_opt_in',
            webhookToken: '•••set',
          },
        },
      },
    }
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      orgSettings,
    })
    render(<AdminSettingsPanel orgSlug="acme" />)

    const reasonInput = screen.getByTestId('admin-settings-reason-acme')
    fireEvent.change(reasonInput, { target: { value: 'fixing opt-in policy' } })

    const docTextarea = screen.getByTestId('admin-settings-doc-textMessaging')
    fireEvent.change(docTextarea, { target: { value: '{ not json' } })

    const saveButton = screen.getByTestId('admin-settings-save-acme-textMessaging')
    fireEvent.click(saveButton)

    expect(screen.getByText('Invalid JSON')).toBeInTheDocument()
    expect(mockSaveOrgSettings).not.toHaveBeenCalled()
  })

  it('calls saveOrgSettings with correct arguments on valid save', async () => {
    mockSaveOrgSettings.mockResolvedValue()
    const orgSettings = {
      acme: {
        orgSlug: 'acme',
        org: { name: 'Acme RX', enabledFields: ['phone'] },
        settingsDocs: {
          textMessaging: {
            optInPolicy: 'double_opt_in',
            webhookToken: '•••set',
          },
        },
      },
    }
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      orgSettings,
    })
    render(<AdminSettingsPanel orgSlug="acme" />)

    const reasonInput = screen.getByTestId('admin-settings-reason-acme')
    fireEvent.change(reasonInput, { target: { value: 'fixing opt-in policy' } })

    const docTextarea = screen.getByTestId('admin-settings-doc-textMessaging')
    fireEvent.change(docTextarea, { target: { value: '{"optInPolicy":"auto_opt_in","webhookToken":"•••set"}' } })

    const saveButton = screen.getByTestId('admin-settings-save-acme-textMessaging')
    fireEvent.click(saveButton)

    expect(mockSaveOrgSettings).toHaveBeenCalledWith(
      'acme',
      'settings/textMessaging',
      { optInPolicy: 'auto_opt_in', webhookToken: '•••set' },
      'fixing opt-in policy'
    )
  })

  it('shows error message when saveOrgSettings rejects', async () => {
    mockSaveOrgSettings.mockRejectedValue(new Error('permission-denied'))
    const orgSettings = {
      acme: {
        orgSlug: 'acme',
        org: { name: 'Acme RX', enabledFields: ['phone'] },
        settingsDocs: {
          textMessaging: {
            optInPolicy: 'double_opt_in',
            webhookToken: '•••set',
          },
        },
      },
    }
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      orgSettings,
    })
    render(<AdminSettingsPanel orgSlug="acme" />)

    const reasonInput = screen.getByTestId('admin-settings-reason-acme')
    fireEvent.change(reasonInput, { target: { value: 'fixing opt-in policy' } })

    const docTextarea = screen.getByTestId('admin-settings-doc-textMessaging')
    fireEvent.change(docTextarea, { target: { value: '{"optInPolicy":"auto_opt_in","webhookToken":"•••set"}' } })

    const saveButton = screen.getByTestId('admin-settings-save-acme-textMessaging')
    fireEvent.click(saveButton)

    const errorText = await screen.findByText('permission-denied')
    expect(errorText).toBeInTheDocument()
  })

  it('renders loading spinner when settingsLoading is true and no data', () => {
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      settingsLoading: true,
    })
    const { container } = render(<AdminSettingsPanel orgSlug="acme" />)
    // The loading spinner is a div with animate-spin class
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('renders error message when settingsError is set and no data', () => {
    vi.mocked(useAdminData).mockReturnValue({
      ...defaultMockReturn,
      settingsError: 'Something went wrong',
    })
    render(<AdminSettingsPanel orgSlug="acme" />)
    expect(screen.getByText('Error loading settings')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })
})
