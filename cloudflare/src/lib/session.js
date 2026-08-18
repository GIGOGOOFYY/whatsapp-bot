// Replaces in-memory `conversations`, `adminSessions`, `leadSessions` objects in server.js.
// Those were plain JS objects — fine on a long-running Railway process, but wiped on every
// Worker cold start / redeploy. This backs them with Workers KV instead, keyed per phone number.
//
// KV is eventually consistent, but this bot only ever has one webhook call in flight per phone
// number at a time (WhatsApp delivers one message, we respond, then the next arrives), so the
// read-modify-write pattern here is safe in practice.

const SESSION_TTL_SECONDS = 60 * 60 * 6 // 6h — plenty for one lead/admin conversation

async function getJSON(env, key) {
  const raw = await env.SESSIONS.get(key)
  return raw ? JSON.parse(raw) : null
}

async function putJSON(env, key, value) {
  await env.SESSIONS.put(key, JSON.stringify(value), { expirationTtl: SESSION_TTL_SECONDS })
}

// --- Lead wizard session: { step, data: {...} } ---
export async function getLeadSession(env, phone) {
  return getJSON(env, `lead:${phone}`)
}
export async function setLeadSession(env, phone, session) {
  await putJSON(env, `lead:${phone}`, session)
}
export async function deleteLeadSession(env, phone) {
  await env.SESSIONS.delete(`lead:${phone}`)
}

// --- Admin mode flag (ADMIN_NUMBER only) ---
export async function getAdminSession(env, phone) {
  return (await env.SESSIONS.get(`admin:${phone}`)) === '1'
}
export async function setAdminSession(env, phone, on) {
  if (on) await env.SESSIONS.put(`admin:${phone}`, '1', { expirationTtl: SESSION_TTL_SECONDS })
  else await env.SESSIONS.delete(`admin:${phone}`)
}

// --- AI conversation history (last 10 turns) ---
export async function getConversation(env, phone) {
  return (await getJSON(env, `conv:${phone}`)) || []
}
export async function setConversation(env, phone, messages) {
  await putJSON(env, `conv:${phone}`, messages.slice(-10))
}
