const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const filterList = plugin._filterTorrentList;
const matchingNames = plugin._matchingNames;
const note = plugin._fileMatchNote;
const row = plugin._torrentRow;

// The torrents-tab filter searches names AND the files inside them, off the
// persistent name cache. Its one honesty rule: a torrent whose files are not
// cached yet is UNKNOWN, not a non-match.

const T = {
  bjork: { hash: "h1", name: "Bjork - Homogenic (1997) FLAC", size: 1, state: "downloading" },
  comp: { hash: "h2", name: "VA - Nordic Chill Compilation", size: 1, state: "stalledUP" },
  film: { hash: "h3", name: "Some Film 2020 1080p", size: 1, state: "uploading" },
  magnet: { hash: "h4", name: "", magnet_uri: "magnet:?xt=urn:btih:h4&dn=Bjork+Live", size: 0, state: "metaDL" },
  cold: { hash: "h5", name: "Unrelated Release", size: 1, state: "stalledUP" },
};
const LIST = [T.bjork, T.comp, T.film, T.magnet, T.cold];

const NAMES = {
  h1: ["01 - Hunter.flac", "02 - Unravel.flac"],
  h2: ["CD1/07 - Bjork - Joga (Chill Edit).flac", "CD1/08 - Sigur Ros - Svefn.flac"],
  h3: ["Some.Film.2020.mkv", "Subs/eng.srt"],
  // h5 deliberately absent: not fetched yet.
};

function hashes(result) {
  return result.shown.map((e) => e.torrent.hash);
}

test("no query shows everything and checks nothing", () => {
  const r = filterList(LIST, "", NAMES);
  assert.deepEqual(hashes(r), ["h1", "h2", "h3", "h4", "h5"]);
  assert.equal(r.unchecked, 0);
  // Blank-but-typed is the same as blank.
  assert.equal(filterList(LIST, "   ", NAMES).unchecked, 0);
});

test("a torrent matches by its own name", () => {
  const r = filterList(LIST, "bjork flac", NAMES);
  assert.ok(hashes(r).includes("h1"));
  // A name match explains itself — no file note.
  assert.deepEqual(r.shown.find((e) => e.torrent.hash === "h1").fileMatches, []);
});

test("a torrent matches by a file inside it, and says which files", () => {
  const r = filterList(LIST, "joga", NAMES);
  assert.deepEqual(hashes(r), ["h2"]);
  assert.deepEqual(r.shown[0].fileMatches, ["CD1/07 - Bjork - Joga (Chill Edit).flac"]);
});

test("file terms match the full path, so a folder name works", () => {
  const r = filterList(LIST, "subs", NAMES);
  assert.deepEqual(hashes(r), ["h3"]);
});

test("an uncached torrent is unknown, not a non-match", () => {
  const r = filterList(LIST, "joga", NAMES);
  // h5 has metadata but no cached names: it cannot answer yet.
  assert.equal(r.unchecked, 1);
  // Once its names arrive, the verdict is real and unchecked drains.
  const warm = Object.assign({ h5: ["whatever.mp3"] }, NAMES);
  assert.equal(filterList(LIST, "joga", warm).unchecked, 0);
});

test("a metadata-less magnet is judged on its display name alone", () => {
  // Its name can match…
  const r = filterList(LIST, "bjork live", NAMES);
  assert.ok(hashes(r).includes("h4"));
  // …and when it doesn't, it is NOT counted as still-to-check: there is no
  // file list to fetch, so "still checking 1 torrent" would never resolve.
  const miss = filterList([T.magnet], "joga", NAMES);
  assert.equal(miss.unchecked, 0);
  assert.equal(miss.shown.length, 0);
});

test("all terms must match, across a name or within one file", () => {
  assert.deepEqual(hashes(filterList(LIST, "bjork chill", NAMES)), ["h2"]);
  assert.equal(matchingNames(NAMES.h2, "sigur svefn").length, 1);
  assert.equal(matchingNames(NAMES.h2, "sigur joga").length, 0);
});

test("the match note names one file, counts the rest", () => {
  assert.equal(note(["CD1/07 - Bjork - Joga.flac"]), "matches “07 - Bjork - Joga.flac”");
  assert.equal(
    note(["A/one.flac", "A/two.flac", "A/three.flac"]),
    "matches 3 files — “one.flac” +2 more"
  );
});

test("the row leads its subtitle with the match note", () => {
  const r = row(T.comp, ["CD1/07 - Bjork - Joga (Chill Edit).flac"]);
  assert.ok(r.subtitle.startsWith("matches “07 - Bjork - Joga (Chill Edit).flac”"));
  // And without matches the row is exactly what it always was.
  assert.ok(!row(T.comp).subtitle.includes("matches"));
});
