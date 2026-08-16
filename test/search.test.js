const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const queryFor = plugin._searchQueryForTarget;

test("an album target searches artist + album", () => {
  // Artist first because indexers name releases that way: "Artist - Album [FLAC]".
  assert.equal(
    queryFor({ kind: "album", artistName: "Björk", albumTitle: "Homogenic" }),
    "Björk Homogenic",
  );
});

test("an artist target searches just the artist", () => {
  assert.equal(queryFor({ kind: "artist", artistName: "Autechre" }), "Autechre");
});

test("a track target searches its ALBUM, not its title", () => {
  // Searching one track's title finds single-track rips and misses the release
  // it came from — the album is the useful unit on an indexer.
  assert.equal(
    queryFor({ kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" }),
    "Björk Homogenic",
  );
});

test("a track with no album falls back to its title", () => {
  assert.equal(queryFor({ kind: "track", title: "Some Single", artistName: "Someone" }), "Someone Some Single");
});

test("missing fields are dropped rather than becoming blanks", () => {
  assert.equal(queryFor({ kind: "album", albumTitle: "Homogenic" }), "Homogenic");
  assert.equal(queryFor({ kind: "artist", artistName: "  " }), "");
  assert.equal(queryFor({}), "");
  assert.equal(queryFor(null), "");
});

test("siteLabel reduces an indexer URL to its host", () => {
  assert.equal(plugin._siteLabel("https://www.example-tracker.org/torrent/1"), "example-tracker.org");
  assert.equal(plugin._siteLabel("http://tracker.net:8080/x"), "tracker.net");
  assert.equal(plugin._siteLabel(""), "");
});

test("results are sorted by seeders", () => {
  // Seeders are the difference between a download and a dead entry.
  const sorted = plugin._sortSearchResults([
    { fileName: "a", nbSeeders: 3, fileSize: 100 },
    { fileName: "b", nbSeeders: 40, fileSize: 100 },
    { fileName: "c", nbSeeders: 0, fileSize: 100 },
  ]);
  assert.deepEqual(sorted.map((r) => r.fileName), ["b", "a", "c"]);
});

test("equal seeders break on size, so the order is stable", () => {
  // Otherwise the order depends on which indexer answered first, and the list
  // reshuffles under the user as more results stream in.
  const sorted = plugin._sortSearchResults([
    { fileName: "small", nbSeeders: 5, fileSize: 100 },
    { fileName: "big", nbSeeders: 5, fileSize: 900 },
  ]);
  assert.deepEqual(sorted.map((r) => r.fileName), ["big", "small"]);
});

test("sorting doesn't mutate the caller's array", () => {
  const input = [{ nbSeeders: 1 }, { nbSeeders: 9 }];
  plugin._sortSearchResults(input);
  assert.equal(input[0].nbSeeders, 1);
});

test("a result's subtitle carries size, swarm and source", () => {
  const s = plugin._searchResultSubtitle({
    fileSize: 1024 * 1024 * 500,
    nbSeeders: 12,
    nbLeechers: 3,
    siteUrl: "https://example.org",
  });
  // formatBytes drops the decimal at 10 units and up, so this is "500 MB".
  assert.match(s, /500 MB/);
  assert.match(s, /12 seeders/);
  assert.match(s, /3 leechers/);
  assert.match(s, /example\.org/);
});

test("a search result is identified by URL, not by position", () => {
  // Results stream in and re-sort by seeders on every poll, so an index captured
  // when a row was drawn can point at a different result — or past the end — by
  // the time it is clicked.
  assert.equal(
    plugin._searchResultId({ fileUrl: "https://x/y.torrent", fileName: "Album" }),
    "https://x/y.torrent",
  );
});

test("a result with no download link still gets an id", () => {
  // It needs one to be clickable at all; the click then explains itself rather
  // than silently doing nothing.
  assert.equal(plugin._searchResultId({ descrLink: "https://x/page", fileName: "Album" }), "https://x/page");
  assert.equal(plugin._searchResultId({ fileName: "Album" }), "Album");
  assert.equal(plugin._searchResultId(null), "");
});

test("rowIds keeps ids as strings", () => {
  // rowIndices would parseInt a URL into NaN and drop the click.
  assert.deepEqual(plugin._rowIds({ selectedIds: ["https://x/y.torrent"] }), ["https://x/y.torrent"]);
  assert.deepEqual(plugin._rowIds({ itemId: "https://x/y.torrent" }), ["https://x/y.torrent"]);
  assert.deepEqual(plugin._rowIds({ selectedIds: ["a", "b"] }), ["a", "b"]);
});

test("rowIds yields nothing when there is nothing to act on", () => {
  assert.deepEqual(plugin._rowIds({}), []);
  assert.deepEqual(plugin._rowIds(null), []);
  assert.deepEqual(plugin._rowIds({ itemId: "" }), []);
});

test("a subtitle survives a result missing everything", () => {
  // Indexers vary in what they report; a missing field must not blank the row.
  const s = plugin._searchResultSubtitle({});
  assert.match(s, /0 seeders/);
  assert.match(s, /—/);
});
