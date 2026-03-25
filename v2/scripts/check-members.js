import { execSync } from 'child_process'

const PROJECT_ID = 'delivery-manifest-c3deb'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

async function getToken() {
  const rt = execSync(
    `node -e "const c=require('C:/Users/SMC11/AppData/Roaming/npm/node_modules/firebase-tools/lib/configstore.js');const t=c.configstore?c.configstore.get('tokens'):c.default?.configstore?.get('tokens');if(t)process.stdout.write(t.refresh_token||'')"`,
    { encoding: 'utf8' }
  ).trim()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: rt,
      grant_type: 'refresh_token',
    }),
  })
  return (await res.json()).access_token
}

async function main() {
  const token = await getToken()

  // Check members
  const membersRes = await fetch(`${BASE}/organizations/woodlandsrx/members`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const members = await membersRes.json()
  console.log('=== Members ===')
  console.log(JSON.stringify(members, null, 2))

  // Check userProfiles
  const profilesRes = await fetch(`${BASE}/userProfiles`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const profiles = await profilesRes.json()
  console.log('\n=== User Profiles ===')
  console.log(JSON.stringify(profiles, null, 2))
}

main()
