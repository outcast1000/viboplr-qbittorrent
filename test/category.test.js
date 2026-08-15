const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const inCategory = plugin._hashesInCategory;

const TORRENTS = {
  a: { hash: "a", category: "viboplr" },
  b: { hash: "b", category: "viboplr-work" },
  c: { hash: "c", category: "" },
  d: { hash: "d" },
  e: { hash: "e", category: "viboplr-work" },
};

test("finds every torrent under a category", () => {
  assert.deepEqual(inCategory(TORRENTS, "viboplr-work").sort(), ["b", "e"]);
});

test("matches the category exactly", () => {
  // "viboplr" must not sweep up "viboplr-work" — with one profile per category
  // that would hand a profile another profile's downloads.
  assert.deepEqual(inCategory(TORRENTS, "viboplr"), ["a"]);
});

test("an empty category matches nothing rather than everything", () => {
  // Uncategorised torrents are the user's own; a bulk action must never treat
  // "no category set" as "all of them".
  assert.deepEqual(inCategory(TORRENTS, ""), []);
  assert.deepEqual(inCategory(TORRENTS, null), []);
  assert.deepEqual(inCategory(TORRENTS, undefined), []);
});

test("a category nothing uses yields nothing", () => {
  assert.deepEqual(inCategory(TORRENTS, "nope"), []);
  assert.deepEqual(inCategory({}, "viboplr"), []);
  assert.deepEqual(inCategory(null, "viboplr"), []);
});
