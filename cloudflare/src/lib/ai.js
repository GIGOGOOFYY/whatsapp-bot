// Replaces the `openai` SDK usage in server.js with a direct fetch call to the OpenRouter
// REST API. The SDK is fetch-based under the hood anyway and does run on Workers, but calling
// the endpoint directly removes a large dependency and any risk of it pulling in Node-only
// internals during the esbuild bundle step.

import kb from '../knowledge.js'
import { getRates } from './rates.js'
import { detectLayers, extractThicknesses, extractDimensions, extractPieces } from '../services/glassParser.js'
import { calculateSqft } from '../services/calculator.js'
import { arrayBufferToBase64 } from './util.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

function orHeaders(env) {
  return {
    Authorization: `Bearer ${env.OPENROUTER_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://pakistansafetyglass.com.pk',
    'X-OpenRouter-Title': 'PSG WhatsApp Bot'
  }
}

async function chatCompletion(env, model, messages, maxTokens) {
  const body = { model, messages }
  if (maxTokens) body.max_tokens = maxTokens

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: orHeaders(env),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    console.log('[OpenRouter DEBUG]', {
      model,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type'),
      cfRay: res.headers.get('cf-ray'),
      server: res.headers.get('server'),
      bodyLength: text.length,
      body: text || '(empty)',
      hasKey: !!env.OPENROUTER_KEY,
      keyPrefix: env.OPENROUTER_KEY ? env.OPENROUTER_KEY.slice(0, 6) : null
    })
    throw new Error(`OpenRouter ${model} failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content
}

export async function ocrImageFromBuffer(env, buffer, mimeType) {
  try {
    const base64 = arrayBufferToBase64(buffer)
    const imgMime = mimeType.includes('png') ? 'image/png' : 'image/jpeg'
    const dataUrl = `data:${imgMime};base64,${base64}`

    const content = await chatCompletion(env, 'google/gemini-3.5-flash-lite', [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: 'This is a glass order list. Extract all dimensions (width x height in mm or ft) and quantities. Return as a clean list like:\n1933 x 595 = 10 pcs\netc.\nIf unclear, reply exactly: UNCLEAR' }
      ]
    }], 1000)

    return (content || 'UNCLEAR').trim()
  } catch (err) {
    console.log('[OCR] Error:', err.message)
    return 'UNCLEAR'
  }
}

function audioFormatFromMime(mimeType) {
  // WhatsApp voice notes are typically audio/ogg (Opus). Cover the common alternatives too.
  const m = (mimeType || '').toLowerCase()
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a'
  if (m.includes('webm')) return 'webm'
  if (m.includes('aac')) return 'aac'
  if (m.includes('flac')) return 'flac'
  return 'ogg'
}

// Transcribes WhatsApp voice notes so they can flow through the exact same pipeline as a typed
// message (lead wizard, hot-lead detection, AI chat) — see index.js's audio branch.
export async function transcribeAudio(env, buffer, mimeType) {
  try {
    const base64 = arrayBufferToBase64(buffer)
    const format = audioFormatFromMime(mimeType)

    const content = await chatCompletion(env, 'google/gemini-3.5-flash-lite', [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: base64, format } },
        { type: 'text', text: 'Transcribe this voice message exactly as spoken. It may be in English, Urdu, or Roman Urdu — transcribe in whatever language/script it was spoken in. Return ONLY the transcription, nothing else. If it is silent or completely inaudible, reply exactly: INAUDIBLE' }
      ]
    }])

    return (content || 'INAUDIBLE').trim()
  } catch (err) {
    console.log('[Transcribe] Error:', err.message)
    return null
  }
}

function generateCalculation(text) {
  const dimensions = extractDimensions(text)
  if (!dimensions) return null
  const pieces = extractPieces(text)
  const layers = detectLayers(text)
  const thicknesses = extractThicknesses(text)
  const sqft = calculateSqft(dimensions.widthMM, dimensions.heightMM, pieces, layers)
  return { widthMM: dimensions.widthMM, heightMM: dimensions.heightMM, pieces, layers, thicknesses, sqft }
}

// google/gemma-3-27b-it:free and deepseek/deepseek-chat-v3-0324:free were removed here —
// OpenRouter retired both free slugs (confirmed via live 404 responses on 2026-08-15).
// google/gemini-flash-1.5 also retired ("No endpoints found") — replaced with the current
// google/gemini-3.5-flash-lite (verified live via the OpenRouter API on 2026-08-15).
// Model catalogs on OpenRouter rotate; if this list starts erroring again, check
// https://openrouter.ai/models?max_price=0 for current free options before re-adding any.
const MODELS = [
  'openai/gpt-4o-mini',
  'google/gemini-3.5-flash-lite',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-4o-mini'
]

export async function askAI(env, userId, userMessage, conversation) {
  const r = await getRates(env)
  const calculation = generateCalculation(userMessage)

  let calculationText = ''
  if (calculation) {
    calculationText = `
PRE-CALCULATED VALUES:
Width: ${calculation.widthMM}mm | Height: ${calculation.heightMM}mm | Pieces: ${calculation.pieces} | Layers: ${calculation.layers}
Thicknesses: ${calculation.thicknesses.join(' + ')} | Total Sqft: ${calculation.sqft}
- Use provided sqft ONLY, never recalculate
- For laminated (e.g. 12+12): price each layer separately then add lamination
`
  }

  const ratesText = `
CURRENT RATES (PKR/sqft):
Glass: ${Object.entries(r.glass || {}).filter(([k]) => k !== 'note').map(([k, v]) => `${k.replace(/_/g, ' ')} Rs.${v ?? 'TBD'}`).join(' | ')}
Tempering: ${Object.entries(r.tempering || {}).filter(([k]) => k !== 'note').map(([k, v]) => `${k} Rs.${v ?? 'TBD'}`).join(' | ')}
Lamination: Rs.${r.lamination?.per_sqft ?? 'TBD'} | Polishing: Rs.${r.polishing?.flat_polish ?? 'TBD'} | DGU: Rs.${r.double_glaze?.per_sqft ?? 'TBD'}
`

  const messages = [
    {
      role: 'system',
      content: `You are a professional sales assistant for Pakistan Safety Glass (PSG) on WhatsApp.
Company: ${kb.website.name} | Phone: ${kb.website.phone.join(', ')} | Address: ${kb.website.address}

FULL PRODUCT CATALOG (this is authoritative — check it before saying PSG doesn't offer something.
Sub-variants matter, e.g. "Mirrors" includes Antique, Miralite, Colored/Tinted, not just Standard):
${kb.products.map(p => `- ${p.name}: ${p.description}`).join('\n')}

${ratesText}
${calculationText}

DGU RULE: In "X + Y + Z" DGU specs, Y is the SPACER GAP (not glass). "Low-E + 12 + 6mm" = Low-E glass + 12mm air gap + 6mm glass.
ALUMINUM RULE: Always ask Thermal Break vs Standard, and window type, before quoting.
LAMINATED RULE: 6+6 = two 6mm panes + lamination. Never treat as single pane.
RATE TYPE RULE: Glass Supply and Tempering are two SEPARATE, standalone price lists for two different scenarios. You are NEVER, under any circumstance, allowed to add them together or state a combined/total figure — not even as an extra "if you want the full factory rate" courtesy line. Forbidden phrases: "supply + tempering", "total hoga", "total would be", or any sentence that adds the two numbers.
1. Company / Factory rate = PSG supplies the glass AND processes it, as ONE bundled price. Quote ONLY the "Glass" price list value above (e.g. Rs.750/sqft for 10mm) — that number is already the complete finished price.
2. RC rate (also called "RC/Glass") = the CUSTOMER supplies their own glass; PSG only does the tempering/processing. Quote ONLY the "Tempering" price list value above (e.g. Rs.85/sqft for 10mm).
If a customer says "RC" or mentions bringing their own glass, quote Tempering only. If they say "Factory"/"Company rate", quote Glass (supply) only. If a customer just asks for "rates" or "price" with no scenario specified, list Glass Supply and Tempering as two separate line items and ask which scenario applies (are they supplying their own glass or not) — do not pick one for them and do not compute anything combined.

RULES: Short professional replies. *Bold* prices. TBD rates → "please call +92-21-35042275". End quotes with "_Estimated. Final price confirmed at order._" Never claim a product/variant is unavailable unless it is genuinely absent from the catalog above — if you're unsure, say a representative will confirm rather than saying "we don't offer that."

WHY PSG: ${kb.competitors.whyPSG}`
    },
    ...conversation
  ]

  for (const model of MODELS) {
    try {
      const content = await chatCompletion(env, model, messages)
      if (content) return content
    } catch (e) {
      console.log(`Failed: ${model}`, e.message)
    }
  }

  return `Our assistant is busy.\n\nPlease call:\n+92-21-35042275\n+92-308-2909634`
}

export { generateCalculation }
