import { doc, setDoc } from 'firebase/firestore';

/**
 * collectFacilityNames + upsertFacilities back the Facility tab dropdown.
 *
 * CONTRACT: these functions NEVER throw. upsertFacilities is called from the
 * import path strictly AFTER the shipment batch commits, so a facilities
 * hiccup must only cost a dropdown entry until the next import, never the
 * import itself.
 */

export function collectFacilityNames(rows) {
  const seen = new Set();
  for (const row of rows ?? []) {
    const value = row?.facilityName;
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name === '') continue;
    seen.add(name);
  }
  return Array.from(seen);
}

export async function upsertFacilities(db, slug, names) {
  const failed = [];
  const list = Array.isArray(names) ? names : [];
  await Promise.all(
    list.map(async (name) => {
      try {
        const ref = doc(db, 'organizations', slug, 'facilities', name);
        await setDoc(ref, { name }, { merge: true });
      } catch {
        failed.push(name);
      }
    }),
  );
  return { failed };
}
