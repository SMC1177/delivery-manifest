// functions/lib/usage.js
// Billing-math primitives for platform-admin usage counters.
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// MUST stay free of Firebase imports (pure, unit-testable).

export function monthKeyCentral(value) {
  // Returns 'YYYY-MM' for the instant evaluated in America/Chicago, or null.
  if (value == null) return null;
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'object' && typeof value.toDate === 'function') {
    date = value.toDate();
  } else if (typeof value === 'object' && typeof value.seconds === 'number') {
    date = new Date(value.seconds * 1000);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else {
    return null;
  }
  if (isNaN(date.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' });
    return formatter.format(date);
  } catch {
    return null;
  }
}

export function carrierBucket(carrier) {
  // Returns 'ups' | 'fedex' | 'usps' | 'other'.
  if (typeof carrier !== 'string') return 'other';
  const c = carrier.trim().toLowerCase();
  if (c === 'ups' || c === 'fedex' || c === 'usps') return c;
  return 'other';
}

export function shipmentMonthKey(shipment, fallback) {
  // Billing month for a shipment doc; see rules below. Returns 'YYYY-MM' or null.
  if (shipment == null) {
    if (fallback !== undefined) return monthKeyCentral(fallback);
    return null;
  }
  const fromCreated = monthKeyCentral(shipment.createdAt);
  if (fromCreated !== null) return fromCreated;
  if (typeof shipment.date === 'string' && /^\d{4}-\d{2}/.test(shipment.date)) {
    return shipment.date.slice(0, 7);
  }
  if (fallback !== undefined) return monthKeyCentral(fallback);
  return null;
}

export function buildUsageDeltas(monthKey, bucket, delta, wrap = (n) => n) {
  // Nested merge object for Firestore set(..., { merge: true }).
  return {
    shipmentCount: wrap(delta),
    monthlyUsage: {
      [monthKey]: {
        [bucket]: wrap(delta),
        total: wrap(delta)
      }
    }
  };
}
