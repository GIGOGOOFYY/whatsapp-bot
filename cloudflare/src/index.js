// PSG WhatsApp Bot — Cloudflare Worker entrypoint.
// Ported 1:1 from server.js (Express + Mongoose + local fs) to the Workers `fetch` handler
// (D1 + KV + R2). Business logic (lead wizard steps, hot-lead detection, rates parsing, AI
// prompt) is unchanged from the original — only the runtime plumbing changed.

import { sendMessage, sendButtons, sendList, sendImage, getMediaUrl, downloadMediaBuffer } from './lib/whatsapp.js'
import { getLeadSession, setLeadSession, deleteLeadSession, getAdminSession, setAdminSession, getConversation, setConversation } from './lib/session.js'
import { getRates, ratesToText, parseRateUpdate } from './lib/rates.js'
import { askAI, ocrImageFromBuffer, transcribeAudio } from './lib/ai.js'
import { saveInquiry, saveCustomerLead, logMedia } from './services/crm.js'
import { addMediaAttachment } from './services/sheets.js'
import { extractDimensions, extractPieces } from './services/glassParser.js'
import { putMedia, getMedia } from './lib/media.js'

const CANCEL_KEYWORDS = ['cancel', 'exit', 'stop', 'quit', 'nevermind', 'forget it', 'abort']

// Personal-number channel only (see computePersonalReply below): the bot should only wake up on
// a personal line for something that's actually about PSG's products/rates/quoting — not a bare
// greeting, and not a vague "I need some information" from someone who may not even be a
// customer (could be a friend/family member texting that number about anything). isHotLead()
// deliberately excludes "information"/"info"/etc. to avoid false wizard-triggers on the official
// channel, which means those messages fall through to the general AI assistant there — fine on
// the official number, but too eager on a personal line. This keyword gate requires the message
// to mention something concrete before any reply (including the AI fallback) is sent.
const PERSONAL_PRODUCT_KEYWORDS = [
  'glass', 'shisha', 'sheesha', 'mirror', 'window', 'door', 'aluminum', 'aluminium',
  'tempered', 'toughened', 'laminated', 'laminate', 'pvb',
  'dgu', 'double glaz', 'insulated',
  'bullet', 'br4', 'br6', 'br7', 'bulletproof',
  'thermal break', 'sliding', 'casement', 'tilt', 'awning', 'facade',
  'rate', 'rates', 'price', 'prices', 'pricing', 'quote', 'quotation', 'estimate',
  'thickness', 'sqft', 'sq ft', 'square feet', 'per foot', 'per sqft',
  'order', 'delivery', 'installation', 'fitting', 'psg', 'safety glass'
]

function isPersonalProductRelated(text) {
  const lower = text.toLowerCase()
  if (PERSONAL_PRODUCT_KEYWORDS.some(k => lower.includes(k))) return true
  if (/\d+\s*mm\b/i.test(text)) return true // e.g. "6mm", "12 mm"
  return false
}

// ==========================
// LEAD WIZARD — INTERACTIVE STEPS
// ==========================
async function askLeadQuestion(env, to, field) {
  switch (field) {
    case 'name':
      return sendMessage(env, to, '😊 Great! To get you a quotation, may I have your *name*?\n\n_(Type "cancel" anytime to stop)_')

    case 'company':
      return sendMessage(env, to, 'Your *company* or organization name?\n_(Type "none" if individual)_')

    case 'city':
      return sendMessage(env, to, 'Your *city / project location*?')

    case 'glassType':
      return sendList(env, to,
        'What *type of glass / product* do you need?',
        'Select Product',
        [
          { id: 'gt_1', title: 'Tempered Glass', description: '4x stronger, safe breakage' },
          { id: 'gt_2', title: 'Laminated Glass', description: 'Holds together when broken' },
          { id: 'gt_3', title: 'Bullet Resistant Glass', description: 'BR4 / BR6 / BR7 grades' },
          { id: 'gt_4', title: 'Double Glazed (DGU)', description: 'Thermal & noise insulation' },
          { id: 'gt_5', title: 'Aluminum Window/Door', description: 'Standard or Thermal Break' },
          { id: 'gt_6', title: 'Other', description: 'Specify in next message' }
        ]
      )

    case 'thermalBreak':
      return sendButtons(env, to,
        'Do you need *Thermal Break* or *Standard* aluminum?\n\n• *Thermal Break* — energy-efficient, recommended for AC spaces\n• *Standard* — cost-effective',
        [
          { id: 'tb_yes', title: 'Thermal Break' },
          { id: 'tb_no', title: 'Standard' }
        ]
      )

    case 'windowType':
      return sendList(env, to,
        'What *type* of window/door do you need?',
        'Select Type',
        [
          { id: 'wt_casement', title: 'Casement', description: 'Hinged, opens in/out' },
          { id: 'wt_sliding', title: 'Sliding', description: 'Horizontal sliding panels' },
          { id: 'wt_folding', title: 'Folding/Bi-fold', description: 'Accordion, opens wide' },
          { id: 'wt_tilt', title: 'Tilt & Turn', description: 'Tilt for ventilation or full open' },
          { id: 'wt_awning', title: 'Awning', description: 'Top-hinged, opens outward' },
          { id: 'wt_fixed', title: 'Fixed', description: 'Non-opening, for facades' },
          { id: 'wt_unsure', title: 'Not sure', description: 'Team will advise' }
        ]
      )

    case 'size':
      return sendMessage(env, to, 'What *size* do you require?\n\nYou can:\n• Type dimensions (e.g. _1200x2400mm_ or _4x8ft_)\n• Send a *photo* of your size list 📷')

    case 'quantity':
      return sendMessage(env, to, 'How many *pieces* do you need?')

    default:
      return sendMessage(env, to, 'Please provide the required information.')
  }
}

function resolveInteractiveReply(id) {
  const map = {
    gt_1: 'Tempered Glass',
    gt_2: 'Laminated Glass',
    gt_3: 'Bullet Resistant Glass',
    gt_4: 'Double Glazed Glass (DGU)',
    gt_5: 'Aluminum Window/Door',
    gt_6: 'Other',
    tb_yes: 'Thermal Break',
    tb_no: 'Standard (Non-Thermal Break)',
    wt_casement: 'Casement',
    wt_sliding: 'Sliding',
    wt_folding: 'Folding / Bi-fold',
    wt_tilt: 'Tilt & Turn',
    wt_awning: 'Awning',
    wt_fixed: 'Fixed',
    wt_unsure: 'Not sure'
  }
  return map[id] || id
}

const BASE_STEPS = ['name', 'company', 'city', 'glassType', 'size', 'quantity']
const ALUMINUM_STEPS = ['name', 'company', 'city', 'glassType', 'thermalBreak', 'windowType', 'size', 'quantity']

function getSteps(session) {
  const gt = (session.data.glassType || '').toLowerCase()
  const isAluminum = gt.includes('aluminum') || gt.includes('window') || gt.includes('door') || gt === 'gt_5'
  return isAluminum ? ALUMINUM_STEPS : BASE_STEPS
}

async function advanceLead(env, from, session) {
  const steps = getSteps(session)
  while (session.step < steps.length && session.data[steps[session.step]]) {
    session.step++
  }
  if (session.step < steps.length) {
    await setLeadSession(env, from, session)
    await askLeadQuestion(env, from, steps[session.step])
  } else {
    await completeLead(env, from, session)
  }
}

async function completeLead(env, from, session) {
  const lead = { phone: from, ...session.data }
  await deleteLeadSession(env, from)
  try { await saveCustomerLead(env, lead) } catch (e) { console.log('Lead save error:', e.message) }

  const windowDetails = lead.thermalBreak
    ? `\n*Frame:* ${lead.thermalBreak}\n*Style:* ${lead.windowType || 'Not specified'}`
    : ''
  const summary = `✅ *Thank you ${lead.name}!*\n\nYour inquiry has been recorded:\n\n*Product:* ${lead.glassType}${windowDetails}\n*Size:* ${lead.size}\n*Quantity:* ${lead.quantity}\n*Location:* ${lead.city}${lead.attachment ? `\n*Attachment:* ✅ received` : ''}\n\nA PSG representative will contact you shortly.\n\n_For urgent queries: +92-21-35042275_`
  await sendMessage(env, from, summary)
}

// ==========================
// HELPERS
// ==========================
function isRateRequest(text) {
  const t = text.toLowerCase()
  return ['i need rates', 'show rates', 'rate list', 'price list', 'current rates', 'tell me rates', 'what are the rates', 'rates please', 'send rates', 'rates only'].some(p => t.includes(p))
}

function isHotLead(text) {
  if (isRateRequest(text)) return false
  const t = text.toLowerCase()
  if (['information', 'info', 'what is', 'tell me', 'explain', 'how does', 'what are', 'good afternoon', 'good morning', 'good evening', 'hello', 'hi', 'assalam', 'salam'].some(k => t.includes(k))) return false
  return ['quotation', 'quote', 'buy', 'order', 'purchase', 'i need', 'i want', 'i require', 'send me price', 'give me price', 'price of', 'cost of', 'chahiye', 'required'].some(k => t.includes(k))
}

function scoreLead(text) {
  const t = text.toLowerCase()
  if (['quotation', 'quote', 'price', 'buy', 'order', 'require', 'urgent', 'need', 'purchase', 'cost', 'rate', 'how much'].some(k => t.includes(k))) return '🔴 HOT'
  if (['information', 'specification', 'catalog', 'brochure', 'specs', 'details', 'what is', 'tell me'].some(k => t.includes(k))) return '🟡 WARM'
  return '🔵 COLD'
}

function detectGlassType(text) {
  const t = text.toLowerCase()
  if (t.includes('bullet') || t.includes('br4') || t.includes('br6') || t.includes('br7')) return 'Bullet Resistant Glass'
  if (t.includes('laminated') || t.includes('laminate') || t.includes('pvb')) return 'Laminated Glass'
  if (t.includes('dgu') || t.includes('double glaz') || t.includes('insulated')) return 'Double Glazed Glass (DGU)'
  if (t.includes('aluminum') || t.includes('aluminium') || t.includes('window') || t.includes('door')) return 'Aluminum Window/Door'
  if (t.includes('tempered') || t.includes('toughened')) return 'Tempered Glass'
  if (/\d+mm/i.test(t)) return 'Tempered Glass'
  return null
}

// ==========================
// MEDIA HANDLER (KV replaces local /uploads + optional Cloudinary — see lib/media.js)
// ==========================
async function handleMedia(env, from, message, origin) {
  try {
    const mediaType = message.type
    const mediaObj = message[mediaType]
    const mediaId = mediaObj.id
    const mimeType = mediaObj.mime_type || ''
    const caption = mediaObj.caption || ''

    const tempUrl = await getMediaUrl(env, mediaId)
    let buffer = null
    let permanentUrl = `[media_id:${mediaId}]`
    let mediaKey = null

    try {
      buffer = await downloadMediaBuffer(env, tempUrl)
      const ext = mimeType.includes('pdf') ? 'pdf' : mimeType.includes('png') ? 'png' : 'jpg'
      mediaKey = `psg_${from}_${Date.now()}.${ext}`

      await putMedia(env, mediaKey, buffer, mimeType)
      permanentUrl = `${origin}/media/${mediaKey}`
    } catch (dlErr) {
      console.log('[MEDIA] Download/store failed:', dlErr.message)
      mediaKey = null
    }

    try { await logMedia(env, from, mediaType, mimeType, mediaKey, caption) } catch (e) {}
    try { await addMediaAttachment(env, from, mediaType, mimeType, permanentUrl, caption) } catch (e) {}

    // OCR
    let ocrText = null
    if (buffer && (mediaType === 'image' || mimeType.includes('pdf'))) {
      await sendMessage(env, from, `📎 File received! Analysing your size list... 🔍`)
      ocrText = await ocrImageFromBuffer(env, buffer, mimeType)
    }

    const session = await getLeadSession(env, from)
    if (session) {
      session.data.attachment = permanentUrl

      if (ocrText && ocrText !== 'UNCLEAR') {
        session.data.size = ocrText
        session.data.quantity = '[see size list above]'
        await sendMessage(env, from, `✅ *Sizes extracted:*\n\n${ocrText}\n\nNoted for your quotation!`)
      } else if (ocrText === 'UNCLEAR') {
        await sendMessage(env, from, `⚠️ Couldn't read sizes clearly. Please type them manually or call:\n📞 +92-21-35042275`)
      } else {
        await sendMessage(env, from, `📎 File saved for our team.`)
      }

      await advanceLead(env, from, session)
      return
    }

    // Not in wizard
    if (ocrText && ocrText !== 'UNCLEAR') {
      await sendMessage(env, from, `✅ *Sizes extracted:*\n\n${ocrText}\n\nWould you like a quotation? Our team will be in touch.\n📞 +92-21-35042275`)
    } else if (ocrText === 'UNCLEAR') {
      await sendMessage(env, from, `⚠️ Image received but couldn't read clearly. Please send a clearer photo or call:\n📞 +92-21-35042275`)
    } else {
      await sendMessage(env, from, `📎 File received! Our team will review it.\n📞 +92-21-35042275`)
    }

    try { await saveInquiry(env, from, `[${mediaType.toUpperCase()}] ${caption}`, `Media: ${permanentUrl}`) } catch (e) {}

  } catch (err) {
    console.log('Media handler error:', err.message)
    await sendMessage(env, from, `Sorry, couldn't process your file. Please call +92-21-35042275`)
  }
}

// ==========================
// WEBHOOK
// ==========================
async function handleWebhookGet(request, env) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode && token === (env.VERIFY_TOKEN || 'mytoken123')) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

async function handleWebhookPost(request, env, origin) {
  try {
    const body = await request.json()
    const value = body.entry?.[0]?.changes?.[0]?.value
    const message = value?.messages?.[0]
    if (!message) return new Response('OK', { status: 200 })

    const from = message.from

    // Media
    if (['image', 'document', 'video'].includes(message.type)) {
      await handleMedia(env, from, message, origin)
      return new Response('OK', { status: 200 })
    }

    // Interactive reply (button tap or list selection)
    let text = ''
    if (message.type === 'interactive') {
      const ir = message.interactive
      if (ir.type === 'button_reply') text = resolveInteractiveReply(ir.button_reply.id)
      else if (ir.type === 'list_reply') text = resolveInteractiveReply(ir.list_reply.id)
    } else if (message.type === 'audio') {
      // Voice note — transcribe, then let the transcript flow through the exact same pipeline
      // as a typed message (lead wizard, hot-lead detection, AI chat) below.
      try {
        const tempUrl = await getMediaUrl(env, message.audio.id)
        const buffer = await downloadMediaBuffer(env, tempUrl)
        const transcript = await transcribeAudio(env, buffer, message.audio.mime_type || 'audio/ogg')

        if (!transcript || transcript === 'INAUDIBLE') {
          await sendMessage(env, from, `🎤 Sorry, couldn't understand that voice message clearly. Please type your message or call:\n📞 +92-21-35042275`)
          return new Response('OK', { status: 200 })
        }
        text = transcript
      } catch (err) {
        console.log('[Audio] Error:', err.message)
        await sendMessage(env, from, `🎤 Sorry, couldn't process your voice message. Please type your message or call:\n📞 +92-21-35042275`)
        return new Response('OK', { status: 200 })
      }
    } else {
      text = message.text?.body?.trim() || ''
    }

    if (!text) return new Response('OK', { status: 200 })
    console.log(`[${from}]: ${text}`)

    // Global cancel
    if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
      await deleteLeadSession(env, from)
      await setAdminSession(env, from, false)
      await sendMessage(env, from, `✅ Cancelled. How can I help you?`)
      return new Response('OK', { status: 200 })
    }

    // Admin
    if (from === env.ADMIN_NUMBER) {
      const lower = text.toLowerCase()
      if (lower === 'admin' || lower === 'show rates' || lower === 'rates') {
        await setAdminSession(env, from, true)
        await sendMessage(env, from, ratesToText(await getRates(env)))
        return new Response('OK', { status: 200 })
      }
      if (lower.startsWith('update ') || lower.startsWith('set ')) {
        const result = await parseRateUpdate(env, text)
        await sendMessage(env, from, result || `❌ Format not recognised.\nExamples:\nupdate lamination 350\nupdate 6mm 80`)
        return new Response('OK', { status: 200 })
      }
      if (lower === 'exit' || lower === 'done' || lower === 'quit') {
        await setAdminSession(env, from, false)
        await sendMessage(env, from, '✅ Exited admin mode.')
        return new Response('OK', { status: 200 })
      }
      if (lower.startsWith('listen')) {
        await handleListenCommand(env, from, text)
        return new Response('OK', { status: 200 })
      }
      if (await getAdminSession(env, from)) {
        await sendMessage(env, from, `_Admin mode active._\n\n${ratesToText(await getRates(env))}`)
        return new Response('OK', { status: 200 })
      }
    }

    // Rate request
    if (isRateRequest(text)) {
      await sendMessage(env, from, ratesToText(await getRates(env)))
      return new Response('OK', { status: 200 })
    }

    // Handover
    if (['talk to sales', 'need representative', 'call me', 'speak to someone', 'human', 'agent', 'sales team', 'representative'].some(k => text.toLowerCase().includes(k))) {
      await sendMessage(env, from, `A PSG representative will contact you shortly. 📞\n\nPlease share:\n*Name:*\n*Company:*\n*City:*\n*Best time to call:*`)
      try { await saveInquiry(env, from, text, 'HANDOVER REQUEST') } catch (e) {}
      return new Response('OK', { status: 200 })
    }

    // Lead wizard
    let session = await getLeadSession(env, from)
    if (session) {
      if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
        await deleteLeadSession(env, from)
        await sendMessage(env, from, `❌ Quotation cancelled. Type "quote" to start again.`)
        return new Response('OK', { status: 200 })
      }

      const steps = getSteps(session)
      const currentField = steps[session.step]

      if (currentField) {
        session.data[currentField] = text
        session.step++
        await advanceLead(env, from, session)
      }

      return new Response('OK', { status: 200 })
    }

    // Trigger wizard on hot lead
    if (isHotLead(text)) {
      const preData = {}
      const gt = detectGlassType(text)
      if (gt) preData.glassType = gt
      const dims = extractDimensions(text)
      if (dims) preData.size = text
      const pieces = extractPieces(text)
      if (pieces > 1) preData.quantity = String(pieces)

      const newSession = { step: 0, data: preData }
      await setLeadSession(env, from, newSession)
      await advanceLead(env, from, newSession)
      return new Response('OK', { status: 200 })
    }

    // AI flow
    const conversation = await getConversation(env, from)
    conversation.push({ role: 'user', content: text })

    const aiReply = await askAI(env, from, text, conversation)
    conversation.push({ role: 'assistant', content: aiReply })
    await setConversation(env, from, conversation)
    await sendMessage(env, from, aiReply)

    console.log(`Lead [${from}]: ${scoreLead(text)} | "${text}"`)
    try { await saveInquiry(env, from, text, aiReply) } catch (e) {}

    return new Response('OK', { status: 200 })

  } catch (err) {
    console.log('ERROR:', err.message)
    return new Response('Server error', { status: 500 })
  }
}

// ==========================
// MEDIA SERVING (replaces the fact that local /uploads files had no public URL)
// ==========================
async function handleMediaGet(request, env, key) {
  const object = await getMedia(env, key)
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(object.body, { headers: { 'Content-Type': object.contentType } })
}

// ==========================
// PERSONAL-NUMBER CHANNEL
// ==========================
// Bridge for personal WhatsApp numbers (yours, Adnan's, etc.) linked via the always-on
// `whatsapp-listener/` service instead of Meta's official Cloud API. That service owns the real
// WhatsApp Web session (so the phone keeps working 100% normally for personal chats/calls) and
// only forwards messages here to ask "does this need a reply, and what should it say". This
// route decides the reply; the listener service is the one that actually sends it back, since
// only it holds the linked session for that number.
//
// Kept deliberately separate from handleWebhookPost() above so the official Cloud API flow
// (+923330321371) is never touched by this — this whole section only reuses the pure/stateless
// helper functions already defined above (isRateRequest, isHotLead, detectGlassType, getSteps,
// etc.), it doesn't modify them.
//
// v1 scope: text only. No image/voice-note handling on this channel yet (that would need the
// listener service to download WhatsApp Web media and forward it here, which isn't built yet).
// Interactive buttons/lists aren't reliably supported over whatsapp-web.js, so the lead wizard
// falls back to a numbered text menu here — see PERSONAL_STEP_OPTIONS below.

const PERSONAL_STEP_OPTIONS = {
  glassType: [
    { value: 'Tempered Glass', desc: '4x stronger, safe breakage' },
    { value: 'Laminated Glass', desc: 'Holds together when broken' },
    { value: 'Bullet Resistant Glass', desc: 'BR4 / BR6 / BR7 grades' },
    { value: 'Double Glazed Glass (DGU)', desc: 'Thermal & noise insulation' },
    { value: 'Aluminum Window/Door', desc: 'Standard or Thermal Break' },
    { value: 'Other', desc: 'Specify in next message' }
  ],
  thermalBreak: [
    { value: 'Thermal Break', desc: 'Energy-efficient, recommended for AC spaces' },
    { value: 'Standard (Non-Thermal Break)', desc: 'Cost-effective' }
  ],
  windowType: [
    { value: 'Casement', desc: 'Hinged, opens in/out' },
    { value: 'Sliding', desc: 'Horizontal sliding panels' },
    { value: 'Folding / Bi-fold', desc: 'Accordion, opens wide' },
    { value: 'Tilt & Turn', desc: 'Tilt for ventilation or full open' },
    { value: 'Awning', desc: 'Top-hinged, opens outward' },
    { value: 'Fixed', desc: 'Non-opening, for facades' },
    { value: 'Not sure', desc: 'Team will advise' }
  ]
}

function personalMenuText(field) {
  const opts = PERSONAL_STEP_OPTIONS[field]
  if (!opts) return ''
  return opts.map((o, i) => `${i + 1}. *${o.value}*${o.desc ? ' — ' + o.desc : ''}`).join('\n') + '\n\n_Reply with the number_'
}

function askPersonalLeadQuestion(field) {
  switch (field) {
    case 'name': return '😊 Great! To get you a quotation, may I have your *name*?\n\n_(Type "cancel" anytime to stop)_'
    case 'company': return 'Your *company* or organization name?\n_(Type "none" if individual)_'
    case 'city': return 'Your *city / project location*?'
    case 'glassType': return `What *type of glass / product* do you need?\n\n${personalMenuText('glassType')}`
    case 'thermalBreak': return `Do you need *Thermal Break* or *Standard* aluminum?\n\n${personalMenuText('thermalBreak')}`
    case 'windowType': return `What *type* of window/door do you need?\n\n${personalMenuText('windowType')}`
    case 'size': return 'What *size* do you require?\n\nType dimensions (e.g. _1200x2400mm_ or _4x8ft_)'
    case 'quantity': return 'How many *pieces* do you need?'
    default: return 'Please provide the required information.'
  }
}

async function completePersonalLead(env, from, session) {
  const lead = { phone: from, ...session.data }
  await deleteLeadSession(env, from)
  try { await saveCustomerLead(env, lead) } catch (e) { console.log('Lead save error:', e.message) }
  const windowDetails = lead.thermalBreak
    ? `\n*Frame:* ${lead.thermalBreak}\n*Style:* ${lead.windowType || 'Not specified'}`
    : ''
  return [`✅ *Thank you ${lead.name}!*\n\nYour inquiry has been recorded:\n\n*Product:* ${lead.glassType}${windowDetails}\n*Size:* ${lead.size}\n*Quantity:* ${lead.quantity}\n*Location:* ${lead.city}\n\nA PSG representative will contact you shortly.\n\n_For urgent queries: +92-21-35042275_`]
}

async function advancePersonalLead(env, from, session) {
  const steps = getSteps(session)
  while (session.step < steps.length && session.data[steps[session.step]]) session.step++
  if (session.step < steps.length) {
    const field = steps[session.step]
    session.pendingOptions = PERSONAL_STEP_OPTIONS[field] || null
    await setLeadSession(env, from, session)
    return [askPersonalLeadQuestion(field)]
  }
  return completePersonalLead(env, from, session)
}

async function computePersonalReply(env, from, rawText, label) {
  const text = (rawText || '').trim()
  if (!text) return []

  if (CANCEL_KEYWORDS.includes(text.toLowerCase())) {
    await deleteLeadSession(env, from)
    await setAdminSession(env, from, false)
    return ['✅ Cancelled. How can I help you?']
  }

  let session = await getLeadSession(env, from)

  // Bare-number reply against the menu we last sent (stands in for a native button/list tap).
  // These fields (glassType/thermalBreak/windowType) are always multiple-choice — never accept
  // free text for them, or a stray "9"/"idk" would get saved as the product type. Re-show the
  // menu instead of silently falling through to the raw-text branch below.
  if (session && session.pendingOptions) {
    const opt = /^\d+$/.test(text) ? session.pendingOptions[parseInt(text, 10) - 1] : null
    if (opt) {
      const steps = getSteps(session)
      const field = steps[session.step]
      session.data[field] = opt.value
      session.step++
      session.pendingOptions = null
      return advancePersonalLead(env, from, session)
    }
    const steps = getSteps(session)
    const field = steps[session.step]
    return [`Please reply with just the number.\n\n${personalMenuText(field)}`]
  }

  if (session) {
    const steps = getSteps(session)
    const field = steps[session.step]
    if (field) {
      session.data[field] = text
      session.step++
      session.pendingOptions = null
      return advancePersonalLead(env, from, session)
    }
    return []
  }

  // A bare "Hi" / "Assalam o Alaikum" or a vague "I need some information" on someone's personal
  // number shouldn't wake the bot — only reply once the message actually references PSG's
  // products/rates/quoting, or is an explicit request to talk to a human. Mid-wizard replies
  // never reach here (handled by the `session` branch above), so this only gates the very first
  // message of a fresh conversation.
  const isHandoverRequest = ['talk to sales', 'need representative', 'call me', 'speak to someone', 'human', 'agent', 'sales team', 'representative'].some(k => text.toLowerCase().includes(k))
  if (!isRateRequest(text) && !isHotLead(text) && !isPersonalProductRelated(text) && !isHandoverRequest) {
    return []
  }

  if (isRateRequest(text)) {
    return [ratesToText(await getRates(env))]
  }

  if (isHandoverRequest) {
    try { await saveInquiry(env, from, text, 'HANDOVER REQUEST') } catch (e) {}
    return [`A PSG representative will contact you shortly. 📞\n\nPlease share:\n*Name:*\n*Company:*\n*City:*\n*Best time to call:*`]
  }

  if (isHotLead(text)) {
    const preData = {}
    const gt = detectGlassType(text)
    if (gt) preData.glassType = gt
    const dims = extractDimensions(text)
    if (dims) preData.size = text
    const pieces = extractPieces(text)
    if (pieces > 1) preData.quantity = String(pieces)

    const intro = `You've reached the PSG AI Assistant — I'll help you with your ${gt || 'enquiry'} from here.`
    const newSession = { step: 0, data: preData }
    return [intro, ...(await advancePersonalLead(env, from, newSession))]
  }

  const conversation = await getConversation(env, from)
  conversation.push({ role: 'user', content: text })
  const aiReply = await askAI(env, from, text, conversation)
  conversation.push({ role: 'assistant', content: aiReply })
  await setConversation(env, from, conversation)
  try { await saveInquiry(env, from, text, aiReply) } catch (e) {}
  return [aiReply]
}

async function handlePersonalWebhook(request, env) {
  if (!env.LISTENER_API_KEY || request.headers.get('x-listener-key') !== env.LISTENER_API_KEY) {
    return new Response('Unauthorized', { status: 401 })
  }
  try {
    const { from, text, label } = await request.json()
    if (!from || !text) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } })
    console.log(`[personal:${label}] [${from}]: ${text}`)
    const messages = await computePersonalReply(env, from, text, label)
    return new Response(JSON.stringify({ messages }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.log('PERSONAL ERROR:', err.message)
    return new Response(JSON.stringify({ messages: [] }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// Admin-only: "listen <label> <phone>" starts/links a personal number via whatsapp-listener/,
// "listen status <label>" checks progress. Replies are sent straight to the admin (Cloud API).
async function handleListenCommand(env, from, text) {
  if (!env.LISTENER_BASE_URL || !env.LISTENER_API_KEY) {
    await sendMessage(env, from, `Listener service isn't configured yet — set LISTENER_BASE_URL (wrangler.toml) and the LISTENER_API_KEY secret first.`)
    return
  }
  // Lowercase before splitting — phone keyboards auto-capitalize the first word ("Listen ..."),
  // and people naturally type names capitalized ("listen Adnan ..."). Without normalizing here,
  // "listen Adnan 923..." and a later "listen status adnan" would look like two different
  // sessions to the listener service (labels are matched exactly).
  const parts = text.trim().toLowerCase().split(/\s+/)

  if (parts[1] === 'status' && parts[2]) {
    const label = parts[2]
    try {
      const res = await fetch(`${env.LISTENER_BASE_URL}/sessions/${label}/status`, {
        headers: { 'x-listener-key': env.LISTENER_API_KEY }
      })
      const data = await res.json()
      if (data.pairingCode) {
        await sendMessage(env, from, `*${label}* status: ${data.state}\nCode: ${data.pairingCode}`)
      } else if (data.state === 'waiting_qr') {
        // Pairing codes don't work on every account/region — this is the fallback. Meta fetches
        // the image itself, so the listener needs to be reachable at LISTENER_BASE_URL for this
        // to load (it always is, since we just called its /status endpoint above).
        const qrUrl = `${env.LISTENER_BASE_URL}/sessions/${label}/qr.png?key=${env.LISTENER_API_KEY}`
        await sendImage(env, from, qrUrl, `Scan this from WhatsApp → Settings → Linked Devices → Link a Device on the ${label} phone.`)
      } else {
        await sendMessage(env, from, `*${label}* status: ${data.state}`)
      }
    } catch (e) {
      await sendMessage(env, from, `Couldn't reach the listener service: ${e.message}`)
    }
    return
  }

  const label = parts[1]
  const phone = parts[2]
  if (!label || !phone) {
    await sendMessage(env, from, `Format:\n*listen <label> <phone>* — start linking a number\n*listen status <label>* — check progress\n\ne.g. listen adnan 923000306648`)
    return
  }

  try {
    const res = await fetch(`${env.LISTENER_BASE_URL}/sessions/${label}/start`, {
      method: 'POST',
      headers: { 'x-listener-key': env.LISTENER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    })
    const data = await res.json()
    if (data.pairingCode) {
      await sendMessage(env, from,
        `📱 Linking *${label}* (${phone})\n\nOn that phone: WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead" → enter:\n\n*${data.pairingCode}*\n\nCode expires in a few minutes. Send "listen status ${label}" to confirm once it's scanned.`)
    } else if (data.state === 'ready') {
      await sendMessage(env, from, `*${label}* is already linked and listening.`)
    } else {
      await sendMessage(env, from, `Started linking *${label}* — send "listen status ${label}" in a few seconds to get the code.`)
    }
  } catch (e) {
    await sendMessage(env, from, `Couldn't reach the listener service: ${e.message}\n\nMake sure it's running and LISTENER_BASE_URL is correct.`)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/webhook' && request.method === 'GET') {
      return handleWebhookGet(request, env)
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookPost(request, env, url.origin)
    }
    if (url.pathname === '/webhook/personal' && request.method === 'POST') {
      return handlePersonalWebhook(request, env)
    }
    if (url.pathname.startsWith('/media/') && request.method === 'GET') {
      return handleMediaGet(request, env, url.pathname.replace('/media/', ''))
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('PSG WhatsApp Bot — running on Cloudflare Workers', { status: 200 })
    }

    return new Response('Not found', { status: 404 })
  }
}
