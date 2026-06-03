const Customer = require("../models/Customer");
const Inquiry = require("../models/Inquiry");
const { addInquiry } = require("./googleSheets");

async function saveInquiry(phone, message, response) {

  await Inquiry.create({ customerPhone: phone, message, response });

  let customer = await Customer.findOne({ phone });
  if (!customer) {
    await Customer.create({ phone });
  }

  // Save to Google Sheet
  try {
    await addInquiry(phone, message, response);
  } catch (sheetErr) {
    console.log('Sheets Error:', sheetErr.message);
  }
}

module.exports = { saveInquiry };