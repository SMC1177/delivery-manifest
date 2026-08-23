import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useFacilities } from '../hooks/useFacilities';
import { useFacilityShipments } from '../hooks/useFacilityShipments';
import { UNIVERSAL_FIELDS } from '../constants/shipmentFields';

const DEFAULT_COLUMN_KEYS = [
  'patientName',
  'address',
  'dateOfBirth',
  'trackingNumber',
  'rxNumbers',
  'refillNumber',
  'refillDate',
  'refillsAuthorized',
  'refillsRemaining'
];

const STORAGE_KEY = 'facilityTab.columns.v1';
const MAX_COLUMNS = 10;

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function defaultFromDate() {
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - 30);
  return toISODate(from);
}

function defaultToDate() {
  return toISODate(new Date());
}

function loadColumns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMN_KEYS.slice();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLUMN_KEYS.slice();
    const known = new Set(UNIVERSAL_FIELDS.map((field) => field.key));
    const filtered = parsed.filter((key) => known.has(key));
    return filtered.length ? filtered : DEFAULT_COLUMN_KEYS.slice();
  } catch (err) {
    console.warn('facilityTab.columns.v1 read failed', err);
    return DEFAULT_COLUMN_KEYS.slice();
  }
}

function cellValue(row, field) {
  const value = row[field.storageKey || field.key];
  if (field.render === 'array') {
    return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return String(value ?? '');
}

export default function FacilityPage() {
  const { slug } = useParams();
  const [selectedFacility, setSelectedFacility] = useState('');
  const [columns, setColumns] = useState(loadColumns);
  const [showNote, setShowNote] = useState(false);
  const [dateFrom, setDateFrom] = useState(defaultFromDate);
  const [dateTo, setDateTo] = useState(defaultToDate);

  const { facilities, loading: facilitiesLoading, error: facilitiesError } = useFacilities(slug);
  const dateRange = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : null;
  const { shipments, loading: shipmentsLoading, error: shipmentsError } = useFacilityShipments(slug, selectedFacility || null, dateRange);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
    } catch (err) {
      console.warn('facilityTab.columns.v1 write failed', err);
    }
  }, [columns]);

  function toggleColumn(key) {
    if (columns.includes(key)) {
      setColumns(columns.filter((c) => c !== key));
      setShowNote(false);
      return;
    }
    if (columns.length >= MAX_COLUMNS) {
      setShowNote(true);
      return;
    }
    setColumns(columns.concat(key));
    setShowNote(false);
  }

  const selectedFields = columns
    .map((key) => UNIVERSAL_FIELDS.find((field) => field.key === key))
    .filter(Boolean);

  let content;
  if (facilitiesLoading) {
    content = <div className='text-center py-12 text-slate-500'>Loading…</div>;
  } else if (facilitiesError) {
    content = <div className='text-red-600'>{facilitiesError}</div>;
  } else if (facilities.length === 0) {
    content = <div className='text-center py-12 text-slate-500'>No facilities yet — the list populates from the next import</div>;
  } else if (!selectedFacility) {
    content = <div className='text-center py-12 text-slate-500'>Select a facility to view its shipments</div>;
  } else if (shipmentsLoading) {
    content = <div className='text-center py-12 text-slate-500'>Loading…</div>;
  } else if (shipmentsError) {
    content = <div className='text-red-600'>{shipmentsError}</div>;
  } else if (shipments.length === 0) {
    content = <div className='text-center py-12 text-slate-500'>No shipments for this facility in the selected range</div>;
  } else {
    content = (
      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr>
              {selectedFields.map((field) => (
                <th key={field.key} className='px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase'>{field.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shipments.map((row, idx) => (
              <tr key={idx} className='border-t border-slate-200'>
                {selectedFields.map((field) => (
                  <td key={field.key} className='px-3 py-2'>{cellValue(row, field)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-end gap-4'>
        <div>
          <label className='block text-xs text-slate-500 mb-1'>Facility</label>
          <select
            value={selectedFacility}
            onChange={(e) => setSelectedFacility(e.target.value)}
            className='px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500'
          >
            <option value=''>Select a facility…</option>
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.name}>{facility.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className='text-xs text-slate-500'>From</label>
          <input
            type='date'
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className='px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500'
          />
        </div>
        <div>
          <label className='text-xs text-slate-500'>To</label>
          <input
            type='date'
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className='px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500'
          />
        </div>
        <details className='relative'>
          <summary className='px-3 py-1.5 text-sm border border-slate-300 rounded-lg cursor-pointer'>Columns</summary>
          <div className='absolute right-0 z-10 mt-2 p-3 bg-white border border-slate-200 rounded-lg shadow-lg w-56'>
            {showNote && <p className='text-xs text-amber-600 mb-2'>Up to 10 columns</p>}
            {UNIVERSAL_FIELDS.map((field) => (
              <label key={field.key} className='flex items-center gap-2 py-1 text-sm'>
                <input type='checkbox' checked={columns.includes(field.key)} onChange={() => toggleColumn(field.key)} />
                {field.label}
              </label>
            ))}
          </div>
        </details>
      </div>
      {content}
    </div>
  );
}
