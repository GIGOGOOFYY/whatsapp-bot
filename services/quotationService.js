const {
    detectLayers,
    extractDimensions,
    extractPieces
} = require("./glassParser");

const {
    calculateSqft
} = require("./calculator");

async function generateQuotation(message) {

    const dimensions = extractDimensions(message);

    if (!dimensions) {
        return {
            error: "Dimensions not found."
        };
    }

    const layers = detectLayers(message);

    const pieces = extractPieces(message);

    const sqft = calculateSqft(
        dimensions.widthMM,
        dimensions.heightMM,
        pieces,
        layers
    );

    let rate = 450;

    if (message.toLowerCase().includes("tempered")) {
        rate += 200;
    }

    if (layers >= 2) {
        rate += 150;
    }

    const total = sqft * rate;

    return {
        widthMM: dimensions.widthMM,
        heightMM: dimensions.heightMM,
        pieces,
        layers,
        sqft,
        rate,
        total
    };
}

module.exports = {
    generateQuotation
};