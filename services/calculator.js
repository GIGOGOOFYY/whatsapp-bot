function calculateSqft(widthMM, heightMM, pieces = 1, layers = 1) {

```
const widthFt = widthMM / 304.8;

const heightFt = heightMM / 304.8;

// Layers intentionally NOT multiplied here
// because laminated pricing is handled separately

const sqft =
    widthFt *
    heightFt *
    pieces;

return Number(sqft.toFixed(2));
```

}

module.exports = {
calculateSqft
};
