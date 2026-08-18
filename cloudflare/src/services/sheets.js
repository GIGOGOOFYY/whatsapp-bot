// Replaces services/googleSheets.js (googleapis Node SDK -> Workers-compatible REST + JWT).
// googleapis relies on Node's http/https agents and doesn't run reliably in the Workers
// runtime. This signs a Google service-account JWT with `jose` (pure WebCrypto, Workers-safe)
// and calls the Sheets API v4 over fetch directly — same effective behaviour as before.

import { SignJWT, importPKCS8 } from 'jose'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

let cachedToken = null // { token, expiresAt } — reused across requests within a Worker isolate

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token
  }

  const creds = JSON.parse(env.GOOGLE_CREDENTIALS)
  const privateKey = await importPKCS8(creds.private_key, 'RS256')

  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/spreadsheets'
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(creds.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  })

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return cachedToken.token
}

async function getValues(env, range) {
  const token = await getAccessToken(env)
  const url = `${SHEETS_BASE}/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}`

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const text = await res.text()
    console.log('[Sheets DEBUG] get failed', { url, status: res.status, body: text })
    throw new Error(`Sheets get failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return data.values || []
}

async function updateValues(env, range, values) {
  const token = await getAccessToken(env)
  const url = `${SHEETS_BASE}/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [values] })
  })

  if (!res.ok) {
    const text = await res.text()
    console.log('[Sheets DEBUG] update failed', { url, status: res.status, body: text })
    throw new Error(`Sheets update failed: ${res.status} ${text}`)
  }
}

// Finds the next blank row by counting filled cells in column A (below the header row).
// Used instead of :append's auto table-detection for sheets whose header row has blank
// spacer columns (like Customers' F/G) — that gap makes :append misidentify a second
// "table" starting at the next non-blank header and dump data there instead.
async function nextEmptyRow(env, sheetName) {
  const rows = await getValues(env, `${sheetName}!A2:A`)
  return rows.length + 2
}

async function appendValues(env, range, values) {
  const token = await getAccessToken(env)
  const url = `${SHEETS_BASE}/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [values] })
  })

  if (!res.ok) {
    const text = await res.text()
    console.log('[Sheets DEBUG]', {
      url,
      spreadsheetId: env.SPREADSHEET_ID || '(missing)',
      status: res.status,
      body: text
    })
    throw new Error(`Sheets append failed: ${res.status} ${text}`)
  }
}

export async function addInquiry(env, phone, message, reply) {
  await appendValues(env, 'Inquiries!A:D', [phone, message, reply, new Date().toLocaleString()])
}

export async function addCustomerLead(env, lead) {
  // Customers sheet columns: A Phone | B Name | C Company | D City/Project | E Glass/Product |
  // F,G (blank spacers) | H Size | I Qty | J Date. There's no dedicated column for
  // thermalBreak/windowType, so fold them into the Glass/Product cell instead of dropping them.
  const row = await nextEmptyRow(env, 'Customers')
  const glassProduct = [lead.glassType, lead.thermalBreak, lead.windowType].filter(Boolean).join(' - ')

  await updateValues(env, `Customers!A${row}:E${row}`, [
    lead.phone, lead.name, lead.company, lead.city, glassProduct
  ])
  await updateValues(env, `Customers!H${row}:J${row}`, [
    lead.size, lead.quantity, new Date().toLocaleString()
  ])
}

export async function addMediaAttachment(env, phone, mediaType, mimeType, url, caption) {
  // Now that media has a real public URL (served from KV via /media/:key), render it directly
  // in the sheet: an inline thumbnail for images, a clickable link for everything else (PDFs,
  // videos). USER_ENTERED value input (see appendValues) lets Sheets parse these as formulas.
  let displayValue
  if (url.startsWith('http')) {
    const escapedUrl = url.replace(/"/g, '""')
    displayValue = mediaType === 'image'
      ? `=IMAGE("${escapedUrl}")`
      : `=HYPERLINK("${escapedUrl}", "View file")`
  } else {
    displayValue = `[media: ${url}]`
  }

  await appendValues(env, 'Inquiries!A:F', [
    phone,
    `[${mediaType.toUpperCase()}]`,
    caption || '(no caption)',
    displayValue,
    mimeType,
    new Date().toLocaleString()
  ])
}
