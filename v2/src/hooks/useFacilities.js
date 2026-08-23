import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';

export function useFacilities(slug) {
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(Boolean(slug));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!slug) {
      setFacilities([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setFacilities([]);
    setLoading(true);
    setError(null);

    getDocs(collection(db, 'organizations', slug, 'facilities'))
      .then((snapshot) => {
        if (!active) return;
        const list = snapshot.docs
          .map((doc) => ({ id: doc.id, name: doc.data().name ?? doc.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setFacilities(list);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('useFacilities: failed to load facilities', err);
        setError(err?.message || String(err));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [slug]);

  return { facilities, loading, error };
}
