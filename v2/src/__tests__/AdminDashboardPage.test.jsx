import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock useAdminData before importing the page
vi.mock('../hooks/useAdminData', () => ({
  useAdminData: vi.fn(),
}))

import AdminDashboardPage from '../pages/AdminDashboardPage'
import { useAdminData } from '../hooks/useAdminData'

const mockUseAdminData = vi.mocked(useAdminData)

const sampleSummary = {
  months: ['2026-05', '2026-06'],
  orgs: [
    {
      slug: 'acme',
      name: 'Acme RX',
      memberCount: 3,
      shipmentCount: 120,
      monthly: {
        '2026-05': { ups: 10, fedex: 5, usps: 1, other: 0, total: 16 },
        '2026-06': { ups: 7, fedex: 2, usps: 0, other: 1, total: 10 },
      },
      statusCounts: { pending: 5, shipped: 10, in_transit: 2, delivered: 100, exception: 3 },
      billingConfig: { model: 'hybrid', baseFee: 25, includedShipments: 50, perShipmentRate: 0.5, notes: 'test' },
    },
    {
      slug: 'beta',
      name: 'Beta Org',
      memberCount: 1,
      shipmentCount: 5,
      monthly: null,
      statusCounts: null,
      billingConfig: null,
    },
  ],
}

function createMockAdminData(overrides = {}) {
  return {
    summary: sampleSummary,
    loading: false,
    saving: false,
    error: null,
    fetchSummary: vi.fn(),
    saveBillingConfig: vi.fn(),
    ...overrides,
  }
}

describe('AdminDashboardPage', () => {
  beforeEach(() => {
    mockUseAdminData.mockReturnValue(createMockAdminData())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders org rows with correct data-testids', () => {
    render(<AdminDashboardPage />)
    expect(screen.getByTestId('admin-org-row-acme')).toBeInTheDocument()
    expect(screen.getByTestId('admin-org-row-beta')).toBeInTheDocument()
  })

  it('displays per-carrier numbers for acme', () => {
    render(<AdminDashboardPage />)
    const acmeRow = screen.getByTestId('admin-org-row-acme')
    const cells = Array.from(acmeRow.querySelectorAll('td')).map((td) => td.textContent)
    // 2026-05 group: ups 10, fedex 5, usps 1, other 0, total 16
    expect(cells).toEqual(expect.arrayContaining(['10', '5', '1', '16']))
    // 2026-06 total
    expect(cells).toContain('7')
  })

  it('displays zeros for beta org with null monthly', () => {
    render(<AdminDashboardPage />)
    // Beta org should show zeros for all carrier columns
    const betaRow = screen.getByTestId('admin-org-row-beta')
    // The row contains many zeros; we just check that at least one zero is present
    expect(betaRow.textContent).toContain('0')
  })

  it('calls fetchSummary on mount', () => {
    const fetchSummary = vi.fn()
    mockUseAdminData.mockReturnValue(createMockAdminData({ fetchSummary }))
    render(<AdminDashboardPage />)
    expect(fetchSummary).toHaveBeenCalledTimes(1)
  })

  it('renders loading spinner when loading is true', () => {
    mockUseAdminData.mockReturnValue(createMockAdminData({ loading: true, summary: null }))
    render(<AdminDashboardPage />)
    // The spinner is a div with animate-spin class
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-org-row-acme')).not.toBeInTheDocument()
  })

  it('renders error message when error is set', () => {
    mockUseAdminData.mockReturnValue(createMockAdminData({ error: 'Something went wrong', summary: null }))
    render(<AdminDashboardPage />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-org-row-acme')).not.toBeInTheDocument()
  })

  it('exports CSV with correct content', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    globalThis.URL.createObjectURL = createObjectURL
    globalThis.URL.revokeObjectURL = revokeObjectURL

    // Mock document.createElement('a') to capture click
    const clickMock = vi.fn()
    const anchorMock = { href: '', download: '', click: clickMock }
    const originalCreateElement = document.createElement.bind(document)
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return anchorMock
      return originalCreateElement(tag)
    })

    render(<AdminDashboardPage />)
    const exportBtn = screen.getByTestId('admin-export-csv')
    fireEvent.click(exportBtn)

    // Capture the blob passed to createObjectURL
    const blobArg = createObjectURL.mock.calls[0][0]
    const text = await blobArg.text()

    expect(text).toContain('slug,name,month,ups,fedex,usps,other,total,memberCount,shipmentCount,billingModel')
    expect(text).toContain('acme,Acme RX,2026-05,10,5,1,0,16,3,120,hybrid')
    expect(text).toContain('acme,Acme RX,2026-06,7,2,0,1,10,3,120,hybrid')
    expect(text).toContain('beta,Beta Org,2026-05,0,0,0,0,0,1,5,unset')
    expect(text).toContain('beta,Beta Org,2026-06,0,0,0,0,0,1,5,unset')

    createElementSpy.mockRestore()
  })

  it('shows billing editor with prefilled values when org row is expanded', () => {
    render(<AdminDashboardPage />)
    const acmeRow = screen.getByTestId('admin-org-row-acme')
    fireEvent.click(acmeRow)
    expect(screen.getByTestId('admin-billing-editor-acme')).toBeInTheDocument()
    // Check that the model select has 'hybrid' selected
    const modelSelect = screen.getByTestId('admin-billing-editor-acme').querySelector('select')
    expect(modelSelect.value).toBe('hybrid')
  })

  it('shows validation error for negative perShipmentRate and does not call saveBillingConfig', async () => {
    const saveBillingConfig = vi.fn()
    mockUseAdminData.mockReturnValue(createMockAdminData({ saveBillingConfig }))
    render(<AdminDashboardPage />)
    // Expand acme
    fireEvent.click(screen.getByTestId('admin-org-row-acme'))
    const editor = screen.getByTestId('admin-billing-editor-acme')
    expect(editor).toBeInTheDocument()
    // Change perShipmentRate to negative
    const perShipmentInput = editor.querySelectorAll('input[type="number"]')[2] // third number input
    fireEvent.change(perShipmentInput, { target: { value: '-1' } })
    // Click save
    const saveBtn = screen.getByTestId('admin-billing-save-acme')
    fireEvent.click(saveBtn)
    // Validation error should appear
    expect(screen.getByText('Per-shipment rate cannot be negative')).toBeInTheDocument()
    expect(saveBillingConfig).not.toHaveBeenCalled()
  })

  it('calls saveBillingConfig with valid values', async () => {
    const saveBillingConfig = vi.fn()
    mockUseAdminData.mockReturnValue(createMockAdminData({ saveBillingConfig }))
    render(<AdminDashboardPage />)
    // Expand acme
    fireEvent.click(screen.getByTestId('admin-org-row-acme'))
    expect(screen.getByTestId('admin-billing-editor-acme')).toBeInTheDocument()
    // Ensure model is hybrid (already default)
    const saveBtn = screen.getByTestId('admin-billing-save-acme')
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(saveBillingConfig).toHaveBeenCalledWith(
        'acme',
        expect.objectContaining({ model: expect.any(String), currency: 'usd' })
      )
    })
  })
})
