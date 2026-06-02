const { google } = require('googleapis')

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
})

const sheets = google.sheets({ version: 'v4', auth })

const SPREADSHEET_ID = '1z4DpE0fL9633pmAftsmR9OTPPhngX3oQIKtlsLED4k8'

async function addInquiry(phone, message, reply) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Inquiries!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[phone, message, reply, new Date().toLocaleString()]]
    }
  })
}

module.exports = { addInquiry }