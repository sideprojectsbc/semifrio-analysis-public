// arrow_rows.js: turns a DuckDB-WASM result into plain JavaScript values.
//
// DuckDB-WASM answers every query with an "Arrow table" (a column-by-column format). That is fast,
// but awkward to draw from: whole numbers come back as BigInt (10n instead of 10), decimals as raw
// 128-bit words, dates as milliseconds. These helpers convert each value into something simple.

// Arrow's type numbers (apache-arrow's `Type` enum), for the few types that need converting.
const TYPE = { Decimal: 7, Date: 8, Timestamp: 10, List: 12, Struct: 13, Map: 17 };

function plainValue(value, type) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    // COUNT(*) and other whole numbers. Safe as a JS number up to 9 million billion.
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (type.typeId === TYPE.Decimal && ArrayBuffer.isView(value)) {
    // A decimal (e.g. the literal 1.5) arrives as 32-bit words, least significant first,
    // plus a "scale" (number of digits after the point) in the column type.
    let big = 0n;
    for (let i = value.length - 1; i >= 0; i--) big = (big << 32n) | BigInt(value[i] >>> 0);
    const bits = BigInt(value.length * 32);
    if (big >> (bits - 1n)) big -= 1n << bits; // negative number (two's complement)
    return Number(big) / 10 ** type.scale;
  }
  if (type.typeId === TYPE.Date || type.typeId === TYPE.Timestamp) {
    const d = value instanceof Date ? value : new Date(Number(value));
    return type.typeId === TYPE.Date ? d.toISOString().slice(0, 10) : d.toISOString().replace('T', ' ').replace('Z', '');
  }
  if ([TYPE.List, TYPE.Struct, TYPE.Map].includes(type.typeId)) {
    // Nested values: show them as JSON text.
    const json = typeof value.toJSON === 'function' ? value.toJSON() : value;
    return JSON.stringify(json, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  }
  return value;
}

// Result as a grid: { columns: ['a', 'b'], rows: [[1, 2], [3, 4]] }. Keeps duplicate column names.
export function arrowToGrid(table) {
  const fields = table.schema.fields;
  const vectors = fields.map((f, i) => table.getChildAt(i));
  const rows = [];
  for (let r = 0; r < table.numRows; r++) {
    rows.push(fields.map((f, i) => plainValue(vectors[i].get(r), f.type)));
  }
  return { columns: fields.map(f => f.name), rows };
}

// Result as a list of objects: [{ a: 1, b: 2 }, ...]. What the views use.
export function arrowToObjects(table) {
  const { columns, rows } = arrowToGrid(table);
  return rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}
