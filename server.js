const express = require('express')
const axios = require('axios')
const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')
const kb = require('./knowledge')

require('dotenv').config()

const app = express()
app.use(express.json())

const connectDB = require('./database/db')
const { saveInquiry, saveCustomerLead } = require('./services/crmService')
const { detectLayers, extractThicknesses, extractDimensions, extractPieces } = require('./services/glassParser')
const { calculateSqft } = require('./services/calculator')

connectDB()

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mytoken123'
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || ''
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || ''
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID
const ADMIN_NUMBER = process.env.ADMIN_NUMBER
const RATES_FILE = path.join(__dirname, 'Rates.json')

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://pakistansafetyglass.com.pk',
    'X-OpenRouter-Title': 'PSG WhatsApp Bot'
  }
})

const conversations = {}
const adminSessions = {}
const leadSessions = {}
const CANCEL_KEYWORDS = ['cancel', 'exit', 'stop', 'quit', 'nevermind', 'forget it', 'abort']

// ==========================
// INTERACTIVE MESSAGE SENDERS
// ==========================

// Plain text message
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  )
}

// Up to 3 buttons
async function sendButtons(to, bodyText, buttons) {
  // buttons = [{ id: 'btn_1', title: 'Option A' }, ...]  max 3
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
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
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  )
}

// List menu — up to 10 items, grouped in one section
async function sendList(to, bodyText, buttonLabel, items) {
  // items = [{ id: 'item_1', title: 'Option', description: 'optional' }, ...]  max 10
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
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
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  )
}

// ==========================
// LEAD WIZARD — INTERACTIVE STEPS
// ==========================

// Steps that need interactive UI — keyed by field name
async function askLeadQuestion(to, field, session) {
  switch (field) {
    case 'name':
      return sendMessage(to, '😊 Great! To get you a quotation, may I have your *name*?\n\n_(Type "cancel" anytime to stop)_')

    case 'company':
      return sendMessage(to, 'Your *company* or organization name?\n_(Type "none" if individual)_')

    case 'city':
      return sendMessage(to, 'Your *city / project location*?')

    case 'glassType':
      return sendList(to,
        'What *type of glass / product* do you need?',
        'Select Product',
        [
          { id: 'gt_1', title: 'Tempered Glass',         description: '4x stronger, safe breakage' },
          { id: 'gt_2', title: 'Laminated Glass',        description: 'Holds together when broken' },
          { id: 'gt_3', title: 'Bullet Resistant Glass', description: 'BR4 / BR6 / BR7 grades' },
          { id: 'gt_4', title: 'Double Glazed (DGU)',    description: 'Thermal & noise insulation' },
          { id: 'gt_5', title: 'Aluminum Window/Door',   description: 'Standard or Thermal Break' },
          { id: 'gt_6', title: 'Other',                  description: 'Specify in next message' }
        ]
      )

    case 'thermalBreak':
      return sendButtons(to,
        'Do you need *Thermal Break* or *Standard* aluminum?\n\n• *Thermal Break* — energy-efficient, recommended for AC spaces\n• *Standard* — cost-effective',
        [
          { id: 'tb_yes', title: 'Thermal Break' },
          { id: 'tb_no',  title: 'Standard' }
        ]
      )

    case 'windowType':
      return sendList(to,
        'What *type* of window/door do you need?',
        'Select Type',
        [
          { id: 'wt_casement', title: 'Casement',      description: 'Hinged, opens in/out' },
          { id: 'wt_sliding',  title: 'Sliding',       description: 'Horizontal sliding panels' },
          { id: 'wt_folding',  title: 'Folding/Bi-fold',description: 'Accordion, opens wide' },
          { id: 'wt_tilt',     title: 'Tilt & Turn',   description: 'Tilt for ventilation or full open' },
          { id: 'wt_awning',   title: 'Awning',        description: 'Top-hinged, opens outward' },
          { id: 'wt_fixed',    title: 'Fixed',         description: 'Non-opening, for facades' },
          { id: 'wt_unsure',   title: 'Not sure',      description: 'Team will advise' }
        ]
      )

    case 'size':
      return sendMessage(to, 'What *size* do you require?\n\nYou can:\n• Type dimensions (e.g. _1200x2400mm_ or _4x8ft_)\n• Send a *photo* of your size list 📷')

    case 'quantity':
      return sendMessage(to, 'How many *pieces* do you need?')

    default:
      return sendMessage(to, 'Please provide the required information.')
  }
}

// Resolve interactive button/list reply IDs to human-readable values
function resolveInteractiveReply(id) {
  const map = {
    'gt_1': 'Tempered Glass',
    'gt_2': 'Laminated Glass',
    'gt_3': 'Bullet Resistant Glass',
    'gt_4': 'Double Glazed Glass (DGU)',
    'gt_5': 'Aluminum Window/Door',
    'gt_6': 'Other',
    'tb_yes': 'Thermal Break',
    'tb_no': 'Standard (Non-Thermal Break)',
    'wt_casement': 'Casement',
    'wt_sliding': 'Sliding',
    'wt_folding': 'Folding / Bi-fold',
    'wt_tilt': 'Tilt & Turn',
    'wt_awning': 'Awning',
    'wt_fixed': 'Fixed',
    'wt_unsure': 'Not sure'
  }
  return map[id] || id
}

// Dynamic step list — aluminum gets 2 extra steps
const BASE_STEPS = ['name', 'company', 'city', 'glassType', 'size', 'quantity']
const ALUMINUM_STEPS = ['name', 'company', 'city', 'glassType', 'thermalBreak', 'windowType', 'size', 'quantity']

function getSteps(session) {
  const gt = (session.data.glassType || '').toLowerCase()
  const isAluminum = gt.includes('aluminum') || gt.includes('window') || gt.includes('door') || gt === 'gt_5'
  return isAluminum ? ALUMINUM_STEPS : BASE_STEPS
}

async function advanceLead(from, session) {
  const steps = getSteps(session)
  // Find next unfilled step
  while (session.step < steps.length && session.data[steps[session.step]]) {
    session.step++
  }
  if (session.step < steps.length) {
    await askLeadQuestion(from, steps[session.step], session)
  } else {
    await completeLead(from, session)
  }
}

async function completeLead(from, session) {
  const lead = { phone: from, ...session.data }
  delete leadSessions[from]
  try { await saveCustomerLead(lead) } catch (e) { console.log('Lead save error:', e.message) }

  const windowDetails = lead.thermalBreak
    ? `\n*Frame:* ${lead.thermalBreak}\n*Style:* ${lead.windowType || 'Not specified'}`
    : ''
  const summary = `✅ *Thank you ${lead.name}!*\n\nYour inquiry has been recorded:\n\n*Product:* ${lead.glassType}${windowDetails}\n*Size:* ${lead.size}\n*Quantity:* ${lead.quantity}\n*Location:* ${lead.city}${lead.attachment ? `\n*Attachment:* ✅ received` : ''}\n\nA PSG representative will contact you shortly.\n\n_For urgent queries: +92-21-35042275_`
  await sendMessage(from, summary)
}

// ==========================
// OCR via OpenRouter vision
// ==========================
async function ocrImageFromBuffer(buffer, mimeType) {
  try {
    const base64 = buffer.toString('base64')
    const imgMime = mimeType.includes('png') ? 'image/png' : 'image/jpeg'
    const dataUrl = `data:${imgMime};base64,${base64}`

    const res = await openai.chat.completions.create({
      model: 'google/gemini-flash-1.5',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'This is a glass order list. Extract all dimensions (width x height in mm or ft) and quantities. Return as a clean list like:\n1933 x 595 = 10 pcs\netc.\nIf unclear, reply exactly: UNCLEAR' }
        ]
      }]
    })

    return (res.choices?.[0]?.message?.content || 'UNCLEAR').trim()
  } catch (err) {
    console.log('[OCR] Error:', err.message)
    return 'UNCLEAR'
  }
}

// ==========================
// MEDIA HANDLER
// ==========================
async function downloadMediaBuffer(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    responseType: 'arraybuffer'
  })
  return Buffer.from(res.data)
}

async function getMediaUrl(mediaId) {
  const res = await axios.get(
    `https://graph.facebook.com/v23.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  )
  return res.data.url
}

async function handleMedia(from, message) {
  try {
    const mediaType = message.type
    const mediaObj = message[mediaType]
    const mediaId = mediaObj.id
    const mimeType = mediaObj.mime_type || ''
    const caption = mediaObj.caption || ''

    const tempUrl = await getMediaUrl(mediaId)
    let buffer = null
    let permanentUrl = `[media_id:${mediaId}]`

    try {
      buffer = await downloadMediaBuffer(tempUrl)
      const ext = mimeType.includes('pdf') ? 'pdf' : mimeType.includes('png') ? 'png' : 'jpg'
      const localFilename = `psg_${from}_${Date.now()}.${ext}`

      if (process.env.CLOUDINARY_URL) {
        const cloudinary = require('cloudinary').v2
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'psg_inquiries', public_id: localFilename },
            (err, result) => err ? reject(err) : resolve(result)
          )
          uploadStream.end(buffer)
        })
        permanentUrl = uploadResult.secure_url
      } else {
        const uploadsDir = path.join(__dirname, 'uploads')
        fs.mkdirSync(uploadsDir, { recursive: true })
        fs.writeFileSync(path.join(uploadsDir, localFilename), buffer)
        permanentUrl = localFilename
      }
    } catch (dlErr) {
      console.log('[MEDIA] Download failed:', dlErr.message)
    }

    const { addMediaAttachment } = require('./services/googleSheets')
    try { await addMediaAttachment(from, mediaType, mimeType, permanentUrl, caption) } catch (e) {}

    // OCR
    let ocrText = null
    if (buffer && (mediaType === 'image' || mimeType.includes('pdf'))) {
      await sendMessage(from, `📎 File received! Analysing your size list... 🔍`)
      ocrText = await ocrImageFromBuffer(buffer, mimeType)
    }

    if (leadSessions[from]) {
      const session = leadSessions[from]
      session.data.attachment = permanentUrl

      if (ocrText && ocrText !== 'UNCLEAR') {
        session.data.size = ocrText
        session.data.quantity = '[see size list above]'
        await sendMessage(from, `✅ *Sizes extracted:*\n\n${ocrText}\n\nNoted for your quotation!`)
      } else if (ocrText === 'UNCLEAR') {
        await sendMessage(from, `⚠️ Couldn't read sizes clearly. Please type them manually or call:\n📞 +92-21-35042275`)
      } else {
        await sendMessage(from, `📎 File saved for our team.`)
      }

      await advanceLead(from, session)
      return
    }

    // Not in wizard
    if (ocrText && ocrText !== 'UNCLEAR') {
      await sendMessage(from, `✅ *Sizes extracted:*\n\n${ocrText}\n\nWould you like a quotation? Our team will be in touch.\n📞 +92-21-35042275`)
    } else if (ocrText === 'UNCLEAR') {
      await sendMessage(from, `⚠️ Image received but couldn't read clearly. Please send a clearer photo or call:\n📞 +92-21-35042275`)
    } else {
      await sendMessage(from, `📎 File received! Our team will review it.\n📞 +92-21-35042275`)
    }

    try { await saveInquiry(from, `[${mediaType.toUpperCase()}] ${caption}`, `Media: ${permanentUrl}`) } catch (e) {}

  } catch (err) {
    console.log('Media handler error:', err.message)
    await sendMessage(from, `Sorry, couldn't process your file. Please call +92-21-35042275`)
  }
}

// ==========================
// HELPERS
// ==========================
function isRateRequest(text) {
  const t = text.toLowerCase()
  return ['i need rates','show rates','rate list','price list','current rates','tell me rates','what are the rates','rates please','send rates','rates only'].some(p => t.includes(p))
}

function isHotLead(text) {
  if (isRateRequest(text)) return false
  const t = text.toLowerCase()
  if (['information','info','what is','tell me','explain','how does','what are','good afternoon','good morning','good evening','hello','hi','assalam','salam'].some(k => t.includes(k))) return false
  return ['quotation','quote','buy','order','purchase','i need','i want','i require','send me price','give me price','price of','cost of','chahiye','required'].some(k => t.includes(k))
}

function scoreLead(text) {
  const t = text.toLowerCase()
  if (['quotation','quote','price','buy','order','require','urgent','need','purchase','cost','rate','how much'].some(k => t.includes(k))) return '🔴 HOT'
  if (['information','specification','catalog','brochure','specs','details','what is','tell me'].some(k => t.includes(k))) return '🟡 WARM'
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

function getRates() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')) } catch { return {} }
}

function saveRates(rates) {
  rates.lastUpdated = new Date().toISOString().split('T')[0]
  rates.updatedBy = 'admin via WhatsApp'
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2))
}

function ratesToText(rates) {
  const lines = [`*PSG Current Rates (${rates.currency}, ${rates.unit})*\n`]
  lines.push('*Glass Supply:*')
  Object.entries(rates.glass || {}).forEach(([k, v]) => { if (k !== 'note') lines.push(`  ${k.replace(/_/g,' ')}: Rs.${v ?? 'TBD'}`) })
  lines.push('\n*Tempering:*')
  Object.entries(rates.tempering || {}).forEach(([k, v]) => { if (k !== 'note') lines.push(`  ${k}: Rs.${v ?? 'TBD'}`) })
  lines.push('\n*Other Services:*')
  if (rates.lamination?.per_sqft) lines.push(`  Lamination: Rs.${rates.lamination.per_sqft}`)
  if (rates.polishing?.flat_polish) lines.push(`  Polishing: Rs.${rates.polishing.flat_polish}`)
  if (rates.beveling?.per_sqft) lines.push(`  Beveling: Rs.${rates.beveling.per_sqft ?? 'TBD'}`)
  if (rates.double_glaze?.per_sqft) lines.push(`  Double Glaze: Rs.${rates.double_glaze.per_sqft ?? 'TBD'}`)
  lines.push('\n_Reply "update [item] [value]" to change any rate_')
  return lines.join('\n')
}

function parseRateUpdate(text) {
  const t = text.toLowerCase().trim()
  const match = t.match(/(?:update|set)\s+(.+?)\s+(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const desc = match[1].trim()
  const value = parseFloat(match[2])
  const rates = getRates()
  if (desc.includes('temper')) { const m = desc.match(/(\d+)mm/); if (m) { rates.tempering[`${m[1]}mm`] = value; saveRates(rates); return `✅ ${m[1]}mm tempering → Rs.${value}` } }
  if (desc.includes('laminat')) { rates.lamination = rates.lamination || {}; rates.lamination.per_sqft = value; saveRates(rates); return `✅ Lamination → Rs.${value}/sqft` }
  if (desc.includes('polish')) { rates.polishing = rates.polishing || {}; rates.polishing.flat_polish = value; saveRates(rates); return `✅ Polishing → Rs.${value}/sqft` }
  if (desc.includes('bevel')) { rates.beveling = rates.beveling || {}; rates.beveling.per_sqft = value; saveRates(rates); return `✅ Beveling → Rs.${value}/sqft` }
  if (desc.includes('double') || desc.includes('dgu')) { rates.double_glaze = rates.double_glaze || {}; rates.double_glaze.per_sqft = value; saveRates(rates); return `✅ Double Glaze → Rs.${value}/sqft` }
  const m = desc.match(/(\d+)mm/)
  if (m) {
    const mm = m[1]
    if (desc.includes('with hole')) rates.glass[`${mm}mm_with_holes`] = value
    else if (desc.includes('without hole')) rates.glass[`${mm}mm_without_holes`] = value
    else rates.glass[`${mm}mm`] = value
    saveRates(rates); return `✅ ${mm}mm glass → Rs.${value}`
  }
  return null
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

// ==========================
// WEBHOOK
// ==========================
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge'])
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value
    const message = value?.messages?.[0]
    if (!message) return res.sendStatus(200)

    const from = message.from

    // Media
    if (['image', 'document', 'video'].includes(message.type)) {
      await handleMedia(from, message)
      return res.sendStatus(200)
    }

    // Interactive reply (button tap or list selection)
    let text = ''
    if (message.type === 'interactive') {
      const ir = message.interactive
      if (ir.type === 'button_reply') {
        text = resolveInteractiveReply(ir.button_reply.id)
      } else if (ir.type === 'list_reply') {
        text = resolveInteractiveReply(ir.list_reply.id)
      }
    } else {
      text = message.text?.body?.trim() || ''
    }

    if (!text) return res.sendStatus(200)
    console.log(`[${from}]: ${text}`)

    // Global cancel
    if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
      if (leadSessions[from]) delete leadSessions[from]
      if (adminSessions[from]) delete adminSessions[from]
      await sendMessage(from, `✅ Cancelled. How can I help you?`)
      return res.sendStatus(200)
    }

    // Admin
    if (from === ADMIN_NUMBER) {
      const lower = text.toLowerCase()
      if (lower === 'admin' || lower === 'show rates' || lower === 'rates') {
        adminSessions[from] = true
        await sendMessage(from, ratesToText(getRates()))
        return res.sendStatus(200)
      }
      if (lower.startsWith('update ') || lower.startsWith('set ')) {
        const result = parseRateUpdate(text)
        await sendMessage(from, result || `❌ Format not recognised.\nExamples:\nupdate lamination 350\nupdate 6mm 80`)
        return res.sendStatus(200)
      }
      if (lower === 'exit' || lower === 'done' || lower === 'quit') {
        adminSessions[from] = false
        await sendMessage(from, '✅ Exited admin mode.')
        return res.sendStatus(200)
      }
      if (adminSessions[from]) {
        await sendMessage(from, `_Admin mode active._\n\n${ratesToText(getRates())}`)
        return res.sendStatus(200)
      }
    }

    // Rate request
    if (isRateRequest(text)) {
      await sendMessage(from, ratesToText(getRates()))
      return res.sendStatus(200)
    }

    // Handover
    if (['talk to sales','need representative','call me','speak to someone','human','agent','sales team','representative'].some(k => text.toLowerCase().includes(k))) {
      await sendMessage(from, `A PSG representative will contact you shortly. 📞\n\nPlease share:\n*Name:*\n*Company:*\n*City:*\n*Best time to call:*`)
      try { await saveInquiry(from, text, 'HANDOVER REQUEST') } catch (e) {}
      return res.sendStatus(200)
    }

    // Lead wizard
    if (leadSessions[from]) {
      const session = leadSessions[from]

      if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
        delete leadSessions[from]
        await sendMessage(from, `❌ Quotation cancelled. Type "quote" to start again.`)
        return res.sendStatus(200)
      }

      const steps = getSteps(session)
      const currentField = steps[session.step]

      if (currentField) {
        session.data[currentField] = text
        session.step++
        await advanceLead(from, session)
      }

      return res.sendStatus(200)
    }

    // Trigger wizard on hot lead
    if (isHotLead(text) && !leadSessions[from]) {
      const preData = {}
      const gt = detectGlassType(text)
      if (gt) preData.glassType = gt
      const dims = extractDimensions(text)
      if (dims) preData.size = text
      const pieces = extractPieces(text)
      if (pieces > 1) preData.quantity = String(pieces)

      leadSessions[from] = { step: 0, data: preData }
      await advanceLead(from, leadSessions[from])
      return res.sendStatus(200)
    }

    // AI flow
    if (!conversations[from]) conversations[from] = []
    conversations[from].push({ role: 'user', content: text })
    conversations[from] = conversations[from].slice(-10)

    const aiReply = await askAI(from, text)
    conversations[from].push({ role: 'assistant', content: aiReply })
    await sendMessage(from, aiReply)

    console.log(`Lead [${from}]: ${scoreLead(text)} | "${text}"`)
    try { await saveInquiry(from, text, aiReply) } catch (e) {}

    res.sendStatus(200)

  } catch (err) {
    console.log('ERROR:', err.response?.data || err.message)
    res.sendStatus(500)
  }
})

// ==========================
// AI
// ==========================
async function askAI(userId, userMessage) {
  const r = getRates()
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
Glass: ${Object.entries(r.glass||{}).filter(([k])=>k!=='note').map(([k,v])=>`${k.replace(/_/g,' ')} Rs.${v??'TBD'}`).join(' | ')}
Tempering: ${Object.entries(r.tempering||{}).filter(([k])=>k!=='note').map(([k,v])=>`${k} Rs.${v??'TBD'}`).join(' | ')}
Lamination: Rs.${r.lamination?.per_sqft??'TBD'} | Polishing: Rs.${r.polishing?.flat_polish??'TBD'} | DGU: Rs.${r.double_glaze?.per_sqft??'TBD'}
`

  const messages = [
    {
      role: 'system',
      content: `You are a professional sales assistant for Pakistan Safety Glass (PSG) on WhatsApp.
Company: ${kb.website.name} | Phone: ${kb.website.phone.join(', ')} | Address: ${kb.website.address}
Products: ${kb.products.map(p=>p.name).join(', ')}

${ratesText}
${calculationText}

DGU RULE: In "X + Y + Z" DGU specs, Y is the SPACER GAP (not glass). "Low-E + 12 + 6mm" = Low-E glass + 12mm air gap + 6mm glass.
ALUMINUM RULE: Always ask Thermal Break vs Standard, and window type, before quoting.
LAMINATED RULE: 6+6 = two 6mm panes + lamination. Never treat as single pane.

RULES: Short professional replies. *Bold* prices. TBD rates → "please call +92-21-35042275". End quotes with "_Estimated. Final price confirmed at order._"

WHY PSG: ${kb.competitors.whyPSG}`
    },
    ...conversations[userId]
  ]

  const models = [
    'google/gemini-flash-1.5',
    'meta-llama/llama-3.3-70b-instruct:free',
    'openai/gpt-4o-mini'
  ]

  for (const model of models) {
    try {
      const res = await openai.chat.completions.create({ model, messages })
      return res.choices[0].message.content
    } catch (e) {
      console.log(`Failed: ${model}`, e.message)
    }
  }

  return `Our assistant is busy.\n\nPlease call:\n+92-21-35042275\n+92-308-2909634`
}

app.listen(3000, () => {
  console.log('=================================')
  console.log('PSG WhatsApp Bot Running — Port 3000')
  console.log('=================================')
})