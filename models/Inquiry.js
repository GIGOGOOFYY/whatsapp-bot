const mongoose = require("mongoose");

const InquirySchema = new mongoose.Schema({
    customerPhone: String,
    message: String,
    response: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Inquiry", InquirySchema);