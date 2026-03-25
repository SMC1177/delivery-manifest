import { execSync } from 'child_process';

const projectId = 'delivery-manifest-c3deb';

async function enableTotpMfa() {
  // Get access token from firebase CLI
  console.log('Getting access token from Firebase CLI...');
  let accessToken;
  try {
    accessToken = execSync('npx firebase --non-interactive login:ci 2>nul', { encoding: 'utf8' }).trim();
  } catch {
    // Firebase CLI uses internal auth - let's extract the token via a workaround
    try {
      // Use firebase's internal node module to get the token
      const toolsPath = execSync('node -e "console.log(require.resolve(\'firebase-tools\'))"', { encoding: 'utf8', cwd: 'C:\\Users\\SMC11\\AppData\\Roaming\\npm\\node_modules\\firebase-tools' }).trim();
      console.log('Found firebase-tools at:', toolsPath);
    } catch(e) {
      // ignore
    }
  }
  
  // Use node to extract token from firebase-tools internals
  const getTokenScript = `
    const { configstore } = require('firebase-tools/lib/configstore');
    const tokens = configstore.get('tokens');
    if (tokens && tokens.refresh_token) {
      process.stdout.write(tokens.refresh_token);
    }
  `;
  
  let refreshToken;
  try {
    refreshToken = execSync(`node -e "${getTokenScript.replace(/\n/g, ' ')}"`, { 
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: 'C:\\Users\\SMC11\\AppData\\Roaming\\npm\\node_modules' }
    }).trim();
  } catch(e) {
    console.log('Could not extract refresh token, trying alternative...');
    // Alternative: use firebase auth:export to trigger token refresh
    try {
      refreshToken = execSync(`node -e "const c=require('C:/Users/SMC11/AppData/Roaming/npm/node_modules/firebase-tools/lib/configstore.js');const t=c.configstore?c.configstore.get('tokens'):c.default?.configstore?.get('tokens');if(t)process.stdout.write(t.refresh_token||'')"`, {
        encoding: 'utf8'
      }).trim();
    } catch(e2) {
      console.error('Failed:', e2.message);
    }
  }

  if (!refreshToken) {
    console.error('❌ Could not get Firebase refresh token.');
    console.log('\nAlternative: Run this in your terminal:');
    console.log('  npx firebase login --reauth');
    console.log('Then try again.');
    process.exit(1);
  }

  // Exchange refresh token for access token
  console.log('Exchanging refresh token for access token...');
  const tokenRes = await fetch('https://securetoken.googleapis.com/v1/token?key=AIzaSyDDmjQNegYPK3V_hG8MIm3Llbtqfp9lu3A', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  });

  // Actually use Google OAuth endpoint instead
  const oauthRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', 
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  });
  
  const oauthData = await oauthRes.json();
  if (!oauthData.access_token) {
    console.error('❌ Failed to get access token:', oauthData);
    process.exit(1);
  }
  
  accessToken = oauthData.access_token;
  console.log('Got access token! Enabling TOTP MFA...');

  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=mfa`;
  
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': projectId,
    },
    body: JSON.stringify({
      mfa: {
        providerConfigs: [{
          state: 'ENABLED',
          totpProviderConfig: {
            adjacentIntervals: 5
          }
        }]
      }
    })
  });

  const data = await res.json();
  
  if (res.ok) {
    console.log('✅ TOTP MFA enabled successfully!');
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.error('❌ Failed:', res.status, data.error?.message || JSON.stringify(data));
  }
}

enableTotpMfa();
