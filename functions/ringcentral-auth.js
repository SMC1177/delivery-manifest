const cache = new Map() // clientId → { token, expiresAt }
const SAFETY_WINDOW_MS = 60_000 // refresh 1 minute before expiry

export async function getAccessToken(creds, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now
  const cached = cache.get(creds.clientId)
  if (cached && cached.expiresAt > nowMs + SAFETY_WINDOW_MS) {
    return cached.token
  }

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')
  const url = `${creds.server}/restapi/oauth/token`
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: creds.jwt,
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`RingCentral auth failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  const ttlMs = Number(data.expires_in || 3600) * 1000
  cache.set(creds.clientId, {
    token: data.access_token,
    expiresAt: nowMs + ttlMs,
  })
  return data.access_token
}

export function _clearTokenCache() {
  cache.clear()
}
