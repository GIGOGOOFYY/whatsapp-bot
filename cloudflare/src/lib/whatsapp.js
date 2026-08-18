// Meta WhatsApp Cloud API senders — ported from server.js, axios -> fetch (native in Workers).

const GRAPH = 'https://graph.facebook.com/v23.0'

function authHeaders(env, extra = {}) {
  return { Authorization: `Bearer ${env.ACCESS_TOKEN}`, ...extra }
}

async function postMessage(env, body) {
  const res = await fetch(`${GRAPH}/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: authHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    console.log('[WA DEBUG]', {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type'),
      cfRay: res.headers.get('cf-ray'),
      server: res.headers.get('server'),
      bodyLength: text.length,
      body: text || '(empty)',
      phoneNumberId: env.PHONE_NUMBER_ID || '(missing)',
      hasAccessToken: !!env.ACCESS_TOKEN,
      tokenPrefix: env.ACCESS_TOKEN ? env.ACCESS_TOKEN.slice(0, 6) : null
    })
  }
  return res
}

export async function sendMessage(env, to, text) {
  return postMessage(env, { messaging_product: 'whatsapp', to, text: { body: text } })
}

// Up to 3 buttons: buttons = [{ id: 'btn_1', title: 'Option A' }, ...]
export async function sendButtons(env, to, bodyText, buttons) {
  return postMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.substring(0, 20) }
        }))
      }
    }
  })
}

// List menu — up to 10 items: items = [{ id, title, description }, ...]
export async function sendList(env, to, bodyText, buttonLabel, items) {
  return postMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections: [{
          title: 'Options',
          rows: items.map(i => ({
            id: i.id,
            title: i.title.substring(0, 24),
            description: (i.description || '').substring(0, 72)
          }))
        }]
      }
    }
  })
}

export async function getMediaUrl(env, mediaId) {
  const res = await fetch(`${GRAPH}/${mediaId}`, { headers: authHeaders(env) })
  if (!res.ok) throw new Error(`getMediaUrl failed: ${res.status}`)
  const data = await res.json()
  return data.url
}

export async function downloadMediaBuffer(env, mediaUrl) {
  const res = await fetch(mediaUrl, { headers: authHeaders(env) })
  if (!res.ok) throw new Error(`downloadMediaBuffer failed: ${res.status}`)
  return res.arrayBuffer()
}
