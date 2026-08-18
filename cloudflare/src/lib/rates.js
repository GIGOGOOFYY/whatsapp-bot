// Replaces fs.readFileSync/writeFileSync(Rates.json) in server.js with a KV-backed store.
// Seed the initial value with: wrangler kv key put --binding=SESSIONS rates "$(cat Rates.json)"
// (see README-CLOUDFLARE.md). Logic below is otherwise unchanged from server.js.

export async function getRates(env) {
  const raw = await env.SESSIONS.get('rates')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export async function saveRates(env, rates) {
  rates.lastUpdated = new Date().toISOString().split('T')[0]
  rates.updatedBy = 'admin via WhatsApp'
  await env.SESSIONS.put('rates', JSON.stringify(rates))
}

export function ratesToText(rates) {
  const lines = [`*PSG Current Rates (${rates.currency}, ${rates.unit})*\n`]
  lines.push('*Glass Supply:*')
  Object.entries(rates.glass || {}).forEach(([k, v]) => { if (k !== 'note') lines.push(`  ${k.replace(/_/g, ' ')}: Rs.${v ?? 'TBD'}`) })
  lines.push('\n*Tempering:*')
  Object.entries(rates.tempering || {}).forEach(([k, v]) => { if (k !== 'note') lines.push(`  ${k}: Rs.${v ?? 'TBD'}`) })
  lines.push('\n*Other Services:*')
  if (rates.lamination?.per_sqft) lines.push(`  Lamination: Rs.${rates.lamination.per_sqft}`)
  if (rates.polishing?.flat_polish) lines.push(`  Polishing: Rs.${rates.polishing.flat_polish}`)
  if (rates.beveling?.per_sqft) lines.push(`  Beveling: Rs.${rates.beveling.per_sqft ?? 'TBD'}`)
  if (rates.double_glaze?.per_sqft) lines.push(`  Double Glaze: Rs.${rates.double_glaze.per_sqft ?? 'TBD'}`)
  return lines.join('\n')
}

export async function parseRateUpdate(env, text) {
  const t = text.toLowerCase().trim()
  const match = t.match(/(?:update|set)\s+(.+?)\s+(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const desc = match[1].trim()
  const value = parseFloat(match[2])
  const rates = await getRates(env)

  if (desc.includes('temper')) {
    const m = desc.match(/(\d+)mm/)
    if (m) { rates.tempering[`${m[1]}mm`] = value; await saveRates(env, rates); return `✅ ${m[1]}mm tempering → Rs.${value}` }
  }
  if (desc.includes('laminat')) {
    rates.lamination = rates.lamination || {}; rates.lamination.per_sqft = value
    await saveRates(env, rates); return `✅ Lamination → Rs.${value}/sqft`
  }
  if (desc.includes('polish')) {
    rates.polishing = rates.polishing || {}; rates.polishing.flat_polish = value
    await saveRates(env, rates); return `✅ Polishing → Rs.${value}/sqft`
  }
  if (desc.includes('bevel')) {
    rates.beveling = rates.beveling || {}; rates.beveling.per_sqft = value
    await saveRates(env, rates); return `✅ Beveling → Rs.${value}/sqft`
  }
  if (desc.includes('double') || desc.includes('dgu')) {
    rates.double_glaze = rates.double_glaze || {}; rates.double_glaze.per_sqft = value
    await saveRates(env, rates); return `✅ Double Glaze → Rs.${value}/sqft`
  }

  const m = desc.match(/(\d+)mm/)
  if (m) {
    const mm = m[1]
    if (desc.includes('with hole')) rates.glass[`${mm}mm_with_holes`] = value
    else if (desc.includes('without hole')) rates.glass[`${mm}mm_without_holes`] = value
    else rates.glass[`${mm}mm`] = value
    await saveRates(env, rates)
    return `✅ ${mm}mm glass → Rs.${value}`
  }
  return null
}
