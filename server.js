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
const PHONE_NUMBER_ID = '1164548600079324'
const ADMIN_NUMBER = '923000306648'
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

const LEAD_STEPS = [
  { field: 'name',      question: 'May I have your *name*?' },
  { field: 'company',   question: 'Your *company* or organization name? (type "none" if individual)' },
  { field: 'city',      question: 'Your *city / project location*?' },
  { field: 'glassType', question: 'What *type of glass* do you need?\n\n1. Tempered Glass\n2. Laminated Glass\n3. Bullet Resistant Glass\n4. Double Glazed Glass (DGU)\n5. Other (please specify)' },
  { field: 'size',      question: 'What *size* do you require? (e.g. 4x8ft, 1200x2400mm)' },
  { field: 'quantity',  question: 'How many *pieces* do you need?' }
]

// ==========================
// CANCEL KEYWORDS
// ==========================
const CANCEL_KEYWORDS = ['cancel', 'exit', 'stop', 'quit', 'nevermind', 'forget it', 'abort']

// ==========================
// MEDIA HANDLER (unchanged)
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
    console.log(`[MEDIA] ${from} sent ${mediaType}: ${tempUrl}`)

    let permanentUrl = tempUrl
    try {
      const buffer = await downloadMediaBuffer(tempUrl)
      const ext = mimeType.includes('pdf') ? 'pdf' : mimeType.includes('png') ? 'png' : 'jpg'
      const filename = `psg_${from}_${Date.now()}.${ext}`

      if (process.env.CLOUDINARY_URL) {
        const FormData = require('form-data')
        const cloudinary = require('cloudinary').v2
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'psg_inquiries', public_id: filename },
            (err, result) => err ? reject(err) : resolve(result)
          )
          uploadStream.end(buffer)
        })
        permanentUrl = uploadResult.secure_url
        console.log(`[MEDIA] Uploaded to Cloudinary: ${permanentUrl}`)
      } else {
        const localPath = path.join(__dirname, 'uploads', filename)
        require('fs').mkdirSync(path.join(__dirname, 'uploads'), { recursive: true })
        require('fs').writeFileSync(localPath, buffer)
        permanentUrl = `[local:${filename}]`
        console.log(`[MEDIA] Saved locally: ${localPath}`)
      }
    } catch (dlErr) {
      console.log('[MEDIA] Download/upload failed:', dlErr.message)
      permanentUrl = `[media_id:${mediaId}]`
    }

    const { addMediaAttachment } = require('./services/googleSheets')
    try {
      await addMediaAttachment(from, mediaType, mimeType, permanentUrl, caption)
    } catch (e) {
      console.log('Sheets media error:', e.message)
    }

    if (leadSessions[from]) {
      leadSessions[from].data.attachment = permanentUrl
      const session = leadSessions[from]
      if (!session.data.size) session.data.size = '[see attached image]'
      if (!session.data.quantity) session.data.quantity = '[see attached image]'

      await sendMessage(from, `📎 Image received! I've noted the sizes from your attachment.\n\nLet's continue...`)

      while (session.step < LEAD_STEPS.length && session.data[LEAD_STEPS[session.step].field]) {
        session.step++
      }
      if (session.step < LEAD_STEPS.length) {
        await sendMessage(from, LEAD_STEPS[session.step].question)
      } else {
        const lead = { phone: from, ...session.data }
        delete leadSessions[from]
        try { await saveCustomerLead(lead) } catch (e) { console.log('Lead save error:', e.message) }
        const summary = `✅ *Thank you ${lead.name}!*\n\nYour inquiry has been recorded:\n\n*Glass Type:* ${lead.glassType}\n*Size:* ${lead.size}\n*Quantity:* ${lead.quantity}\n*Location:* ${lead.city}${lead.attachment ? `\n*Attachment:* ${lead.attachment}` : ''}\n\nA PSG representative will contact you shortly.\n\n_For urgent queries: +92-21-35042275_`
        await sendMessage(from, summary)
      }
      return
    }

    await sendMessage(from, `📎 Thank you! Your file has been received and saved.\n\nOur team will review it. For faster response:\n📞 +92-21-35042275`)
    try { await saveInquiry(from, `[${mediaType.toUpperCase()} ATTACHMENT] ${caption}`, `Media saved: ${permanentUrl}`) } catch (e) {}

  } catch (err) {
    console.log('Media handler error:', err.message)
    await sendMessage(from, `Sorry, I couldn't process your file. Please try again or call +92-21-35042275`)
  }
}

function isRateRequest(text) {
  const t = text.toLowerCase()
  const rateOnlyPhrases = [
    'i need rates', 'show rates', 'rate list', 'price list',
    'current rates', 'tell me rates', 'what are the rates',
    'rates please', 'send rates', 'rates only'
  ]
  return rateOnlyPhrases.some(phrase => t.includes(phrase))
}

function isHotLead(text) {
  if (isRateRequest(text)) return false
  const t = text.toLowerCase()
  const infoOnly = ['information', 'info', 'what is', 'tell me', 'explain', 'how does', 'what are', 'good afternoon', 'good morning', 'good evening', 'hello', 'hi', 'assalam', 'salam']
  if (infoOnly.some(k => t.includes(k))) return false
  const buyKeywords = ['quotation', 'quote', 'buy', 'order', 'purchase', 'i need', 'i want', 'i require', 'send me price', 'give me price', 'price of', 'cost of', 'chahiye', 'required']
  return buyKeywords.some(k => t.includes(k))
}

function scoreLead(text) {
  const t = text.toLowerCase()
  const hotKeywords = ['quotation', 'quote', 'price', 'buy', 'order', 'require', 'urgent', 'need', 'purchase', 'cost', 'rate', 'how much']
  const warmKeywords = ['information', 'specification', 'catalog', 'brochure', 'specs', 'details', 'what is', 'tell me']
  if (hotKeywords.some(k => t.includes(k))) return '🔴 HOT'
  if (warmKeywords.some(k => t.includes(k))) return '🟡 WARM'
  return '🔵 COLD'
}

function detectGlassType(text) {
  const t = text.toLowerCase()
  if (t.includes('bullet') || t.includes('br4') || t.includes('br6') || t.includes('br7')) return '3'
  if (t.includes('laminated') || t.includes('laminate') || t.includes('pvb')) return '2'
  if (t.includes('dgu') || t.includes('double glaz') || t.includes('insulated') || t.includes('double glazed')) return '4'
  if (t.includes('tempered') || t.includes('toughened') || t.includes('tglass') || t.includes('t glass')) return '1'
  if (/\d+mm/i.test(t)) return '1'
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
  Object.entries(rates.glass || {}).forEach(([k, v]) => {
    if (k !== 'note') lines.push(`  ${k.replace(/_/g, ' ')}: Rs.${v ?? 'TBD'}`)
  })
  lines.push('\n*Tempering:*')
  Object.entries(rates.tempering || {}).forEach(([k, v]) => {
    if (k !== 'note') lines.push(`  ${k}: Rs.${v ?? 'TBD'}`)
  })
  lines.push('\n*Other Services:*')
  if (rates.lamination?.per_sqft) lines.push(`  Lamination: Rs.${rates.lamination.per_sqft}`)
  if (rates.polishing?.flat_polish) lines.push(`  Polishing: Rs.${rates.polishing.flat_polish}`)
  if (rates.beveling?.per_sqft) lines.push(`  Beveling: Rs.${rates.beveling.per_sqft ?? 'TBD'}`)
  if (rates.double_glaze?.per_sqft) lines.push(`  Double Glaze: Rs.${rates.double_glaze.per_sqft ?? 'TBD'}`)
  lines.push('\n_Reply "update [item] [value]" to change any rate_')
  lines.push('_Example: update lamination 350_')
  lines.push('_Example: update 6mm 80_')
  lines.push('_Example: update 6mm tempering 400_')
  return lines.join('\n')
}

function parseRateUpdate(text) {
  const t = text.toLowerCase().trim()
  const match = t.match(/(?:update|set)\s+(.+?)\s+(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const desc = match[1].trim()
  const value = parseFloat(match[2])
  const rates = getRates()

  if (desc.includes('temper')) {
    const mmMatch = desc.match(/(\d+)mm/)
    if (mmMatch) { rates.tempering[`${mmMatch[1]}mm`] = value; saveRates(rates); return `✅ ${mmMatch[1]}mm tempering → Rs.${value}` }
  }
  if (desc.includes('laminat')) { rates.lamination = rates.lamination || {}; rates.lamination.per_sqft = value; saveRates(rates); return `✅ Lamination → Rs.${value} per sqft` }
  if (desc.includes('polish')) { rates.polishing = rates.polishing || {}; rates.polishing.flat_polish = value; saveRates(rates); return `✅ Polishing → Rs.${value} per sqft` }
  if (desc.includes('bevel')) { rates.beveling = rates.beveling || {}; rates.beveling.per_sqft = value; saveRates(rates); return `✅ Beveling → Rs.${value} per sqft` }
  if (desc.includes('double') || desc.includes('dgu')) { rates.double_glaze = rates.double_glaze || {}; rates.double_glaze.per_sqft = value; saveRates(rates); return `✅ Double Glaze → Rs.${value} per sqft` }

  const mmMatch = desc.match(/(\d+)mm/)
  if (mmMatch) {
    const mm = mmMatch[1]
    if (desc.includes('with hole')) rates.glass[`${mm}mm_with_holes`] = value
    else if (desc.includes('without hole')) rates.glass[`${mm}mm_without_holes`] = value
    else rates.glass[`${mm}mm`] = value
    saveRates(rates)
    return `✅ ${mm}mm glass → Rs.${value}`
  }
  return null
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  )
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

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge'])
  }
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (!message) return res.sendStatus(200)

    const from = message.from

    // ==========================
    // MEDIA HANDLER
    // ==========================
    if (['image', 'document', 'video'].includes(message.type)) {
      await handleMedia(from, message)
      return res.sendStatus(200)
    }

    const text = message.text?.body?.trim()
    if (!text) return res.sendStatus(200)

    console.log(`[${from}]: ${text}`)

    // ==========================
    // GLOBAL CANCEL (exits any session)
    // ==========================
    if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
      if (leadSessions[from]) delete leadSessions[from]
      if (adminSessions[from]) delete adminSessions[from]
      await sendMessage(from, `✅ Cancelled current operation. How can I help you?`)
      return res.sendStatus(200)
    }

    // ==========================
    // ADMIN HANDLING
    // ==========================
    if (from === ADMIN_NUMBER) {
      const lower = text.toLowerCase()
      if (lower === 'admin' || lower === 'show rates' || lower === 'rates') {
        adminSessions[from] = true
        await sendMessage(from, ratesToText(getRates()))
        return res.sendStatus(200)
      }
      if (lower.startsWith('update ') || lower.startsWith('set ')) {
        const result = parseRateUpdate(text)
        await sendMessage(from, result || `❌ Format not recognised.\n\nExamples:\nupdate lamination 350\nupdate 6mm 80\nupdate 6mm tempering 400`)
        return res.sendStatus(200)
      }
      if (lower === 'exit' || lower === 'done' || lower === 'quit') {
        adminSessions[from] = false
        await sendMessage(from, '✅ Exited admin mode.')
        return res.sendStatus(200)
      }
      if (adminSessions[from]) {
        await sendMessage(from, `_Admin mode active._\n\nSend rates update or type "exit" to leave.\n\n${ratesToText(getRates())}`)
        return res.sendStatus(200)
      }
    }

    // ==========================
    // RATE REQUEST HANDLER
    // ==========================
    if (isRateRequest(text)) {
      await sendMessage(from, ratesToText(getRates()))
      return res.sendStatus(200)
    }

    // ==========================
    // HUMAN HANDOVER
    // ==========================
    const handoverKeywords = ['talk to sales', 'need representative', 'call me', 'speak to someone', 'human', 'agent', 'sales team', 'representative']
    if (handoverKeywords.some(k => text.toLowerCase().includes(k))) {
      const reply = `A PSG representative will contact you shortly. 📞\n\nPlease share your details:\n\n*Name:*\n*Company:*\n*City:*\n*Best time to call:*`
      await sendMessage(from, reply)
      try { await saveInquiry(from, text, 'HANDOVER REQUEST: ' + text) } catch (e) {}
      return res.sendStatus(200)
    }

    // ==========================
    // LEAD COLLECTION WIZARD (with cancel support)
    // ==========================
    if (leadSessions[from]) {
      const session = leadSessions[from]

      // Cancel inside wizard
      if (CANCEL_KEYWORDS.includes(text.toLowerCase().trim())) {
        delete leadSessions[from]
        await sendMessage(from, `❌ Quotation cancelled. You can start again by typing "quote" or "rates". How else can I help?`)
        return res.sendStatus(200)
      }

      while (session.step < LEAD_STEPS.length && session.data[LEAD_STEPS[session.step].field]) {
        session.step++
      }

      if (session.step < LEAD_STEPS.length) {
        session.data[LEAD_STEPS[session.step].field] = text
        session.step++

        while (session.step < LEAD_STEPS.length && session.data[LEAD_STEPS[session.step].field]) {
          session.step++
        }

        if (session.step < LEAD_STEPS.length) {
          await sendMessage(from, LEAD_STEPS[session.step].question)
          return res.sendStatus(200)
        }
      }

      const lead = { phone: from, ...session.data }
      delete leadSessions[from]
      try { await saveCustomerLead(lead) } catch (e) { console.log('Lead save error:', e.message) }

      const summary = `✅ *Thank you ${lead.name}!*\n\nYour inquiry has been recorded:\n\n*Glass Type:* ${lead.glassType}\n*Size:* ${lead.size}\n*Quantity:* ${lead.quantity}\n*Location:* ${lead.city}${lead.attachment ? `\n*Attachment:* ${lead.attachment}` : ''}\n\nA PSG representative will contact you shortly.\n\n_For urgent queries: +92-21-35042275_`
      await sendMessage(from, summary)
      return res.sendStatus(200)
    }

    // Trigger lead wizard on hot lead (genuine purchase interest)
    if (isHotLead(text) && !leadSessions[from]) {
      const preData = {}
      const glassType = detectGlassType(text)
      if (glassType) preData.glassType = glassType
      const dims = extractDimensions(text)
      if (dims) preData.size = text
      const pieces = extractPieces(text)
      if (pieces > 1) preData.quantity = String(pieces)

      leadSessions[from] = { step: 0, data: preData }
      await sendMessage(from, `Great! I'd love to help you with a quotation. 😊\n\nMay I have your *name*? (Type "cancel" to stop)`)
      return res.sendStatus(200)
    }

    // ==========================
    // CUSTOMER FLOW (AI)
    // ==========================
    if (!conversations[from]) conversations[from] = []
    conversations[from].push({ role: 'user', content: text })
    conversations[from] = conversations[from].slice(-10)

    const aiReply = await askAI(from, text)
    conversations[from].push({ role: 'assistant', content: aiReply })

    await sendMessage(from, aiReply)

    const score = scoreLead(text)
    console.log(`Lead [${from}]: ${score} | "${text}"`)

    try { await saveInquiry(from, text, aiReply) } catch (crmErr) { console.log('CRM Error:', crmErr.message) }

    console.log('Reply sent!')
    res.sendStatus(200)

  } catch (err) {
    console.log('ERROR:', err.response?.data || err.message)
    res.sendStatus(500)
  }
})

async function askAI(userId, userMessage) {
  // ... (unchanged - your existing askAI function)
  const r = getRates()
  const calculation = generateCalculation(userMessage)

  let calculationText = ''
  if (calculation) {
    calculationText = `
PRE-CALCULATED VALUES:
Width: ${calculation.widthMM} mm
Height: ${calculation.heightMM} mm
Pieces: ${calculation.pieces}
Layers: ${calculation.layers}
Thicknesses: ${calculation.thicknesses.join(' + ')}
Total Sqft: ${calculation.sqft}

IMPORTANT:
- Sqft already includes layers and quantity
- NEVER recalculate sqft yourself
- ALWAYS use provided sqft

LAMINATED GLASS RULES:
- 5+5 means TWO separate 5mm glasses
- 6+6 means TWO separate 6mm glasses
- 8+8 means TWO separate 8mm glasses
- 10+10 means TWO separate 10mm glasses
- 12+12 means TWO separate 12mm glasses

PRICING RULE:
- Add each glass layer separately
- Then add lamination charges
- Example: 12+12 = (12mm glass × 2) + lamination
- NEVER treat 12+12 as a single 12mm glass.
`
  }

  const ratesText = `
CURRENT RATES (PKR, per sqft):

Glass Supply:
${Object.entries(r.glass || {}).filter(([k]) => k !== 'note').map(([k, v]) => `${k.replace(/_/g, ' ')} Rs.${v ?? 'TBD'}`).join(' | ')}

Tempering:
${Object.entries(r.tempering || {}).filter(([k]) => k !== 'note').map(([k, v]) => `${k} Rs.${v ?? 'TBD'}`).join(' | ')}

Lamination: Rs.${r.lamination?.per_sqft ?? 'TBD'} per sqft
Polishing: Rs.${r.polishing?.flat_polish ?? 'TBD'} per sqft
Beveling: Rs.${r.beveling?.per_sqft ?? 'TBD'} per sqft
Double Glaze: Rs.${r.double_glaze?.per_sqft ?? 'TBD'} per sqft
`

  const knowledgeText = `
COMPANY: ${kb.website.name}
ADDRESS: ${kb.website.address}
PHONE: ${kb.website.phone.join(', ')}
EMAIL: ${kb.website.email}
PRODUCTS: ${kb.products.map(p => p.name).join(', ')}
`

  const messages = [
    {
      role: 'system',
      content: `
You are a professional sales assistant for Pakistan Safety Glass (PSG) on WhatsApp.

${knowledgeText}

${ratesText}

${calculationText}

TECHNICAL KNOWLEDGE:
Bullet Resistant Glass:
- BR4: ${kb.technicalSpecs.bulletResistant.BR4}
- BR6: ${kb.technicalSpecs.bulletResistant.BR6}
- BR7: ${kb.technicalSpecs.bulletResistant.BR7}
- Curved BR: ${kb.technicalSpecs.bulletResistant.curved}

Glass Thickness Guide:
${Object.entries(kb.technicalSpecs.thicknessGuide).map(([k, v]) => `${k}: ${v}`).join('\n')}

Fire Rated Glass:
${Object.entries(kb.technicalSpecs.fireRated).map(([k, v]) => `${k}: ${v}`).join('\n')}

Automotive Glass:
- OEM Partners: ${kb.technicalSpecs.automotive.oemPartners.join('; ')}
- Local bus body fabricators: ${kb.technicalSpecs.automotive.localBodyBuilders}
- Windshield: ${kb.technicalSpecs.automotive.glassTypes.windshield}
- Side windows: ${kb.technicalSpecs.automotive.glassTypes.sideWindows}
- Rear window: ${kb.technicalSpecs.automotive.glassTypes.rearWindow}
- Armored vehicle: ${kb.technicalSpecs.automotive.glassTypes.armoredVehicle}
- Customization: ${kb.technicalSpecs.automotive.customization}

WHY PSG:
${kb.competitors.whyPSG}

RULES:
- Keep replies short and professional
- Use *bold* for prices and totals
- If rate is TBD, say: "Rate not set yet, please call +92-21-35042275"
- End quotations with: "_Estimated quote. Final price confirmed at order._"
- For technical questions, give confident expert answers
- For "why PSG" or "why choose you" questions, use WHY PSG section
- Never attack competitors by name
`
    },
    ...conversations[userId]
  ]

  const models = [
    'google/gemma-3-27b-it:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'openai/gpt-4o-mini'
  ]

  for (const model of models) {
    try {
      console.log('Trying:', model)
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
  console.log('PSG WhatsApp Bot Running')
  console.log('Port: 3000')
  console.log('=================================')
})