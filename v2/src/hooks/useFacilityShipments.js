import { useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';

// S4 fence: bound the result set so this tab does not replicate the dashboard
// hook's load-everything-client-side pattern on a collection that grows weekly.
const FACILITY_SHIPMENTS_LIMIT = 500;

export function useFacilityShipments(slug, facilityName, dateRange) {
  const [shipments, setShipments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const from = dateRange?.from;
  const to = dateRange?.to;

  useEffect(() => {
    if (!slug || !facilityName) {
      setShipments([]);
      setLoading(false);
      setError(null);
      return;
    }

    const queryConstraints = [
      where('archived', '==', false),
      where('facilityName', '==', facilityName),
    ];
    if (from != null) queryConstraints.push(where('date', '>=', from));
    if (to != null) queryConstraints.push(where('date', '<=', to));
    queryConstraints.push(orderBy('date', 'desc'), limit(FACILITY_SHIPMENTS_LIMIT));

    const q = query(
      collection(db, 'organizations', slug, 'shipments'),
      ...queryConstraints
    );

    let cancelled = false;
    setShipments([]);
    setLoading(true);
    setError(null);

    getDocs(q)
      .then((snapshot) => {
        if (cancelled) return;
        const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        // Firestore cannot order by patientNameLower with the date range, so
        // sort here; missing names sink to the bottom without throwing.
        rows.sort((a, b) => {
          const aName = a.patientNameLower;
          const bName = b.patientNameLower;
          if (aName == null && bName == null) return 0;
          if (aName == null) return 1;
          if (bName == null) return -1;
          return aName.localeCompare(bName);
        });
        setShipments(rows);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
        setShipments([]);
        setLoading(false);
        console.error('useFacilityShipments: failed to load facility shipments', err);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, facilityName, from, to]);

  return { shipments, loading, error };
}

export default useFacilityShipments;
