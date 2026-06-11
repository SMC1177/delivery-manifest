#!/usr/bin/env node
/**
 * Backfill per-org usage counters from existing shipments.
 * Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
 * Usage: node scripts/backfill-usage.cjs <orgSlug>|--all [--apply]
 * DEFAULT IS DRY-RUN: prints the computed monthlyUsage + shipmentCount diff
 * per org and writes NOTHING unless --apply is passed.
 */

const path = require('path');
const https = require('https');
const { pathToFileURL } = require('url');

const PROJECT_ID = 'delivery-manifest-c3deb';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const args = process.argv.slice(2);
const orgSlugArg = args.find(a => !a.startsWith('--'));
const isAll = args.includes('--all');
const apply = args.includes('--apply');

if (!isAll && !orgSlugArg) {
  console.error('Usage: node scripts/backfill-usage.cjs <orgSlug>|--all [--apply]');
  process.exit(1);
}

const firebaseToolsConfig = require(path.join(process.env.USERPROFILE, '.config', 'configstore', 'firebase-tools.json'));
const refreshToken = firebaseToolsConfig.tokens?.refresh_token;
if (!refreshToken) {
  console.error('No firebase-tools refresh token. Run: npx firebase-tools login');
  process.exit(1);
}

let accessToken = null;

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { ...options.headers },
    };
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getToken() {
  if (accessToken) return accessToken;
  const res = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(res.data)}`);
  accessToken = res.data.access_token;
  return accessToken;
}

async function listCollection(collPath) {
  const token = await getToken();
  const docs = [];
  let pageToken = '';

  do {
    const url = `${BASE_URL}/${collPath}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await httpRequest(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`List ${collPath} failed (${res.status}): ${JSON.stringify(res.data)}`);
    if (res.data.documents) docs.push(...res.data.documents);
    pageToken = res.data.nextPageToken || '';
  } while (pageToken);

  return docs;
}

async function getDocument(docPath) {
  const token = await getToken();
  const url = `${BASE_URL}/${docPath}`;
  const res = await httpRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Get ${docPath} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

async function patchDocument(docPath, fields) {
  const token = await getToken();
  // Use PATCH with updateMask to only set the specified fields
  const fieldPaths = Object.keys(fields).map(k => k);
  const url = `${BASE_URL}/${docPath}?updateMask.fieldPaths=${fieldPaths.map(encodeURIComponent).join('&updateMask.fieldPaths=')}`;
  const res = await httpRequest(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (res.status !== 200) throw new Error(`Patch ${docPath} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

function docToObject(doc) {
  const obj = {};
  if (!doc.fields) return obj;
  for (const [key, val] of Object.entries(doc.fields)) {
    obj[key] = firestoreValueToJS(val);
  }
  obj._id = (doc.name || '').split('/').pop();
  return obj;
}

function firestoreValueToJS(val) {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(firestoreValueToJS);
  if ('mapValue' in val) {
    const m = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) m[k] = firestoreValueToJS(v);
    return m;
  }
  return null;
}

function jsToFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'boolean') return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(jsToFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = jsToFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function jsObjectToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id') continue;
    fields[k] = jsToFirestoreValue(v);
  }
  return fields;
}

async function main() {
  // Dynamically import ESM helpers
  const usageModulePath = pathToFileURL(path.resolve(__dirname, '../functions/lib/usage.js')).href;
  const { shipmentMonthKey, carrierBucket } = await import(usageModulePath);

  const mode = apply ? '🚀 LIVE' : '🔍 DRY RUN';
  console.log(`\n📊 Backfill usage counters`);
  console.log(`   Mode: ${mode}\n`);

  let orgSlugs = [];
  if (isAll) {
    // List all organizations
    const orgDocs = await listCollection('organizations');
    orgSlugs = orgDocs.map(d => (d.name || '').split('/').pop());
    console.log(`Found ${orgSlugs.length} organizations\n`);
  } else {
    orgSlugs = [orgSlugArg];
  }

  let totalOrgs = 0;
  let totalShipments = 0;
  let totalUnbucketed = 0;
  const errors = [];

  for (const slug of orgSlugs) {
    console.log(`\n━━━ Organization: ${slug} ━━━`);
    try {
      // Get current org doc
      const orgDoc = await getDocument(`organizations/${slug}`);
      if (!orgDoc) {
        console.log(`   ⚠️  Org doc not found, skipping`);
        continue;
      }
      const orgObj = docToObject(orgDoc);
      const currentMonthlyUsage = orgObj.monthlyUsage || {};
      const currentShipmentCount = orgObj.shipmentCount || 0;

      // List all shipments
      const shipmentDocs = await listCollection(`organizations/${slug}/shipments`);
      const shipments = shipmentDocs.map(docToObject);
      console.log(`   Shipments found: ${shipments.length}`);

      // Compute usage
      const monthlyUsage = {}; // { 'YYYY-MM': { ups:0, fedex:0, usps:0, other:0, total:0 } }
      let unbucketed = 0;

      for (const s of shipments) {
        const monthKey = shipmentMonthKey(s, null);
        const carrier = carrierBucket(s.carrier);
        if (monthKey === null) {
          unbucketed++;
        } else {
          if (!monthlyUsage[monthKey]) {
            monthlyUsage[monthKey] = { ups: 0, fedex: 0, usps: 0, other: 0, total: 0 };
          }
          monthlyUsage[monthKey][carrier]++;
          monthlyUsage[monthKey].total++;
        }
      }

      const computedShipmentCount = shipments.length;

      // Diff output
      console.log(`   Current shipmentCount: ${currentShipmentCount}`);
      console.log(`   Computed shipmentCount: ${computedShipmentCount}`);
      if (currentShipmentCount !== computedShipmentCount) {
        console.log(`   ⚠️  Diff: ${computedShipmentCount - currentShipmentCount}`);
      } else {
        console.log(`   ✅ Match`);
      }

      console.log(`   Current monthlyUsage months: ${Object.keys(currentMonthlyUsage).length}`);
      console.log(`   Computed monthlyUsage months: ${Object.keys(monthlyUsage).length}`);

      // Print month-by-month diff
      const allMonths = new Set([...Object.keys(currentMonthlyUsage), ...Object.keys(monthlyUsage)]);
      for (const m of [...allMonths].sort()) {
        const cur = currentMonthlyUsage[m] || { ups:0, fedex:0, usps:0, other:0, total:0 };
        const comp = monthlyUsage[m] || { ups:0, fedex:0, usps:0, other:0, total:0 };
        const diff = (key) => comp[key] - cur[key];
        const diffs = ['ups','fedex','usps','other','total'].map(k => `${k}:${diff(k)}`).join(' ');
        console.log(`   ${m}: ${diffs}`);
      }

      if (unbucketed > 0) {
        console.log(`   ⚠️  Unbucketed shipments: ${unbucketed}`);
      }

      totalOrgs++;
      totalShipments += computedShipmentCount;
      totalUnbucketed += unbucketed;

      // Write if --apply
      if (apply) {
        const updateFields = {
          monthlyUsage: monthlyUsage,
          shipmentCount: computedShipmentCount,
        };
        const fields = jsObjectToFields(updateFields);
        await patchDocument(`organizations/${slug}`, fields);
        console.log(`   ✅ Written monthlyUsage and shipmentCount`);
      } else {
        console.log(`   (dry-run, not written)`);
      }
    } catch (err) {
      console.error(`   ❌ ERROR: ${err.message}`);
      errors.push({ slug, error: err.message });
    }
  }

  console.log(`\n📊 Grand Total:`);
  console.log(`   Orgs processed: ${totalOrgs}`);
  console.log(`   Shipments scanned: ${totalShipments}`);
  console.log(`   Unbucketed count: ${totalUnbucketed}`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.length}`);
    for (const e of errors) {
      console.log(`     - ${e.slug}: ${e.error}`);
    }
    process.exit(1);
  }
  console.log();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
