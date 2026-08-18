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

test("the match note counts; the files list below does the naming", () => {
  assert.equal(note(["CD1/07 - Bjork - Joga.flac"]), "matches 1 file");
  assert.equal(note(["A/one.flac", "A/two.flac", "A/three.flac"]), "matches 3 files");
});

test("the row leads its subtitle with the match note", () => {
  const r = row(T.comp, ["CD1/07 - Bjork - Joga (Chill Edit).flac"]);
  assert.ok(r.subtitle.startsWith("matches 1 file"));
  // And without matches the row is exactly what it always was.
  assert.ok(!row(T.comp).subtitle.includes("matches"));
});

// --- The "Matching files" list -----------------------------------------------

const matchItems = plugin._fileMatchItems;

function entry(torrent, files) {
  return { torrent, fileMatches: files };
}

test("every found file becomes a readable row of its own", () => {
  const r = matchItems([
    entry(T.comp, ["CD1/07 - Bjork - Joga (Chill Edit).flac", "CD1/08 - Sigur Ros - Svefn.flac"]),
  ]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.total, 2);
  assert.equal(r.shown, 2);
  assert.equal(r.overflow, false);
  // Basename as the title; folder and torrent in the subtitle.
  assert.equal(r.rows[0].title, "07 - Bjork - Joga (Chill Edit).flac");
  assert.ok(r.rows[0].subtitle.includes("CD1"));
  assert.ok(r.rows[0].subtitle.includes("VA - Nordic Chill Compilation"));
  // The hash rides in the id so the click can find its torrent. With no file
  // list fetched yet the row carries its POSITION behind an "n" — a position is
  // not a file index, and an action that confused the two would play the wrong
  // file. Nothing offers to play it, either.
  assert.equal(r.rows[0].id, "qbtm:h2:n0");
  assert.equal(r.rows[0].action, "qbt:open-match");
  assert.deepEqual(r.rows[0].actions, ["qbt:open-match"]);
  assert.equal(r.rows[0].path, null);
  assert.deepEqual(r.downloaded, []);
});

test("name-matched torrents contribute no file rows", () => {
  const r = matchItems([entry(T.bjork, []), entry(T.comp, ["CD1/07 - Joga.flac"])]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].id, "qbtm:h2:n0");
});

test("a torrent with many matches is capped with a '+N more' row", () => {
  const files = [];
  for (let i = 0; i < 9; i++) files.push("Disc/" + (i + 1) + ".flac");
  const r = matchItems([entry(T.comp, files)]);
  // 5 real rows plus the stand-in.
  assert.equal(r.rows.length, 6);
  assert.equal(r.shown, 5);
  assert.equal(r.total, 9);
  const more = r.rows[5];
  assert.equal(more.id, "qbtm:h2:more");
  assert.ok(more.title.startsWith("+4 more"));
  // It is not a file: nothing to play, nothing to enqueue, and it expands the
  // list rather than navigating away from it.
  assert.deepEqual(more.actions, []);
  assert.equal(more.action, "qbt:expand-matches");
  // Per-torrent capping is represented, so it is not an overflow.
  assert.equal(r.overflow, false);
});

test("expanding a torrent lists every one of its matches", () => {
  // The cap is why "+N more" exists at all, and with a selection to build here
  // the hidden matches were matches you could not pick.
  const files = [];
  for (let i = 0; i < 9; i++) files.push("Disc/" + (i + 1) + ".flac");
  const r = matchItems([entry(T.comp, files)], { h2: true });
  assert.equal(r.rows.length, 9, "expanded, every match should have a row");
  assert.equal(r.shown, 9);
  assert.ok(!r.rows.some((x) => /:more$/.test(x.id)), "the stand-in should be gone");
});

test("the total cap still holds over an expanded torrent", () => {
  // Expansion defeats the PER-TORRENT cap; the renderer's own limit is what
  // stops 5000 rows nobody will read, so it must survive.
  const files = [];
  for (let i = 0; i < 400; i++) files.push("Disc/" + i + ".flac");
  const r = matchItems([entry(T.comp, files)], { h2: true });
  assert.equal(r.rows.length, 100);
  assert.equal(r.total, 400);
  assert.equal(r.overflow, true);
});

test("the total cap cuts the list and says so via overflow", () => {
  // 30 torrents × 4 matches = 120 file rows wanted, cap is 100.
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push(entry({ hash: "t" + i, name: "Torrent " + i, size: 1, state: "stalledUP" },
      ["a.flac", "b.flac", "c.flac", "d.flac"]));
  }
  const r = matchItems(entries);
  assert.equal(r.rows.length, 100);
  assert.equal(r.shown, 100);
  assert.equal(r.total, 120);
  assert.equal(r.overflow, true);
});

// --- acting on a selection of matches ----------------------------------------

test("a selection is grouped by torrent, in the order the list showed it", () => {
  // Three releases must queue as three releases, not interleaved by whatever
  // order the ids happen to arrive in.
  const groups = plugin._matchRowGroups({
    selectedIds: ["qbtm:h1:4", "qbtm:h2:0", "qbtm:h1:9", "qbtm:h3:2"],
  });
  assert.deepEqual(groups, [
    { hash: "h1", indices: [4, 9] },
    { hash: "h2", indices: [0] },
    { hash: "h3", indices: [2] },
  ]);
});

test("rows that name no file drop out of a selection", () => {
  // A "+N more" stand-in and a row whose torrent has not been read yet both
  // name no file index — acting on either would be acting on a guess.
  const groups = plugin._matchRowGroups({
    selectedIds: ["qbtm:h1:more", "qbtm:h1:n0", "qbtm:h1:3", "nonsense"],
  });
  assert.deepEqual(groups, [{ hash: "h1", indices: [3] }]);
  assert.deepEqual(plugin._matchRowGroups({ selectedIds: ["qbtm:h1:more"] }), []);
  assert.deepEqual(plugin._matchRowGroups({}), []);
});

test("a single row acted on without a selection still resolves", () => {
  // The hover buttons send itemId, not selectedIds.
  assert.deepEqual(plugin._matchRowGroups({ itemId: "qbtm:h1:7" }), [{ hash: "h1", indices: [7] }]);
});

test("the hash is readable from every kind of match row", () => {
  assert.equal(plugin._matchRowHash("qbtm:h2:3"), "h2");
  assert.equal(plugin._matchRowHash("qbtm:h2:n0"), "h2");
  assert.equal(plugin._matchRowHash("qbtm:h2:more"), "h2");
  assert.equal(plugin._matchRowHash("nonsense"), null);
});

test("a file straight in the torrent root has no folder prefix", () => {
  const r = matchItems([entry(T.comp, ["single.flac"])]);
  assert.ok(r.rows[0].subtitle.startsWith("in “"));
});
