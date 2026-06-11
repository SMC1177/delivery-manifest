#!/usr/bin/env node
/**
 * Nuclear wipe for a sandbox org's collections.
 * Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
 * Usage:
 *   node scripts/wipe-org-shipments.cjs <orgSlug>                      # DRY-RUN: counts only
 *   node scripts/wipe-org-shipments.cjs <orgSlug> --collections shipments,deliveries,auditLog
 *   node scripts/wipe-org-shipments.cjs <orgSlug> --apply --confirm <orgSlug>
 * Safety: dry-run by default. --apply REQUIRES --confirm <slug> where the
 * confirm value must byte-match the positional orgSlug, else exit 1 before
 * any network call. Never accepts --all. One org per invocation, ever.
 */

const path = require('path');
const https = require('https');

const PROJECT_ID = 'delivery-manifest-c3deb';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const ALLOWED_COLLECTIONS = new Set(['shipments', 'deliveries', 'auditLog']);

const args = process.argv.slice(2);
const orgSlug = args.find(a => !a.startsWith('--'));
const collectionsArg = args.find(a => a.startsWith('--collections='));
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmValue = confirmIndex !== -1 ? args[confirmIndex + 1] : undefined;

// --- Safety gate 1: no --all, exactly one positional orgSlug ---
if (args.includes('--all')) {
  console.error('ERROR: --all is not supported. This script operates on exactly one org per invocation.');
  process.exit(1);
}

if (!orgSlug) {
  console.error('Usage: node scripts/wipe-org-shipments.cjs <orgSlug> [--collections=shipments,deliveries,auditLog] [--apply --confirm <orgSlug>]');
  process.exit(1);
}

// --- Parse --collections ---
let collections = ['shipments'];
if (collectionsArg) {
  const raw = collectionsArg.split('=')[1];
  if (!raw) {
    console.error('ERROR: --collections requires a comma-separated list, e.g. --collections=shipments,deliveries');
    process.exit(1);
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const c of parts) {
    if (!ALLOWED_COLLECTIONS.has(c)) {
      console.error(`ERROR: Collection "${c}" is not in the allowlist. Allowed: ${[...ALLOWED_COLLECTIONS].join(', ')}`);
      process.exit(1);
    }
  }
  collections = parts;
}

// --- Safety gate 2: --apply requires --confirm matching orgSlug ---
if (apply) {
  if (!confirmValue || confirmValue !== orgSlug) {
    console.error('ERROR: --apply requires --confirm <orgSlug> where the value must exactly match the positional orgSlug.');
    console.error(`  Expected: --confirm ${orgSlug}`);
    console.error('  Example: node scripts/wipe-org-shipments.cjs my-org --apply --confirm my-org');
    process.exit(1);
  }
}

// --- Auth helpers (reused from backfill-usage.cjs) ---
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

async function batchDelete(collectionPath, docIds) {
  const token = await getToken();
  const writes = docIds.map(id => ({
    delete: `${BASE_URL}/${collectionPath}/${id}`
  }));
  const url = `${BASE_URL}:commit`;
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });
  if (res.status !== 200) throw new Error(`Batch delete failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

// --- Main ---
async function main() {
  const mode = apply ? '🚀 LIVE' : '🔍 DRY RUN';
  console.log(`\n☢️  Nuclear wipe for org: ${orgSlug}`);
  console.log(`   Collections: ${collections.join(', ')}`);
  console.log(`   Mode: ${mode}\n`);

  let totalDocs = 0;
  const collectionCounts = {};

  // Phase 1: Count (always, even in --apply mode)
  for (const coll of collections) {
    const collPath = `organizations/${orgSlug}/${coll}`;
    console.log(`   Counting ${coll}...`);
    const docs = await listCollection(collPath);
    const count = docs.length;
    collectionCounts[coll] = count;
    totalDocs += count;
    console.log(`   ${coll}: ${count} documents`);
  }

  console.log(`\n   Total documents to wipe: ${totalDocs}`);

  if (totalDocs === 0) {
    console.log('\n   Nothing to wipe. Exiting.');
    return;
  }

  if (!apply) {
    // Dry-run: print the command to run
    console.log('\n   🔍 DRY RUN — no documents were deleted.');
    console.log(`   To apply, run:`);
    console.log(`     node scripts/wipe-org-shipments.cjs ${orgSlug} --collections ${collections.join(',')} --apply --confirm ${orgSlug}`);
    return;
  }

  // Phase 2: Delete
  console.log('\n   🚀 Starting deletion...\n');
  let totalDeleted = 0;
  let totalErrors = 0;

  for (const coll of collections) {
    const collPath = `organizations/${orgSlug}/${coll}`;
    const docs = await listCollection(collPath);
    const ids = docs.map(d => d.name.split('/').pop());
    const total = ids.length;
    let deleted = 0;

    // Process in batches of 500
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      try {
        await batchDelete(collPath, batch);
        deleted += batch.length;
        totalDeleted += batch.length;
        console.log(`   ${coll}: ${deleted}/${total} deleted`);
      } catch (err) {
        console.error(`   ❌ Batch failed for ${coll} at offset ${i}: ${err.message}`);
        // Retry once after 2s
        console.log('   Retrying once after 2s...');
        await new Promise(r => setTimeout(r, 2000));
        try {
          await batchDelete(collPath, batch);
          deleted += batch.length;
          totalDeleted += batch.length;
          console.log(`   ${coll}: ${deleted}/${total} deleted (after retry)`);
        } catch (err2) {
          console.error(`   ❌ Retry also failed: ${err2.message}`);
          totalErrors += batch.length;
          console.error(`   Aborting. ${batch.length} documents not deleted in this batch.`);
          process.exit(1);
        }
      }
    }
  }

  console.log(`\n   ✅ Deletion complete. Total deleted: ${totalDeleted}`);
  if (totalErrors > 0) {
    console.log(`   ⚠️  Errors: ${totalErrors}`);
  }

  // Reminder block
  console.log(`\n   ⚠️  IMPORTANT: Usage counters for org "${orgSlug}" are now stale.`);
  console.log(`   Run the backfill script to recount:`);
  console.log(`     node scripts/backfill-usage.cjs ${orgSlug}           # dry-run`);
  console.log(`     node scripts/backfill-usage.cjs ${orgSlug} --apply   # write`);
  console.log(`   If usage-counter Cloud Functions are deployed, deletes also fired decrement triggers,`);
  console.log(`   but the backfill/reconcile recount is still the source of truth.`);
  console.log();
}

main().catch((err) => {
  console.error('Wipe failed:', err);
  process.exit(1);
});
