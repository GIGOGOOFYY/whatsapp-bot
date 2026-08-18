// PSG WhatsApp Listener — bridges personal WhatsApp numbers to the Cloudflare bot.
//
// Each "session" (label) is a personal number linked here as a companion device, exactly like
// linking WhatsApp Web/Desktop from that phone's Settings > Linked Devices. The phone keeps
// working 100% normally for personal chats and calls — this only ever reads incoming messages
// and, when the Worker says to, sends a reply back in that same chat.
//
// This process has to stay running 24/7 somewhere with a real filesystem + Chromium (Cloudflare
// Workers can't run this) — see README.md for hosting notes.

require('dotenv').config()
const express = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const QRCode = require('qrcode')

const PORT = process.env.PORT || 8787
const API_KEY = process.env.LISTENER_API_KEY
const WORKER_BASE_URL = process.env.WORKER_BASE_URL

if (!API_KEY || !WORKER_BASE_URL) {
  console.error('Missing LISTENER_API_KEY or WORKER_BASE_URL — copy .env.example to .env and fill both in.')
  process.exit(1)
}

const app = express()
app.use(express.json())

// label -> { client, state, pairingCode, qrDataUrl, phone }
// state: starting | waiting_qr | waiting_pairing | ready | disconnected
const sessions = new Map()

function requireAuth(req, res, next) {
  if (req.headers['x-listener-key'] !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// WhatsApp Web message "from" IDs look like "923001234567@c.us" (or @lid on some accounts) —
// normalize to plain digits so it matches the phone-number format the Worker already uses for
// KV session keys and CRM records on the Cloud API side.
function normalizeFrom(waId) {
  return String(waId).split('@')[0]
}

function buildClient(label) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: label }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    // whatsapp-web.js ships a bundled WhatsApp Web version that goes stale as WhatsApp updates
    // its servers — when that happens, calls like requestPairingCode() fail with cryptic
    // "Cannot read properties of undefined" errors because the page's internal modules don't
    // match what the library expects. Pointing at a community-maintained, continuously-updated
    // version index fixes this instead of pinning to whatever shipped with the npm package.
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
    }
  })

  client.on('qr', async (qr) => {
    const entry = sessions.get(label)
    if (!entry) return
    entry.state = 'waiting_qr'
    entry.qrDataUrl = await QRCode.toDataURL(qr)
    console.log(`[${label}] QR ready — scan via WhatsApp > Linked Devices, or fetch GET /sessions/${label}/status`)
  })

  client.on('ready', () => {
    const entry = sessions.get(label)
    if (entry) { entry.state = 'ready'; entry.pairingCode = null; entry.qrDataUrl = null }
    console.log(`[${label}] linked and listening`)
  })

  client.on('auth_failure', (msg) => {
    const entry = sessions.get(label)
    if (entry) entry.state = 'auth_failed'
    console.log(`[${label}] auth failure:`, msg)
  })

  client.on('disconnected', (reason) => {
    const entry = sessions.get(label)
    if (entry) entry.state = 'disconnected'
    console.log(`[${label}] disconnected:`, reason)
  })

  // The actual "listening" — every message that lands on this number passes through here.
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return
      const chat = await msg.getChat()
      if (chat.isGroup) return // never auto-reply in groups
      if (msg.type !== 'chat') return // v1: text only, no media/voice-note handling yet

      const res = await fetch(`${WORKER_BASE_URL}/webhook/personal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-listener-key': API_KEY },
        body: JSON.stringify({ from: normalizeFrom(msg.from), text: msg.body, label })
      })
      if (!res.ok) {
        console.log(`[${label}] Worker returned ${res.status}`)
        return
      }
      const data = await res.json()
      for (const reply of (data.messages || [])) {
        await client.sendMessage(msg.from, reply)
      }
    } catch (err) {
      console.log(`[${label}] message handling error:`, err.message)
    }
  })

  return client
}

// Start (or resume) linking a number. If `phone` is given, requests a text pairing code
// (simplest to deliver through WhatsApp itself); otherwise falls back to a scannable QR.
app.post('/sessions/:label/start', requireAuth, async (req, res) => {
  const { label } = req.params
  const { phone } = req.body || {}
  let entry = sessions.get(label)

  if (entry && entry.state === 'ready') {
    return res.json({ state: 'ready', message: `${label} is already linked and listening.` })
  }

  // Rebuild if this is a brand new label, OR an existing one is dead (disconnected/failed/error)
  // — without this, a session that drops once can never be relinked via "listen <label> <phone>"
  // again; it would keep retrying against the same broken client forever until this whole
  // process is manually restarted.
  const needsRebuild = !entry || ['disconnected', 'auth_failed', 'error'].includes(entry.state)
  if (needsRebuild) {
    if (entry) {
      try { await entry.client.destroy() } catch (err) { console.log(`[${label}] destroy old client error:`, err.message) }
    }
    const client = buildClient(label)
    entry = { client, state: 'starting', pairingCode: null, qrDataUrl: null, phone }
    sessions.set(label, entry)
    client.initialize().catch(err => {
      console.log(`[${label}] initialize error:`, err.message)
      entry.state = 'error'
    })
  }

  if (phone) {
    try {
      // Give the client a moment to reach the point where it can request a pairing code.
      await new Promise(r => setTimeout(r, 3000))
      const code = await entry.client.requestPairingCode(phone.replace(/\D/g, ''))
      entry.pairingCode = code
      entry.state = 'waiting_pairing'
      return res.json({ state: 'waiting_pairing', pairingCode: code })
    } catch (err) {
      console.log(`[${label}] pairing code request failed, will fall back to QR:`, err.message)
    }
  }

  return res.json({ state: entry.state, qrDataUrl: entry.qrDataUrl })
})

app.get('/sessions/:label/status', requireAuth, (req, res) => {
  const entry = sessions.get(req.params.label)
  if (!entry) return res.json({ state: 'not_started' })
  res.json({ state: entry.state, pairingCode: entry.pairingCode, qrDataUrl: entry.qrDataUrl })
})

// Serves the QR as an actual image (not just base64 in JSON) so the Worker can hand Meta's Cloud
// API a plain URL to fetch and send as a WhatsApp image message — Meta fetches media links
// directly, with no custom headers, so this takes the key as a query param instead of a header.
app.get('/sessions/:label/qr.png', (req, res) => {
  if (req.query.key !== API_KEY) return res.status(401).send('unauthorized')
  const entry = sessions.get(req.params.label)
  if (!entry || !entry.qrDataUrl) return res.status(404).send('no QR available for this session right now')
  const base64 = entry.qrDataUrl.split(',')[1]
  res.set('Content-Type', 'image/png')
  res.send(Buffer.from(base64, 'base64'))
})

app.get('/health', (req, res) => res.send('PSG WhatsApp listener — running'))

app.listen(PORT, () => console.log(`Listener service on :${PORT}`))
