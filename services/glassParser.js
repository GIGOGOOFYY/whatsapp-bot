function detectLayers(text) {
    const matches = text.match(/\d+\+\d+(\+\d+)*/);

    if (!matches) return 1;

    return matches[0].split("+").length;
}

function extractDimensions(text) {
    const match = text.match(/(\d+)\s?[xX]\s?(\d+)/);

    if (!match) return null;

    return {
        widthMM: parseInt(match[1]),
        heightMM: parseInt(match[2])
    };
}

function extractPieces(text) {
    const match = text.match(/(\d+)\s?(piece|pcs|pieces)/i);

    if (!match) return 1;

    return parseInt(match[1]);
}

module.exports = {
    detectLayers,
    extractDimensions,
    extractPieces
};