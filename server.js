const express = require('express')
const axios = require('axios')
const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')
const kb = require('./knowledge')

require('dotenv').config()

const app = express()
app.use(express.json())

// ================================
// DATABASE + SERVICES
// ================================

const connectDB = require('./database/db')

const {
  saveInquiry
} = require('./services/crmService')

const {
  detectLayers,
  extractDimensions,
  extractPieces
} = require('./services/glassParser')

const {
  calculateSqft
} = require('./services/calculator')

// ================================
// CONNECT DATABASE
// ================================

connectDB()

// ================================
// ENV VARIABLES
// ================================

const VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || 'mytoken123'

const ACCESS_TOKEN =
  process.env.ACCESS_TOKEN || ''

const OPENROUTER_KEY =
  process.env.OPENROUTER_KEY || ''

const PHONE_NUMBER_ID =
  '1164548600079324'

const ADMIN_NUMBER =
  '923000306648'

const RATES_FILE =
  path.join(__dirname, 'Rates.json')

// ================================
// OPENROUTER CLIENT
// ================================

const openai = new OpenAI({
  baseURL:
    'https://openrouter.ai/api/v1',

  apiKey:
    OPENROUTER_KEY,

  defaultHeaders: {
    'HTTP-Referer':
      'https://pakistansafetyglass.com.pk',

    'X-OpenRouter-Title':
      'PSG WhatsApp Bot'
  }
})

// ================================
// MEMORY
// ================================

const conversations = {}

// ================================
// RATES FUNCTIONS
// ================================

function getRates() {

  try {

    return JSON.parse(
      fs.readFileSync(
        RATES_FILE,
        'utf8'
      )
    )

  } catch {

    return {}
  }
}

function saveRates(rates) {

  rates.lastUpdated =
    new Date()
      .toISOString()
      .split('T')[0]

  rates.updatedBy =
    'admin via WhatsApp'

  fs.writeFileSync(
    RATES_FILE,
    JSON.stringify(
      rates,
      null,
      2
    )
  )
}

function ratesToText(rates) {

  const lines = [
    `*PSG Current Rates (${rates.currency}, ${rates.unit})*\n`
  ]

  lines.push('*Glass Supply:*')

  Object.entries(
    rates.glass || {}
  ).forEach(([k, v]) => {

    if (
      k !== 'note' &&
      v !== null
    ) {

      lines.push(
        `  ${k.replace(/_/g, ' ')}: Rs.${v}`
      )
    }
  })

  lines.push('\n*Tempering:*')

  Object.entries(
    rates.tempering || {}
  ).forEach(([k, v]) => {

    if (
      k !== 'note' &&
      v !== null
    ) {

      lines.push(
        `  ${k}: Rs.${v}`
      )
    }
  })

  return lines.join('\n')
}

// ================================
// RATE UPDATE PARSER
// ================================

function parseRateUpdate(text) {

  const t =
    text.toLowerCase().trim()

  const match =
    t.match(
      /(?:update|set)\s+(.+)\s+(\d+(?:\.\d+)?)/
    )

  if (!match) return null

  const desc =
    match[1].trim()

  const value =
    parseFloat(match[2])

  const rates =
    getRates()

  if (
    desc.includes('temper')
  ) {

    const mmMatch =
      desc.match(/(\d+)mm/)

    if (mmMatch) {

      rates.tempering[
        `${mmMatch[1]}mm`
      ] = value

      saveRates(rates)

      return `✅ ${mmMatch[1]}mm tempering → Rs.${value}`
    }
  }

  const mmMatch =
    desc.match(/(\d+)mm/)

  if (
    mmMatch &&
    !desc.includes('temper')
  ) {

    const mm = mmMatch[1]

    if (
      desc.includes('with hole')
    ) {

      rates.glass[
        `${mm}mm_with_holes`
      ] = value

    } else if (
      desc.includes('without hole')
    ) {

      rates.glass[
        `${mm}mm_without_holes`
      ] = value

    } else {

      rates.glass[
        `${mm}mm`
      ] = value
    }

    saveRates(rates)

    return `✅ ${mm}mm glass → Rs.${value}`
  }

  return null
}

// ================================
// WHATSAPP SEND MESSAGE
// ================================

async function sendMessage(
  to,
  text
) {

  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product:
        'whatsapp',

      to,

      text: {
        body: text
      }
    },
    {
      headers: {
        Authorization:
          `Bearer ${ACCESS_TOKEN}`,

        'Content-Type':
          'application/json'
      }
    }
  )
}

// ================================
// CALCULATION ENGINE
// ================================

function generateCalculation(text) {

  const dimensions =
    extractDimensions(text)

  if (!dimensions) {
    return null
  }

  const pieces =
    extractPieces(text)

  const layers =
    detectLayers(text)

  const sqft =
    calculateSqft(
      dimensions.widthMM,
      dimensions.heightMM,
      pieces,
      layers
    )

  return {
    widthMM:
      dimensions.widthMM,

    heightMM:
      dimensions.heightMM,

    pieces,

    layers,

    sqft
  }
}

// ================================
// WEBHOOK VERIFY
// ================================

app.get('/webhook', (req, res) => {

  if (
    req.query['hub.mode'] &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {

    return res
      .status(200)
      .send(
        req.query['hub.challenge']
      )
  }

  res.sendStatus(403)
})

// ================================
// WEBHOOK RECEIVE
// ================================

app.post('/webhook', async (req, res) => {

  try {

    const message =
      req.body
        .entry?.[0]
        ?.changes?.[0]
        ?.value?.messages?.[0]

    if (!message) {
      return res.sendStatus(200)
    }

    const from =
      message.from

    const text =
      message.text?.body?.trim()

    if (!text) {
      return res.sendStatus(200)
    }

    console.log(
      `[${from}]: ${text}`
    )

    // ==========================
    // ADMIN COMMANDS
    // ==========================

    if (from === ADMIN_NUMBER) {

      const lower =
        text.toLowerCase()

      if (
        lower === 'show rates' ||
        lower === 'rates'
      ) {

        await sendMessage(
          from,
          ratesToText(getRates())
        )

        return res.sendStatus(200)
      }

      if (
        lower.startsWith('update ') ||
        lower.startsWith('set ')
      ) {

        const result =
          parseRateUpdate(text)

        await sendMessage(
          from,
          result ||
          `❌ Format not recognised`
        )

        return res.sendStatus(200)
      }
    }

    // ==========================
    // CONVERSATION MEMORY
    // ==========================

    if (!conversations[from]) {
      conversations[from] = []
    }

    conversations[from].push({
      role: 'user',
      content: text
    })

    conversations[from] =
      conversations[from]
        .slice(-10)

    // ==========================
    // AI REPLY
    // ==========================

    const aiReply =
      await askAI(
        from,
        text
      )

    conversations[from].push({
      role: 'assistant',
      content: aiReply
    })

    // ==========================
    // SEND MESSAGE
    // ==========================

    await sendMessage(
      from,
      aiReply
    )

    // ==========================
    // SAVE CRM
    // ==========================

    try {

      await saveInquiry(
        from,
        text,
        aiReply
      )

    } catch (crmErr) {

      console.log(
        'CRM Error:',
        crmErr.message
      )
    }

    console.log('Reply sent!')

    res.sendStatus(200)

  } catch (err) {

    console.log(
      'ERROR:',
      err.response?.data ||
      err.message
    )

    res.sendStatus(500)
  }
})

// ================================
// AI ENGINE
// ================================

async function askAI(
  userId,
  userMessage
) {

  const r = getRates()

  const calculation =
    generateCalculation(
      userMessage
    )

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
${Object.entries(r.glass || {})
  .filter(([k]) => k !== 'note')
  .map(([k, v]) =>
    `${k.replace(/_/g, ' ')} Rs.${v ?? 'TBD'}`
  )
  .join(' | ')}

Tempering:
${Object.entries(r.tempering || {})
  .filter(([k]) => k !== 'note')
  .map(([k, v]) =>
    `${k} Rs.${v ?? 'TBD'}`
  )
  .join(' | ')}
`

  const knowledgeText = `
COMPANY:
${kb.website.name}

ADDRESS:
${kb.website.address}

PHONE:
${kb.website.phone.join(', ')}

EMAIL:
${kb.website.email}

PRODUCTS:
${kb.products
  .map(p => p.name)
  .join(', ')}
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
- If rate missing, say:
"Rate not set yet, please call +92-21-35042275"
- End quotations with:
"_Estimated quote. Final price confirmed at order._"
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

      console.log(
        'Trying:',
        model
      )

      const res =
        await openai
          .chat
          .completions
          .create({
            model,
            messages
          })

      return res
        .choices[0]
        .message
        .content

    } catch (e) {

      console.log(
        `Failed: ${model}`,
        e.message
      )
    }
  }

  return `
Our assistant is busy.

Please call:
+92-21-35042275
+92-308-2909634
`
}

// ================================
// SERVER
// ================================

app.listen(3000, () => {

  console.log(
    '================================='
  )

  console.log(
    'PSG WhatsApp Bot Running'
  )

  console.log(
    'Port: 3000'
  )

  console.log(
    '================================='
  )
})