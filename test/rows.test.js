const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const rowIndices = plugin._rowIndices;

test("an overlay button sends one row", () => {
  // The host fires hover buttons with selectedIds: [row] plus itemId.
  assert.deepEqual(rowIndices({ selectedIds: ["3"], itemId: "3" }), [3]);
});

test("a multi-row selection sends them all", () => {
  assert.deepEqual(rowIndices({ selectedIds: ["0", "2", "5"] }), [0, 2, 5]);
});

test("itemId alone still works", () => {
  // Double-click and the legacy row list send only itemId.
  assert.deepEqual(rowIndices({ itemId: "7" }), [7]);
});

test("row 0 is not mistaken for 'no row'", () => {
  // The first file in every torrent — a truthiness check here would drop it.
  assert.deepEqual(rowIndices({ itemId: "0" }), [0]);
  assert.deepEqual(rowIndices({ selectedIds: ["0"] }), [0]);
});

test("nothing usable yields nothing, rather than NaN", () => {
  assert.deepEqual(rowIndices({}), []);
  assert.deepEqual(rowIndices(null), []);
  assert.deepEqual(rowIndices({ selectedIds: [] }), []);
  assert.deepEqual(rowIndices({ itemId: "not-a-number" }), []);
});
