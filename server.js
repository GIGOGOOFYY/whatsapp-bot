const express = require('express')
const axios = require('axios')
const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')
const kb = require('./knowledge')

require('dotenv').config()

const app = express()
app.use(express.json())

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

function getRates() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')) }
  catch { return {} }
}

function saveRates(rates) {
  rates.lastUpdated = new Date().toISOString().split('T')[0]
  rates.updatedBy = 'admin via WhatsApp'
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2))
}

function ratesToText(rates) {
  const lines = [`*PSG Current Rates (${rates.currency}, ${rates.unit})*\n`]
  lines.push('*Glass Supply:*')
  Object.entries(rates.glass||{}).forEach(([k,v]) => { if(k!=='note'&&v!==null) lines.push(`  ${k.replace(/_/g,' ')}: Rs.${v}`) })
  lines.push('\n*Tempering:*')
  Object.entries(rates.tempering||{}).forEach(([k,v]) => { if(k!=='note'&&v!==null) lines.push(`  ${k}: Rs.${v}`) })
  const others = ['polishing','beveling','double_glaze','lamination','bent_glass','tempered_bent','printing','frosting','aluminum_window','curtain_wall']
  others.forEach(key => {
    if(rates[key]) {
      const val = rates[key].per_sqft || rates[key].flat_polish
      if(val!==null&&val!==undefined) lines.push(`\n*${key.replace(/_/g,' ').toUpperCase()}:* Rs.${val}`)
    }
  })
  lines.push(`\n_Last updated: ${rates.lastUpdated}_`)
  return lines.join('\n')
}

function parseRateUpdate(text) {
  const t = text.toLowerCase().trim()
  const match = t.match(/(?:update|set)\s+(.+)\s+(\d+(?:\.\d+)?)/)
  if (!match) return null
  const desc = match[1].trim()
  const value = parseFloat(match[2])
  const rates = getRates()

  if (desc.includes('temper')) {
    const mmMatch = desc.match(/(\d+)mm/)
    if (mmMatch) {
      rates.tempering[`${mmMatch[1]}mm`] = value
      saveRates(rates)
      return `✅ ${mmMatch[1]}mm tempering → Rs.${value}`
    }
  }

  const mmMatch = desc.match(/(\d+)mm/)
  if (mmMatch && !desc.includes('temper')) {
    const mm = mmMatch[1]
    if (desc.includes('with hole')) { rates.glass[`${mm}mm_with_holes`] = value }
    else if (desc.includes('without hole')) { rates.glass[`${mm}mm_without_holes`] = value }
    else { rates.glass[`${mm}mm`] = value }
    saveRates(rates)
    return `✅ ${mm}mm glass → Rs.${value}`
  }

  const map = {
    'polish':['polishing','flat_polish'], 'bevel':['beveling','per_sqft'],
    'double':['double_glaze','per_sqft'], 'lamin':['lamination','per_sqft'],
    'temper bent':['tempered_bent','per_sqft'], 'bent temper':['tempered_bent','per_sqft'],
    'bent':['bent_glass','per_sqft'], 'print':['printing','per_sqft'],
    'frost':['frosting','per_sqft'], 'aluminum':['aluminum_window','per_sqft'],
    'curtain':['curtain_wall','per_sqft']
  }
  for (const [kw,[cat,field]] of Object.entries(map)) {
    if (desc.includes(kw)) {
      if(!rates[cat]) rates[cat]={}
      rates[cat][field] = value
      saveRates(rates)
      return `✅ ${cat.replace(/_/g,' ')} → Rs.${value}/sqft`
    }
  }
  return null
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product:'whatsapp', to, text:{ body:text } },
    { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, 'Content-Type':'application/json' } }
  )
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge'])
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

    if (from === ADMIN_NUMBER) {
      const lower = text.toLowerCase()
      if (lower==='show rates'||lower==='rates') { await sendMessage(from, ratesToText(getRates())); return res.sendStatus(200) }
      if (lower==='admin'||lower==='help') {
        await sendMessage(from, `*PSG Bot Admin*\n\n*show rates* — view all rates\n\n*update [item] [price]*\n\nExamples:\nupdate 6mm tempered 75\nupdate 12mm glass 900\nupdate 12mm with holes 950\nupdate polishing 40\nupdate frosting 120\nupdate double glaze 250\nupdate lamination 200\nupdate curtain wall 500\nupdate aluminum window 180\nupdate bent glass 300\nupdate tempered bent 350\nupdate printing 150\nupdate beveling 80`)
        return res.sendStatus(200)
      }
      if (lower.startsWith('update ')||lower.startsWith('set ')) {
        const result = parseRateUpdate(text)
        await sendMessage(from, result || `❌ Format not recognised.\nTry: *update 6mm tempered 75*`)
        return res.sendStatus(200)
      }
    }

    if (!conversations[from]) conversations[from] = []
    conversations[from].push({ role:'user', content:text })
    conversations[from] = conversations[from].slice(-10)

    const aiReply = await askAI(from)
    conversations[from].push({ role:'assistant', content:aiReply })
    await sendMessage(from, aiReply)
    console.log('Reply sent!')
    res.sendStatus(200)
  } catch (err) {
    console.log('ERROR:', err.response?.data || err.message)
    res.sendStatus(500)
  }
})

async function askAI(userId) {
  const r = getRates()
  const ratesText = `
CURRENT RATES (PKR, per sqft):
Glass Supply: ${Object.entries(r.glass||{}).filter(([k])=>k!=='note').map(([k,v])=>`${k.replace(/_/g,' ')} Rs.${v??'TBD'}`).join(' | ')}
Tempering: ${Object.entries(r.tempering||{}).filter(([k])=>k!=='note').map(([k,v])=>`${k} Rs.${v??'TBD'}`).join(' | ')}
Polishing: Rs.${r.polishing?.flat_polish??'TBD'} | Beveling: Rs.${r.beveling?.per_sqft??'TBD'} | Double Glaze: Rs.${r.double_glaze?.per_sqft??'TBD'} | Lamination: Rs.${r.lamination?.per_sqft??'TBD'} | Bent Glass: Rs.${r.bent_glass?.per_sqft??'TBD'} | Tempered Bent: Rs.${r.tempered_bent?.per_sqft??'TBD'} | Printing: Rs.${r.printing?.per_sqft??'TBD'} | Frosting: Rs.${r.frosting?.per_sqft??'TBD'} | Aluminum Window: Rs.${r.aluminum_window?.per_sqft??'TBD'} | Curtain Wall: Rs.${r.curtain_wall?.per_sqft??'TBD'}
`
  const knowledgeText = `COMPANY: ${kb.website.name} | ADDRESS: ${kb.website.address} | PHONE: ${kb.website.phone.join(', ')} | EMAIL: ${kb.website.email}
PRODUCTS: ${kb.products.map(p=>p.name).join(', ')}
${kb.faq.map(f=>`Q: ${f.q}\nA: ${f.a}`).join('\n\n')}`

  const messages = [
    {
      role:'system',
      content:`You are a professional sales assistant for Pakistan Safety Glass (PSG) on WhatsApp.

${knowledgeText}

${ratesText}

QUOTE RULES:
- When customer gives size + quantity, calculate: sqft = (W_ft x H_ft) x qty
- If size in inches: divide by 12 first
- Show breakdown: size → sqft each → total sqft → rate → TOTAL in PKR
- Example: 2ft x 3ft, qty 10, 6mm glass = 6 sqft x 10 = 60 sqft x Rs.375 = *Rs.22,500*
- If rate shows TBD, say "rate not set yet, please call +92-21-35042275"
- Always end quote with: "_Estimated quote. Final price confirmed at order._"
- If customer wants multiple services (e.g. glass + tempering), calculate each separately and add total
- Keep replies short and professional
- Use *bold* for prices and totals`
    },
    ...conversations[userId]
  ]

  const models = ['google/gemma-3-27b-it:free','deepseek/deepseek-chat-v3-0324:free','openai/gpt-4o-mini']
  for (const model of models) {
    try {
      console.log('Trying:', model)
      const res = await openai.chat.completions.create({ model, messages })
      return res.choices[0].message.content
    } catch (e) { console.log(`Failed: ${model}`, e.message) }
  }
  return 'Our assistant is busy. Please call +92-21-35042275 or +92-308-2909634.'
}

app.listen(3000, () => console.log('PSG WhatsApp Bot running on port 3000'))