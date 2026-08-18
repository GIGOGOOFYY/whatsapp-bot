// Replaces services/crmService.js (Mongoose -> D1) and models/Customer.js, Inquiry.js.
// Table schema: migrations/0001_init.sql

import { addInquiry, addCustomerLead } from './sheets.js'

export async function saveInquiry(env, phone, message, response) {
  await env.DB.prepare(
    `INSERT INTO inquiries (customer_phone, message, response) VALUES (?, ?, ?)`
  ).bind(phone, message, response).run()

  const existing = await env.DB.prepare(
    `SELECT id FROM customers WHERE phone = ?`
  ).bind(phone).first()

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO customers (phone) VALUES (?)`
    ).bind(phone).run()
  }

  try {
    await addInquiry(env, phone, message, response)
  } catch (sheetErr) {
    console.log('Sheets Error:', sheetErr.message)
  }
}

export async function saveCustomerLead(env, lead) {
  try {
    await env.DB.prepare(
      `INSERT INTO customers (phone, name, company, city)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET name = excluded.name, company = excluded.company, city = excluded.city`
    ).bind(lead.phone, lead.name, lead.company, lead.city).run()
  } catch (e) {
    console.log('D1 lead error:', e.message)
  }

  try {
    await addCustomerLead(env, lead)
  } catch (e) {
    console.log('Sheets lead error:', e.message)
  }
}

export async function saveQuotation(env, q) {
  await env.DB.prepare(
    `INSERT INTO quotations
     (customer_phone, glass_type, width_mm, height_mm, pieces, layers, sqft, rate, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    q.customerPhone, q.glassType || null, q.widthMM || null, q.heightMM || null,
    q.pieces || null, q.layers || null, q.sqft || null, q.rate || null, q.total || null
  ).run()
}

export async function logMedia(env, phone, mediaType, mimeType, mediaKey, caption) {
  await env.DB.prepare(
    `INSERT INTO media_log (customer_phone, media_type, mime_type, media_key, caption) VALUES (?, ?, ?, ?, ?)`
  ).bind(phone, mediaType, mimeType, mediaKey, caption || '').run()
}
