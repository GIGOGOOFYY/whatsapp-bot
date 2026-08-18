// Media storage backed by Workers KV (the same free SESSIONS namespace used for sessions/rates)
// instead of R2 — R2 requires a payment method on file to enable, even on the free tier; KV
// doesn't. Free KV limits: 1GB total storage, 25MB per value, 1000 writes/day, 100k reads/day —
// comfortably enough for occasional customer photo/PDF uploads on a bot this size.
//
// KV values are stored base64-encoded (binary-safe as a string), with the MIME type stashed in
// KV metadata so it can be served back with the right Content-Type.

import { arrayBufferToBase64, base64ToArrayBuffer } from './util.js'

// Base64 inflates size by ~4/3. Stay under KV's 25MB value cap with headroom.
const MAX_RAW_BYTES = 18 * 1024 * 1024 // ~18MB raw -> ~24MB base64

export async function putMedia(env, key, arrayBuffer, contentType) {
  if (arrayBuffer.byteLength > MAX_RAW_BYTES) {
    throw new Error(`File too large for KV storage (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB > 18MB limit)`)
  }
  const base64 = arrayBufferToBase64(arrayBuffer)
  await env.SESSIONS.put(`media:${key}`, base64, {
    metadata: { contentType: contentType || 'application/octet-stream' }
  })
}

export async function getMedia(env, key) {
  const { value, metadata } = await env.SESSIONS.getWithMetadata(`media:${key}`)
  if (!value) return null
  return {
    body: base64ToArrayBuffer(value),
    contentType: metadata?.contentType || 'application/octet-stream'
  }
}
