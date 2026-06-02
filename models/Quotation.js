const mongoose = require("mongoose");

const QuotationSchema = new mongoose.Schema({
    customerPhone: String,

    glassType: String,

    widthMM: Number,
    heightMM: Number,

    pieces: Number,

    layers: Number,

    sqft: Number,

    rate: Number,

    total: Number,

    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Quotation", QuotationSchema);