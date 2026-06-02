const Customer = require("../models/Customer");
const Inquiry = require("../models/Inquiry");

async function saveInquiry(phone, message, response) {

    await Inquiry.create({
        customerPhone: phone,
        message,
        response
    });

    let customer = await Customer.findOne({
        phone
    });

    if (!customer) {
        await Customer.create({
            phone
        });
    }
}

module.exports = {
    saveInquiry
};