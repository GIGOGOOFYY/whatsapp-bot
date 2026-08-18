// Ported unchanged from services/calculator.js

export function calculateSqft(widthMM, heightMM, pieces = 1, layers = 1) {
  const widthFt = widthMM / 304.8
  const heightFt = heightMM / 304.8
  // Layers intentionally NOT multiplied here — laminated pricing handled separately
  const sqft = widthFt * heightFt * pieces
  return Number(sqft.toFixed(2))
}
