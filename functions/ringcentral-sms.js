import { getAccessToken } from './ringcentral-auth.js'

export async function sendRingCentralSms({ creds, from, to, text }) {
  const token = await getAccessToken(creds)
  const url = `${creds.server}/restapi/v1.0/account/~/extension/~/sms`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: { phoneNumber: from },
      to: [{ phoneNumber: to }],
      text,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`RingCentral SMS failed (${res.status}): ${body}`)
  }

  const data = await res.json()
  return { messageId: data.id }
}
