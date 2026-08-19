import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { updateDoc } from 'firebase/firestore'

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn(() => ({ id: 'org-doc' })),
  getDoc: vi.fn(() => Promise.resolve({ exists: () => false })),
  onSnapshot: vi.fn((q, cb) => {
    cb({ docs: [] })
    return vi.fn()
  }),
  updateDoc: vi.fn(() => Promise.resolve()),
  serverTimestamp: vi.fn(() => 0),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

// Mutable so tests can simulate a saved per-org visible-columns preference.
const { mockOrgSettings } = vi.hoisted(() => ({
  mockOrgSettings: {
    settings: { enabledFields: ['carrier', 'address', 'notes'] },
    isFieldEnabled: (field) => ['carrier', 'address', 'notes'].includes(field),
  },
}))

vi.mock('../hooks/useOrgSettings', () => ({
  useOrgSettings: () => mockOrgSettings,
}))

vi.mock('../hooks/useTextMessagingSettings', () => ({
  useTextMessagingSettings: () => ({ data: null, loading: false, save: vi.fn() }),
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ orgSlug: 'test-org', user: {} }),
}))

vi.mock('../hooks/useSmsContact', () => ({
  useSmsContact: () => ({ contact: null, loading: false, derivedState: 'unknown', normalizedPhone: null }),
}))

import ShipmentTable from '../components/ShipmentTable'

function renderWithRouter(ui) {
  return render(
    <MemoryRouter initialEntries={['/test-org/dashboard']}>
      <Routes>
        <Route path="/:slug/dashboard" element={ui} />
      </Routes>
    </MemoryRouter>
  )
}

const mockHandlers = {
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onStatusChange: vi.fn(),
}

describe('ShipmentTable', () => {
  it('shows empty state when no shipments', () => {
    renderWithRouter(<ShipmentTable shipments={[]} {...mockHandlers} />)
    expect(screen.getByText('No shipments found')).toBeInTheDocument()
  })

  it('renders shipment data in the table', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'John Doe',
        date: '2025-06-15',
        rxNumbers: ['RX001', 'RX002'],
        trackingNumber: '1Z999AA1',
        carrier: 'ups',
        status: 'shipped',
        address: '123 Main St',
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    expect(screen.getAllByText('John Doe').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RX001, RX002').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1Z999AA1').length).toBeGreaterThan(0)
  })

  it('renders UPS tracking link correctly', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'UPS Patient',
        trackingNumber: '1Z999AA1',
        carrier: 'ups',
        status: 'shipped',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    const links = screen.getAllByRole('link', { name: '1Z999AA1' })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].href).toContain('ups.com/track')
  })

  it('renders FedEx tracking link correctly', () => {
    const shipments = [
      {
        id: '2',
        patientName: 'FedEx Patient',
        trackingNumber: '789456123012',
        carrier: 'fedex',
        status: 'in_transit',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    const links = screen.getAllByRole('link', { name: '789456123012' })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].href).toContain('fedex.com/fedextrack')
  })

  it('displays carrier name instead of raw value', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'Test Patient',
        trackingNumber: '123',
        carrier: 'fedex',
        status: 'pending',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    // Should show "FedEx" not "fedex"
    expect(screen.getAllByText('FedEx').length).toBeGreaterThan(0)
  })

  it('shows dash for missing tracking number', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'No Tracking',
        trackingNumber: '',
        carrier: 'ups',
        status: 'pending',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    // Should render dash characters for missing data
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThan(0)
  })
})

const renderShipments = (shipments, props = {}) =>
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ShipmentTable shipments={shipments} {...props} />} />
      </Routes>
    </MemoryRouter>
  )

describe('ShipmentTable exception reason rendering', () => {

  // Every shipment renders TWICE - once as a desktop table row, once as a
  // mobile card - so text appears twice and the singular queries throw.
  // toHaveLength(2) is deliberate: it proves BOTH views show the reason, which
  // a toBeGreaterThan(0) check would not, and staff here work on tablets.

  it('shows the upsStatus reason for an exception shipment', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-1', status: 'exception', carrier: 'ups', upsStatus: 'Receiver was not available', fedexStatus: null }
    ])

    expect(getAllByText('Receiver was not available')).toHaveLength(2)
  })

  it('shows the fedexStatus fallback reason for an exception shipment', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-2', status: 'exception', carrier: 'fedex', upsStatus: null, fedexStatus: 'Delivery exception' }
    ])

    expect(getAllByText('Delivery exception')).toHaveLength(2)
  })

  it('does not render a reason node when an exception shipment has neither reason field', () => {
    const { getAllByText, queryAllByText, container } = renderShipments([
      { id: 'exception-3', status: 'exception', carrier: 'ups', upsStatus: null, fedexStatus: null }
    ])

    // The badge still renders in both views...
    expect(getAllByText(/exception/i).length).toBeGreaterThan(0)
    // ...but no reason text does.
    expect(queryAllByText('Receiver was not available')).toHaveLength(0)
    expect(queryAllByText('Delivery exception')).toHaveLength(0)
    // Bound to the class the component actually uses. The previous version of
    // this line guessed at .exception-reason / [class*="reason"], which the
    // implementation never emits, so it could not fail either way.
    expect(container.querySelectorAll('.text-red-700')).toHaveLength(0)
  })

  it('does not show a populated upsStatus for a delivered shipment', () => {
    const { queryAllByText } = renderShipments([
      { id: 'delivered-1', status: 'delivered', carrier: 'ups', upsStatus: 'Receiver was not available' }
    ])

    expect(queryAllByText('Receiver was not available')).toHaveLength(0)
  })

  it('shows the reason even when carrier is null but upsStatus is populated', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-5', status: 'exception', carrier: null, upsStatus: 'Receiver was not available', fedexStatus: null }
    ])

    expect(getAllByText('Receiver was not available')).toHaveLength(2)
  })
})

describe('queue state badges', () => {
  it('renders a queue-state badge for a tracking number with state', () => {
    const { getByText } = renderShipments([
      { id: 'q1', status: 'shipped', trackingNumber: 'T1', carrier: 'ups' },
    ], { queueStates: { T1: 'Queued' } })
    expect(getByText('Queued')).toBeDefined()
  })

  it('renders the operator vocabulary, not the raw status', () => {
    const { getByText } = renderShipments([
      { id: 'q2', status: 'shipped', trackingNumber: 'T2', carrier: 'ups' },
    ], { queueStates: { T2: 'Not sent' } })
    expect(getByText('Not sent')).toBeDefined()
  })

  it('renders nothing extra when a tracking number has no queue state', () => {
    const { queryByText } = renderShipments([
      { id: 'q3', status: 'shipped', trackingNumber: 'T3', carrier: 'ups' },
    ])
    expect(queryByText(/Queued|Sending|Sent|Retrying|Not sent/)).toBeNull()
  })
})

describe('patient settings modal', () => {
  const shipments = [
    {
      id: 'settings-1',
      patientName: 'Jane Smith',
      date: '2025-06-15',
      address: '123 Main St',
      phone: '+1-555-0100',
      dob: '1980-01-01',
      rxNumbers: ['RX001'],
      trackingNumber: '1Z999AA1',
      carrier: 'ups',
      status: 'shipped',
    },
  ]

  it('opens the settings modal when the desktop patient name is clicked', () => {
    const { getAllByRole, getByText, getByDisplayValue } = renderShipments(shipments)
    const nameButtons = getAllByRole('button', { name: 'Jane Smith' })
    fireEvent.click(nameButtons[0])
    expect(getByText('Edit Shipment')).toBeInTheDocument()
    expect(getByDisplayValue('Jane Smith')).toBeInTheDocument()
  })

  it('opens the settings modal when the mobile card patient name is clicked', () => {
    const { getAllByRole, getByText, getByDisplayValue } = renderShipments(shipments)
    const nameButtons = getAllByRole('button', { name: 'Jane Smith' })
    fireEvent.click(nameButtons[nameButtons.length - 1])
    expect(getByText('Edit Shipment')).toBeInTheDocument()
    expect(getByDisplayValue('Jane Smith')).toBeInTheDocument()
  })

  it('closes the settings modal', () => {
    const { getAllByRole, getByText, queryByText, container } = renderShipments(shipments)
    fireEvent.click(getAllByRole('button', { name: 'Jane Smith' })[0])
    expect(getByText('Edit Shipment')).toBeInTheDocument()
    const backdrop = container.querySelector('.fixed.inset-0')
    fireEvent.click(backdrop)
    expect(queryByText('Edit Shipment')).toBeNull()
  })
})

describe('column visibility chooser', () => {
  const chooserShipments = [
    {
      id: 'cols-1',
      patientName: 'Chooser Patient',
      date: '2025-06-15',
      rxNumbers: ['RX001', 'RX002'],
      trackingNumber: '1Z999AA1',
      carrier: 'ups',
      status: 'shipped',
      address: '123 Main St',
      notes: 'Handling notes here',
    },
  ]

  it('shows a Columns button that opens the column menu', () => {
    const { getByRole, queryByLabelText, getByLabelText } = renderShipments(chooserShipments)
    expect(queryByLabelText('Rx Numbers')).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Columns' }))
    expect(getByLabelText('Rx Numbers')).toBeInTheDocument()
  })

  it('hides a column when it is unchecked in the menu', () => {
    const { getByRole, getByLabelText, getAllByText, container } = renderShipments(chooserShipments)
    // rx numbers render twice: the desktop cell and the (unchanged) mobile card
    expect(getAllByText('RX001, RX002')).toHaveLength(2)
    fireEvent.click(getByRole('button', { name: 'Columns' }))
    fireEvent.click(getByLabelText('Rx Numbers'))
    // desktop column hidden, mobile card still shows it
    expect(getAllByText('RX001, RX002')).toHaveLength(1)
    const rxHeaders = Array.from(container.querySelectorAll('thead th')).filter((th) => th.textContent === 'Rx Numbers')
    expect(rxHeaders).toHaveLength(0)
  })

  it('persists the preference to the org settings doc', () => {
    renderWithRouter(<ShipmentTable shipments={chooserShipments} {...mockHandlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
    fireEvent.click(screen.getByLabelText('Notes'))
    expect(updateDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        'settings.visibleColumns': expect.arrayContaining(['date', 'patientName', 'tracking', 'status']),
      })
    )
  })


  it('RED — Date Added renders the stored createdAt as a date, not a stringified object', () => {
    // createdAt already exists on every shipment: 21,078 of 21,078 rows across
    // both live orgs, and it never moves — 19,693 rows have been updated since
    // insert and not one had its createdAt dragged forward. So "Date Added"
    // needs no new field, only exposure.
    //
    // The catch is the SHAPE. useShipments hands documents to the UI as
    // `{ id: d.id, ...d.data() }` with no timestamp conversion, so createdAt
    // arrives as a raw Firestore Timestamp. registryCellText ends in
    // `String(raw)`, which renders that as an object. The fixture below is
    // Timestamp-shaped on purpose — a plain string would pass without ever
    // exercising the path the real data takes.
    const before = mockOrgSettings.isFieldEnabled
    try {
      mockOrgSettings.isFieldEnabled = (f) => f === 'createdAt'
      const { container } = renderShipments([
        {
          id: 'ts1',
          patientName: 'Ada Lovelace',
          rxNumbers: ['RX9'],
          date: '2026-02-02',
          status: 'delivered',
          createdAt: { toDate: () => new Date('2026-08-15T14:30:00Z') },
        },
      ])

      const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
      expect(headers, 'the stamp already on every row must be offerable as a column').toContain('Date Added')

      const body = container.querySelector('tbody').textContent
      expect(body, 'the cell must show the date the row was added').toContain('2026')
      expect(
        body.toLowerCase(),
        'a Firestore Timestamp must not reach the screen through String(raw)',
      ).not.toContain('object')
    } finally {
      mockOrgSettings.isFieldEnabled = before
    }
  })

  // ---- columns derived from the field registry ----
  // The table hard-codes 11 COLUMN_DEFS while the registry holds 32 fields, so
  // today only 11 of them can ever reach the screen. These pin the contract that
  // a Settings toggle governs a column, whatever the field.

  const registryShipments = [
    {
      id: 'r1',
      patientName: 'Ada Lovelace',
      dob: '1815-12-10',
      rxNumbers: ['RX9'],
      trackingNumber: 'TRK-9',
      date: '2026-02-02',
      status: 'delivered',
      drugDescription: 'AMOXICILLIN 500MG CAP',
    },
  ]

  const headersOf = (container) =>
    Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)

  it('RED — an enabled registry field renders a column with its label, and disabling it removes the column', () => {
    const before = mockOrgSettings.isFieldEnabled
    try {
      mockOrgSettings.isFieldEnabled = (f) => f === 'drugDescription'
      const on = renderShipments(registryShipments)
      expect(
        headersOf(on.container),
        'a field enabled in Settings must produce a column bearing the registry label',
      ).toContain('Dispensed Drug Description')
      expect(on.getByText('AMOXICILLIN 500MG CAP')).toBeInTheDocument()
      on.unmount()

      // The other direction, in the same test: asserting only the absence would
      // pass vacuously at HEAD, where this column never existed in the first place.
      mockOrgSettings.isFieldEnabled = () => false
      const off = renderShipments(registryShipments)
      expect(headersOf(off.container)).not.toContain('Dispensed Drug Description')
      expect(off.queryByText('AMOXICILLIN 500MG CAP')).toBeNull()
    } finally {
      mockOrgSettings.isFieldEnabled = before
    }
  })

  it('RED — a saved visibleColumns list from before the field existed does not hide it', () => {
    // Both live orgs already carry a saved list from 5d3b9f62, and isColumnVisible
    // requires visibleColumns.includes(key) — so without this, a newly enabled
    // column can never appear for either of them.
    const before = mockOrgSettings.isFieldEnabled
    mockOrgSettings.settings.visibleColumns = ['date', 'patientName', 'tracking', 'status']
    try {
      mockOrgSettings.isFieldEnabled = (f) => f === 'drugDescription'
      const { container } = renderShipments(registryShipments)
      expect(
        headersOf(container),
        'the Settings toggle governs the column; a stale saved list must not veto it',
      ).toContain('Dispensed Drug Description')
    } finally {
      delete mockOrgSettings.settings.visibleColumns
      mockOrgSettings.isFieldEnabled = before
    }
  })

  it('GUARD — tracking renders exactly one column, never two', () => {
    // COLUMN_DEFS keys this 'tracking' while the registry and Firestore both say
    // 'trackingNumber'. A derived loop excluding by exact key match against the
    // old list emits a second, identical Tracking column.
    const before = mockOrgSettings.isFieldEnabled
    try {
      mockOrgSettings.isFieldEnabled = (f) => f === 'trackingNumber' || f === 'tracking'
      const { container } = renderShipments(registryShipments)
      const tracking = headersOf(container).filter((h) => h === 'Tracking #')
      expect(tracking, 'one field must not produce two identical columns').toHaveLength(1)
    } finally {
      mockOrgSettings.isFieldEnabled = before
    }
  })

  it('GUARD — the DOB column shows the stored dob value, not undefined', () => {
    // Firestore persists this as `dob` while the registry key is `dateOfBirth`.
    // A column keyed on the registry key alone reads undefined for every row.
    const before = mockOrgSettings.isFieldEnabled
    try {
      mockOrgSettings.isFieldEnabled = (f) => f === 'dob' || f === 'dateOfBirth'
      const { getByText } = renderShipments(registryShipments)
      expect(getByText('1815-12-10')).toBeInTheDocument()
    } finally {
      mockOrgSettings.isFieldEnabled = before
    }
  })

  it('applies a saved per-org visible-columns preference', () => {
    mockOrgSettings.settings.visibleColumns = ['date', 'patientName', 'rxNumbers', 'tracking', 'status']
    try {
      const { queryByText, getByText, container } = renderShipments(chooserShipments)
      expect(queryByText('Address')).toBeNull()
      expect(queryByText('Carrier')).toBeNull()
      expect(queryByText('Notes')).toBeNull()
      expect(getByText('Status')).toBeInTheDocument()
      const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
      expect(headers).toEqual(['Date', 'Patient Name', 'Rx Numbers', 'Tracking #', 'Status', 'Actions'])
    } finally {
      delete mockOrgSettings.settings.visibleColumns
    }
  })
})

describe('frozen anchor columns', () => {
  const frozenShipments = [
    {
      id: 'frozen-1',
      patientName: 'Frozen Patient',
      date: '2025-06-15',
      rxNumbers: ['RX001'],
      trackingNumber: '1Z999AA1',
      carrier: 'ups',
      status: 'shipped',
      address: '123 Main St',
    },
  ]

  it('wraps the desktop table in a horizontal-scroll container', () => {
    const { container } = renderShipments(frozenShipments)
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
  })

  it('pins the anchor header cells with sticky positioning and left offsets', () => {
    const { container } = renderShipments(frozenShipments)
    const headers = Array.from(container.querySelectorAll('thead th'))
    // Date, Patient Name, [Address], [Rx Numbers], Tracking #, [Carrier], Status, [Notes], Actions
    const [dateTh, nameTh, , , trackTh, , statusTh] = headers
    expect(dateTh.className).toContain('sticky')
    expect(dateTh.style.left).toBe('0px')
    expect(nameTh.className).toContain('sticky')
    expect(nameTh.style.left).toBe('112px')
    expect(trackTh.className).toContain('sticky')
    expect(trackTh.style.left).toBe('272px')
    expect(statusTh.className).toContain('sticky')
    expect(statusTh.style.left).toBe('448px')
  })

  it('pins the anchor body cells with the same offsets', () => {
    const { container } = renderShipments(frozenShipments)
    const cells = Array.from(container.querySelectorAll('tbody tr td'))
    expect(cells[0].className).toContain('sticky')
    expect(cells[0].style.left).toBe('0px')
    expect(cells[1].className).toContain('sticky')
    expect(cells[1].style.left).toBe('112px')
    expect(cells[4].style.left).toBe('272px')
    expect(cells[6].style.left).toBe('448px')
  })

  it('shifts the frozen offsets right when row selection is enabled', () => {
    const { container } = renderShipments(frozenShipments, {
      selectedIds: new Set(),
      onSelectionChange: vi.fn(),
    })
    const headers = Array.from(container.querySelectorAll('thead th'))
    // checkbox column leads, then the frozen anchors shift by 40px
    expect(headers[0].className).not.toContain('sticky')
    expect(headers[1].textContent).toBe('Date')
    expect(headers[1].style.left).toBe('40px')
    expect(headers[2].style.left).toBe('152px')
  })

  it('leaves the mobile card view untouched', () => {
    const { container } = renderShipments(frozenShipments)
    const mobile = container.querySelector('.md\\:hidden')
    expect(mobile).not.toBeNull()
    expect(mobile.querySelectorAll('.sticky')).toHaveLength(0)
  })
})
