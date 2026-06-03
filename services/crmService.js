const Customer = require("../models/Customer");
const Inquiry = require("../models/Inquiry");
const { addInquiry, addCustomerLead } = require("./googleSheets");

async function saveInquiry(phone, message, response) {
  await Inquiry.create({ customerPhone: phone, message, response });

  let customer = await Customer.findOne({ phone });
  if (!customer) await Customer.create({ phone });

  try {
    await addInquiry(phone, message, response);
  } catch (sheetErr) {
    console.log('Sheets Error:', sheetErr.message);
  }
}

async function saveCustomerLead(lead) {
  try {
    await Customer.findOneAndUpdate(
      { phone: lead.phone },
      {
        phone: lead.phone,
        name: lead.name,
        company: lead.company,
        city: lead.city
      },
      { upsert: true }
    )
  } catch (e) {
    console.log('MongoDB lead error:', e.message)
  }

  try {
    await addCustomerLead(lead)
  } catch (e) {
    console.log('Sheets lead error:', e.message)
  }
}

module.exports = { saveInquiry, saveCustomerLead };