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
const { saveInquiry } = require('./services/crmService')
const { detectLayers, extractDimensions, extractPieces } = require('./services/glassParser')
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

// Track admin session state
const adminSessions = {}

function getRates() {
  try {
    return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'))
  } catch {
    return {}
  }
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

  // Tempering
  if (desc.includes('temper')) {
    const mmMatch = desc.match(/(\d+)mm/)
    if (mmMatch) {
      rates.tempering[`${mmMatch[1]}mm`] = value
      saveRates(rates)
      return `✅ ${mmMatch[1]}mm tempering → Rs.${value}`
    }
  }

  // Lamination
  if (desc.includes('laminat')) {
    rates.lamination = rates.lamination || {}
    rates.lamination.per_sqft = value
    saveRates(rates)
    return `✅ Lamination → Rs.${value} per sqft`
  }

  // Polishing
  if (desc.includes('polish')) {
    rates.polishing = rates.polishing || {}
    rates.polishing.flat_polish = value
    saveRates(rates)
    return `✅ Polishing → Rs.${value} per sqft`
  }

  // Beveling
  if (desc.includes('bevel')) {
    rates.beveling = rates.beveling || {}
    rates.beveling.per_sqft = value
    saveRates(rates)
    return `✅ Beveling → Rs.${value} per sqft`
  }

  // Double glaze
  if (desc.includes('double') || desc.includes('dgu')) {
    rates.double_glaze = rates.double_glaze || {}
    rates.double_glaze.per_sqft = value
    saveRates(rates)
    return `✅ Double Glaze → Rs.${value} per sqft`
  }

  // Glass by mm
  const mmMatch = desc.match(/(\d+)mm/)
  if (mmMatch) {
    const mm = mmMatch[1]
    if (desc.includes('with hole')) {
      rates.glass[`${mm}mm_with_holes`] = value
    } else if (desc.includes('without hole')) {
      rates.glass[`${mm}mm_without_holes`] = value
    } else {
      rates.glass[`${mm}mm`] = value
    }
    saveRates(rates)
    return `✅ ${mm}mm glass → Rs.${value}`
  }

  return null
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  )
}

function generateCalculation(text) {
  const dimensions = extractDimensions(text)
  if (!dimensions) return null

  const pieces = extractPieces(text)
  const layers = detectLayers(text)
  const sqft = calculateSqft(dimensions.widthMM, dimensions.heightMM, pieces, layers)

  return { widthMM: dimensions.widthMM, heightMM: dimensions.heightMM, pieces, layers, sqft }
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
    const text = message.text?.body?.trim()
    if (!text) return res.sendStatus(200)

    console.log(`[${from}]: ${text}`)

    // ==========================
    // ADMIN HANDLING
    // ==========================

    if (from === ADMIN_NUMBER) {
      const lower = text.toLowerCase()

      // Enter admin mode
      if (lower === 'admin' || lower === 'show rates' || lower === 'rates') {
        adminSessions[from] = true
        await sendMessage(from, ratesToText(getRates()))
        return res.sendStatus(200)
      }

      // Update command (works in or out of admin mode)
      if (lower.startsWith('update ') || lower.startsWith('set ')) {
        const result = parseRateUpdate(text)
        await sendMessage(from, result || `❌ Format not recognised.\n\nExamples:\nupdate lamination 350\nupdate 6mm 80\nupdate 6mm tempering 400`)
        return res.sendStatus(200)
      }

      // Exit admin mode
      if (lower === 'exit' || lower === 'done' || lower === 'quit') {
        adminSessions[from] = false
        await sendMessage(from, '✅ Exited admin mode.')
        return res.sendStatus(200)
      }

      // If in admin session, don't process as customer
      if (adminSessions[from]) {
        await sendMessage(from, `_Admin mode active._\n\nSend rates update or type "exit" to leave.\n\n${ratesToText(getRates())}`)
        return res.sendStatus(200)
      }
    }

    // ==========================
    // CUSTOMER FLOW
    // ==========================

    if (!conversations[from]) conversations[from] = []

    conversations[from].push({ role: 'user', content: text })
    conversations[from] = conversations[from].slice(-10)

    const aiReply = await askAI(from, text)

    conversations[from].push({ role: 'assistant', content: aiReply })

    await sendMessage(from, aiReply)

    try {
      await saveInquiry(from, text, aiReply)
    } catch (crmErr) {
      console.log('CRM Error:', crmErr.message)
    }

    console.log('Reply sent!')
    res.sendStatus(200)

  } catch (err) {
    console.log('ERROR:', err.response?.data || err.message)
    res.sendStatus(500)
  }
})

async function askAI(userId, userMessage) {
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
Total Sqft: ${calculation.sqft}

IMPORTANT:
- Sqft already includes layers and quantity
- NEVER recalculate sqft yourself
- ALWAYS use provided sqft
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

RULES:
- Keep replies short and professional
- Use *bold* for prices and totals
- If rate is TBD, say: "Rate not set yet, please call +92-21-35042275"
- End quotations with: "_Estimated quote. Final price confirmed at order._"
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