const express = require('express')
const axios = require('axios')
const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')
const kb = require('./knowledge')

require('dotenv').config()

const app = express()
app.use(express.json())

// =========================
// ENVIRONMENT VARIABLES
// =========================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mytoken123'
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || ''
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || ''

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1164548600079324'
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '923000306648'

const PORT = process.env.PORT || 3000

const RATES_FILE = path.join(__dirname, 'rates.json')

// =========================
// OPENROUTER CLIENT
// =========================

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://pakistansafetyglass.com.pk',
    'X-OpenRouter-Title': 'PSG WhatsApp Bot'
  }
})

// =========================
// MEMORY CONVERSATIONS
// =========================

const conversations = {}

// =========================
// RATES FUNCTIONS
// =========================

function getRates() {
  try {
    return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'))
  } catch (err) {
    console.error('Rates JSON Error:', err)
    return {}
  }
}

function saveRates(rates) {
  try {
    rates.lastUpdated = new Date().toISOString().split('T')[0]
    rates.updatedBy = 'admin via WhatsApp'

    fs.writeFileSync(
      RATES_FILE,
      JSON.stringify(rates, null, 2),
      'utf8'
    )

    return true
  } catch (err) {
    console.error('Save Rates Error:', err)
    return false
  }
}

function ratesToText(rates) {
  const lines = [
    `*PSG Current Rates (${rates.currency}, ${rates.unit})*\n`
  ]

  // GLASS
  lines.push('*Glass Supply:*')

  Object.entries(rates.glass || {}).forEach(([k, v]) => {
    if (k !== 'note' && v !== null) {
      lines.push(
        `• ${k.replace(/_/g, ' ')}: Rs.${v}`
      )
    }
  })

  // TEMPERING
  lines.push('\n*Tempering:*')

  Object.entries(rates.tempering || {}).forEach(([k, v]) => {
    if (k !== 'note' && v !== null) {
      lines.push(`• ${k}: Rs.${v}`)
    }
  })

  // OTHER SERVICES
  const others = [
    'polishing',
    'beveling',
    'double_glaze',
    'lamination',
    'bent_glass',
    'tempered_bent',
    'printing',
    'frosting',
    'aluminum_window',
    'curtain_wall'
  ]

  others.forEach((key) => {
    if (rates[key]) {
      const val =
        rates[key].per_sqft ||
        rates[key].flat_polish

      if (val !== null && val !== undefined) {
        lines.push(
          `\n*${key.replace(/_/g, ' ').toUpperCase()}:* Rs.${val}`
        )
      }
    }
  })

  lines.push(`\n_Last updated: ${rates.lastUpdated}_`)

  return lines.join('\n')
}

// =========================
// ADMIN RATE UPDATE PARSER
// =========================

function parseRateUpdate(text) {
  const t = text.toLowerCase().trim()

  const match = t.match(
    /(?:update|set)\s+(.+?)\s+(\d+(?:\.\d+)?)$/
  )

  if (!match) return null

  const desc = match[1].trim()
  const value = parseFloat(match[2])

  const rates = getRates()

  // TEMPERING
  if (desc.includes('temper')) {
    const mmMatch = desc.match(/(\d+)mm/)

    if (mmMatch) {
      rates.tempering[`${mmMatch[1]}mm`] = value

      saveRates(rates)

      return `✅ ${mmMatch[1]}mm tempering updated to Rs.${value}`
    }
  }

  // GLASS
  const mmMatch = desc.match(/(\d+)mm/)

  if (mmMatch && !desc.includes('temper')) {
    const mm = mmMatch[1]

    if (desc.includes('with hole')) {
      rates.glass[`${mm}mm_with_holes`] = value
    } else if (desc.includes('without hole')) {
      rates.glass[`${mm}mm_without_holes`] = value
    } else {
      rates.glass[`${mm}mm`] = value
    }

    saveRates(rates)

    return `✅ ${mm}mm glass updated to Rs.${value}`
  }

  // OTHER SERVICES
  const map = {
    polish: ['polishing', 'flat_polish'],
    bevel: ['beveling', 'per_sqft'],
    double: ['double_glaze', 'per_sqft'],
    lamin: ['lamination', 'per_sqft'],
    'temper bent': ['tempered_bent', 'per_sqft'],
    'bent temper': ['tempered_bent', 'per_sqft'],
    bent: ['bent_glass', 'per_sqft'],
    print: ['printing', 'per_sqft'],
    frost: ['frosting', 'per_sqft'],
    aluminum: ['aluminum_window', 'per_sqft'],
    curtain: ['curtain_wall', 'per_sqft']
  }

  for (const [kw, [cat, field]] of Object.entries(map)) {
    if (desc.includes(kw)) {
      if (!rates[cat]) rates[cat] = {}

      rates[cat][field] = value

      saveRates(rates)

      return `✅ ${cat.replace(/_/g, ' ')} updated to Rs.${value}/sqft`
    }
  }

  return null
}

// =========================
// SEND WHATSAPP MESSAGE
// =========================

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: {
          body: text
        }
      },
      {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    )
  } catch (err) {
    console.error(
      'WhatsApp Send Error:',
      err.response?.data || err.message
    )
  }
}

// =========================
// QUOTE PARSER
// =========================

function extractQuote(text) {
  const lower = text.toLowerCase()

  // SIZE
  const sizeMatch = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|feet|')?\s*x\s*(\d+(?:\.\d+)?)/
  )

  // QUANTITY
  const qtyMatch = lower.match(
    /qty\s*(\d+)|(\d+)\s*(?:pcs|pieces|piece)/
  )

  // THICKNESS
  const mmMatch = lower.match(/(\d+)mm/)

  if (!sizeMatch || !mmMatch) return null

  const width = parseFloat(sizeMatch[1])
  const height = parseFloat(sizeMatch[2])

  const qty = parseInt(
    qtyMatch?.[1] ||
      qtyMatch?.[2] ||
      1
  )

  const mm = `${mmMatch[1]}mm`

  return {
    width,
    height,
    qty,
    mm,
    tempered:
      lower.includes('temper'),

    polishing:
      lower.includes('polish'),

    frosting:
      lower.includes('frost'),

    printing:
      lower.includes('print'),

    lamination:
      lower.includes('lamin'),

    doubleGlaze:
      lower.includes('double')
  }
}

// =========================
// CALCULATE QUOTE
// =========================

function calculateQuote(text) {
  const quote = extractQuote(text)

  if (!quote) return null

  const rates = getRates()

  const sqftEach =
    quote.width * quote.height

  const totalSqft =
    sqftEach * quote.qty

  // =====================
  // GLASS RATE
  // =====================

  const glassRate =
    rates.glass?.[quote.mm] || 0

  // =====================
  // TEMPERING
  // =====================

  const temperRate =
    quote.tempered
      ? rates.tempering?.[quote.mm] || 0
      : 0

  // =====================
  // OTHER SERVICES
  // =====================

  const polishRate =
    quote.polishing
      ? rates.polishing?.flat_polish || 0
      : 0

  const frostRate =
    quote.frosting
      ? rates.frosting?.per_sqft || 0
      : 0

  const printRate =
    quote.printing
      ? rates.printing?.per_sqft || 0
      : 0

  const laminateRate =
    quote.lamination
      ? rates.lamination?.per_sqft || 0
      : 0

  const dguRate =
    quote.doubleGlaze
      ? rates.double_glaze?.per_sqft || 0
      : 0

  // =====================
  // TOTALS
  // =====================

  const totalRate =
    glassRate +
    temperRate +
    polishRate +
    frostRate +
    printRate +
    laminateRate +
    dguRate

  const total =
    totalSqft * totalRate

  return {
    ...quote,
    sqftEach,
    totalSqft,

    glassRate,
    temperRate,
    polishRate,
    frostRate,
    printRate,
    laminateRate,
    dguRate,

    totalRate,
    total
  }
}

// =========================
// FORMAT QUOTE
// =========================

function formatQuote(q) {
  const lines = []

  lines.push('*PSG Estimated Quote*')
  lines.push('')

  lines.push(
    `Size: ${q.width}ft x ${q.height}ft`
  )

  lines.push(`Qty: ${q.qty}`)

  lines.push(`Thickness: ${q.mm}`)

  lines.push('')

  lines.push(
    `Sqft Each: ${q.sqftEach.toFixed(2)}`
  )

  lines.push(
    `Total Sqft: ${q.totalSqft.toFixed(2)}`
  )

  lines.push('')

  lines.push('*Rate Breakdown:*')

  lines.push(
    `Glass: Rs.${q.glassRate}`
  )

  if (q.temperRate > 0)
    lines.push(
      `Tempering: Rs.${q.temperRate}`
    )

  if (q.polishRate > 0)
    lines.push(
      `Polishing: Rs.${q.polishRate}`
    )

  if (q.frostRate > 0)
    lines.push(
      `Frosting: Rs.${q.frostRate}`
    )

  if (q.printRate > 0)
    lines.push(
      `Printing: Rs.${q.printRate}`
    )

  if (q.laminateRate > 0)
    lines.push(
      `Lamination: Rs.${q.laminateRate}`
    )

  if (q.dguRate > 0)
    lines.push(
      `Double Glaze: Rs.${q.dguRate}`
    )

  lines.push('')

  lines.push(
    `Total Rate: *Rs.${q.totalRate}/sqft*`
  )

  lines.push(
    `TOTAL: *Rs.${q.total.toFixed(0)}*`
  )

  lines.push('')

  lines.push(
    '_Estimated quote. Final price confirmed at order._'
  )

  return lines.join('\n')
}

// =========================
// AI FAQ HANDLER
// =========================

async function askAI(userId) {
  const knowledgeText = `
COMPANY: ${kb.website.name}

ADDRESS: ${kb.website.address}

PHONE: ${kb.website.phone.join(', ')}

EMAIL: ${kb.website.email}

PRODUCTS:
${kb.products.map((p) => p.name).join(', ')}

FAQ:
${kb.faq
  .map(
    (f) =>
      `Q: ${f.q}\nA: ${f.a}`
  )
  .join('\n\n')}
`

  const messages = [
    {
      role: 'system',
      content: `
You are a professional WhatsApp sales assistant for Pakistan Safety Glass (PSG).

IMPORTANT RULES:

- NEVER invent prices
- NEVER calculate quotes yourself
- Quotes are already calculated by backend
- Keep replies short and professional
- Be friendly
- Use WhatsApp style formatting
- If unsure, ask customer to call PSG office

${knowledgeText}
`
    },

    ...conversations[userId]
  ]

  const models = [
    'openai/gpt-4o-mini',
    'deepseek/deepseek-chat',
    'google/gemini-2.0-flash-exp'
  ]

  for (const model of models) {
    try {
      console.log('Trying:', model)

      const res =
        await openai.chat.completions.create({
          model,
          messages,
          timeout: 15000
        })

      return res.choices[0].message.content
    } catch (err) {
      console.log(
        `Failed ${model}:`,
        err.message
      )
    }
  }

  return 'Our assistant is currently busy. Please call +92-21-35042275.'
}

// =========================
// WEBHOOK VERIFY
// =========================

app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] &&
    req.query['hub.verify_token'] ===
      VERIFY_TOKEN
  ) {
    return res
      .status(200)
      .send(req.query['hub.challenge'])
  }

  res.sendStatus(403)
})

// =========================
// MAIN WEBHOOK
// =========================

app.post('/webhook', async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]
        ?.changes?.[0]
        ?.value?.messages?.[0]

    if (!message)
      return res.sendStatus(200)

    const from = message.from

    const text =
      message.text?.body?.trim()

    if (!text)
      return res.sendStatus(200)

    console.log(`[${from}] ${text}`)

    // =====================
    // ADMIN COMMANDS
    // =====================

    if (from === ADMIN_NUMBER) {
      const lower = text.toLowerCase()

      // SHOW RATES
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

      // HELP
      if (
        lower === 'admin' ||
        lower === 'help'
      ) {
        await sendMessage(
          from,
          `*PSG Bot Admin Commands*

show rates

update 6mm glass 400

update 6mm tempered 80

update polishing 40

update frosting 100

update lamination 200

update printing 150`
        )

        return res.sendStatus(200)
      }

      // UPDATE RATE
      if (
        lower.startsWith('update ') ||
        lower.startsWith('set ')
      ) {
        const result =
          parseRateUpdate(text)

        await sendMessage(
          from,
          result ||
            '❌ Invalid format.'
        )

        return res.sendStatus(200)
      }
    }

    // =====================
    // AUTO QUOTE SYSTEM
    // =====================

    const calculated =
      calculateQuote(text)

    if (calculated) {
      const quoteText =
        formatQuote(calculated)

      await sendMessage(
        from,
        quoteText
      )

      return res.sendStatus(200)
    }

    // =====================
    // AI CHAT
    // =====================

    if (!conversations[from]) {
      conversations[from] = []
    }

    conversations[from].push({
      role: 'user',
      content: text
    })

    conversations[from] =
      conversations[from].slice(-10)

    const aiReply =
      await askAI(from)

    conversations[from].push({
      role: 'assistant',
      content: aiReply
    })

    await sendMessage(
      from,
      aiReply
    )

    console.log('Reply sent')

    res.sendStatus(200)
  } catch (err) {
    console.error(
      'Webhook Error:',
      err.response?.data || err.message
    )

    res.sendStatus(500)
  }
})

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {
  console.log(
    `PSG WhatsApp Bot running on port ${PORT}`
  )
})
