const { google } = require('googleapis')

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
})

const sheets = google.sheets({ version: 'v4', auth })

// FIX #4: moved from hardcoded to .env
const SPREADSHEET_ID = process.env.SPREADSHEET_ID

async function addInquiry(phone, message, reply) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Inquiries!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        phone,
        message,
        reply,
        new Date().toLocaleString()
      ]]
    }
  })
}

async function addCustomerLead(lead) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Customers!A:I',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        lead.phone,
        lead.name,
        lead.company,
        lead.city,
        lead.glassType,
        lead.thermalBreak || '',
        lead.windowType || '',
        lead.size,
        lead.quantity,
        new Date().toLocaleString()
      ]]
    }
  })
}

async function addMediaAttachment(phone, mediaType, mimeType, url, caption) {
  // FIX #3a: store plain URL text — no =HYPERLINK() formula that breaks for local files
  const displayUrl = url.startsWith('http') ? url : `[local file: ${url}]`

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Inquiries!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        phone,
        `[${mediaType.toUpperCase()}]`,
        caption || '(no caption)',
        displayUrl,          // plain text, not =HYPERLINK(...)
        mimeType,
        new Date().toLocaleString()
      ]]
    }
  })
}

module.exports = {
  addInquiry,
  addCustomerLead,
  addMediaAttachment
}