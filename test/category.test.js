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

// Using no category at all is a supported choice ("leave it empty to tag
// nothing"), and it means the view shows everything — the switch narrows the
// list TO a category, it cannot narrow it to no category.
const filterActive = plugin._categoryFilterActive;

test("no category means no filter, whatever the switch says", () => {
  assert.equal(filterActive(true, ""), false);
  assert.equal(filterActive(true, null), false);
  assert.equal(filterActive(true, undefined), false);
  // Whitespace is not a category name either — it would match nothing and hide
  // every torrent the user has.
  assert.equal(filterActive(true, "   "), false);
});

test("a named category filters only while the switch is on", () => {
  assert.equal(filterActive(true, "viboplr"), true);
  assert.equal(filterActive(false, "viboplr"), false);
});

// Renaming the category strands torrents under the old name — they drop out of
// a view that now filters on the new one, so the old name is remembered to
// offer moving them. Clearing the box is not a rename.
const nextPrev = plugin._nextPreviousCategory;

test("a rename remembers the name being left behind", () => {
  assert.equal(nextPrev("viboplr", "viboplr-work", ""), "viboplr");
});

test("clearing the category remembers nothing", () => {
  // Nothing is filtered afterwards, so nothing is stranded. Remembering anyway
  // put up a banner claiming the torrents were "hidden by the “” filter" while
  // they sat in the list below it, over a button that would have stripped their
  // category in qBittorrent.
  assert.equal(nextPrev("viboplr", "", ""), "");
  assert.equal(nextPrev("viboplr", "", "older"), "");
});

test("adopting a category for the first time strands nothing", () => {
  // Torrents that were never tagged are not this plugin's to claim.
  assert.equal(nextPrev("", "viboplr", ""), "");
});

test("the name just left replaces whatever was remembered", () => {
  // Only one can be offered, and it is the one that just stranded torrents —
  // an older memory has already had its banner and its "Leave them".
  assert.equal(nextPrev("viboplr-work", "viboplr", "viboplr"), "viboplr-work");
});

test("returning to the remembered name forgets it", () => {
  // Cleared the box, then typed the old name back: the torrents are under that
  // name again, so nothing is stranded and there is nothing to offer.
  assert.equal(nextPrev("", "viboplr", "viboplr"), "");
});

test("an unchanged category leaves the memory alone", () => {
  assert.equal(nextPrev("viboplr", "viboplr", "viboplr-old"), "viboplr-old");
});
