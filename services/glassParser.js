function detectLayers(text) {
const matches = text.match(/\d+\+\d+(\+\d+)*/);

if (!matches) return 1;

return matches[0].split('+').length;

}


function extractThicknesses(text) {
// Detect formats like:
// 5+5
// 6+6
// 12+12
// 8+8+8

const layered = text.match(/(\d+)(\+\d+)+/);

if (layered) {
    return layered[0]
        .split('+')
        .map(v => parseInt(v));
}

// Single thickness like 12mm
const single = text.match(/(\d+)\s?mm/i);

if (single) {
    return [parseInt(single[1])];
}

return [];

}

function extractDimensions(text) {
// Supports:
// 1000x2000
// 1000 x 2000
// 1ft x 1ft


const ftMatch = text.match(/(\d+(?:\.\d+)?)\s?ft\s?[xX]\s?(\d+(?:\.\d+)?)\s?ft/i);

if (ftMatch) {
    return {
        widthMM: parseFloat(ftMatch[1]) * 304.8,
        heightMM: parseFloat(ftMatch[2]) * 304.8
    };
}

const mmMatch = text.match(/(\d+)\s?[xX]\s?(\d+)/);

if (!mmMatch) return null;

return {
    widthMM: parseInt(mmMatch[1]),
    heightMM: parseInt(mmMatch[2])
};


}

function extractPieces(text) {
const match = text.match(/(\d+)\s?(piece|pcs|pieces)/i);


if (!match) return 1;

return parseInt(match[1]);


}

module.exports = {
detectLayers,
extractThicknesses,
extractDimensions,
extractPieces
};
