const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// --- The matcher --------------------------------------------------------------
//
// A false positive here plays the WRONG SONG, which is strictly worse than
// declining — so every test that loosens a rule must argue with that.

const norm = plugin._normalizeForMatch;
const contains = plugin._containsAllTokens;
const score = plugin._titleMatchScore;
const find = plugin._findTrackInTorrents;
const confirm = plugin._confirmByTags;
const THRESHOLD = plugin._MATCH_THRESHOLD;

test("normalization folds case, diacritics, and release qualifiers", () => {
  assert.equal(norm("Jóga"), "joga");
  assert.equal(norm("BJÖRK"), "bjork");
  assert.equal(norm("Jóga (Remastered 2015)"), "joga");
  assert.equal(norm("Army of Me [Deluxe Edition]"), "army of me");
  assert.equal(norm("So Broken feat. Guy Sigsworth"), "so broken");
  assert.equal(norm("Hyperballad__-  (Live at Shepherd's Bush)"), "hyperballad");
});

test("greek and cyrillic survive normalization instead of vanishing", () => {
  assert.equal(norm("Το Μινόρε της Αυγής"), "το μινορε της αυγης".normalize("NFD").replace(/[̀-ͯ]/g, ""));
  assert.ok(contains(norm("01 - Кино - Группа крови.mp3"), "Группа крови"));
});

test("token containment is whole-word, so One does not hide in Someone", () => {
  assert.ok(contains(norm("09 - Metallica - One.flac"), "One"));
  assert.ok(!contains(norm("03 - Someone Like You.flac"), "One"));
});

test("a filename title with artist evidence in the path clears the threshold", () => {
  const s = score(
    { fileName: "Bjork - Homogenic/05 - Joga.flac", torrentName: "Bjork - Homogenic (1997) FLAC" },
    { title: "Jóga", artist: "Björk" }
  );
  assert.ok(s >= THRESHOLD, "score " + s);
});

test("a title alone NEVER clears the threshold", () => {
  // "Joga" matches the filename, but nothing anywhere says Björk or Homogenic.
  const s = score(
    { fileName: "random/05 - Joga.flac", torrentName: "VA - Random Hits 2019" },
    { title: "Jóga", artist: "Björk", album: "Homogenic" }
  );
  assert.ok(s > 0, "title evidence should register");
  assert.ok(s < THRESHOLD, "but must not clear the threshold, got " + s);
});

test("album evidence corroborates when the artist is nowhere", () => {
  const s = score(
    { fileName: "Homogenic [FLAC]/05 - Joga.flac", torrentName: "Homogenic 24bit" },
    { title: "Jóga", artist: "Björk", album: "Homogenic" }
  );
  assert.ok(s >= THRESHOLD, "score " + s);
});

test("an exact tag title outranks a filename hit", () => {
  const byName = score(
    { fileName: "Bjork/05 - Joga.flac", torrentName: "Bjork - Homogenic" },
    { title: "Jóga", artist: "Björk" }
  );
  const byTag = score(
    {
      fileName: "Bjork/05.flac",
      torrentName: "Bjork - Homogenic",
      tags: { title: "Jóga", artist: "Björk", album: "Homogenic" },
    },
    { title: "Jóga", artist: "Björk" }
  );
  assert.ok(byTag > byName, byTag + " should beat " + byName);
});

test("duration 30s apart is a different recording — hard veto", () => {
  const cand = {
    fileName: "Bjork - Homogenic/05 - Joga.flac",
    torrentName: "Bjork - Homogenic",
    durationSecs: 500,
  };
  assert.equal(score(cand, { title: "Jóga", artist: "Björk", durationSecs: 305 }), 0);
  // Close duration is a bonus, not a veto.
  const near = score(
    Object.assign({}, cand, { durationSecs: 307 }),
    { title: "Jóga", artist: "Björk", durationSecs: 305 }
  );
  const noDur = score(
    { fileName: cand.fileName, torrentName: cand.torrentName },
    { title: "Jóga", artist: "Björk", durationSecs: 305 }
  );
  assert.ok(near > noDur, near + " should beat " + noDur);
});

test("findTrackInTorrents picks the best hit across the cache", () => {
  const torrents = {
    h1: { hash: "h1", name: "Bjork - Homogenic (1997) [FLAC]" },
    h2: { hash: "h2", name: "VA - Iceland Compilation" },
    dead: { hash: "dead", name: "gone" },
  };
  const names = {
    h1: ["05 - Joga.flac", "06 - Immature.flac", "cover.jpg"],
    h2: ["CD2/11 - Bjork - Joga (Chill Edit).flac"],
    stale: ["05 - Joga.flac"], // torrent no longer on the server → ignored
  };
  const best = find({ title: "Jóga", artist: "Björk" }, torrents, names);
  assert.ok(best);
  // h1: artist+album context in the torrent name; h2 matches too but h1's
  // clean filename should win or tie — either way the hash must be a live one.
  assert.ok(best.hash === "h1" || best.hash === "h2");
  assert.ok(best.score >= THRESHOLD);
  // A cover.jpg can never match, whatever it is named.
  const art = find({ title: "Cover", artist: "Björk" }, torrents, { h1: ["Bjork - Cover.jpg"] });
  assert.equal(art, null);
});

test("findTrackInTorrents declines when nothing corroborates", () => {
  const torrents = { h: { hash: "h", name: "Unrelated Pack" } };
  const names = { h: ["Joga.mp3"] };
  assert.equal(find({ title: "Jóga", artist: "Björk" }, torrents, names), null);
});

test("tags confirm, contradict, or stay silent", () => {
  assert.equal(confirm({ title: "Jóga" }, { title: "Joga" }), "confirm");
  assert.equal(confirm({ title: "Army of Me" }, { title: "Jóga" }), "contradict");
  assert.equal(confirm({ title: "" }, { title: "Jóga" }), "unknown");
  assert.equal(confirm(null, { title: "Jóga" }), "unknown");
});

// --- Tier-3 candidate filtering & scoring --------------------------------------

const filt = plugin._filterTier3Candidates;
const cscore = plugin._scoreSearchCandidate;
const rank = plugin._rankTier3Candidates;
const fmtScore = plugin._formatKeywordScore;
const budgets = plugin._resolveBudgets;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function cand(over) {
  return Object.assign(
    { fileName: "Bjork - Homogenic (1997) [FLAC]", fileUrl: "magnet:?xt=urn:btih:aa", fileSize: 400 * MB, nbSeeders: 20, nbLeechers: 3 },
    over
  );
}
const CTX = { title: "Jóga", artist: "Björk", album: "Homogenic", format: "flac" };

test("hard filters drop what can never work", () => {
  // A plugin error row reports every count as -1.
  assert.equal(filt([cand({ fileSize: -1, nbSeeders: -1, nbLeechers: -1 })], CTX).length, 0);
  // No download link — nothing to add.
  assert.equal(filt([cand({ fileUrl: "" })], CTX).length, 0);
  // Dead swarm is dead; UNKNOWN swarm (missing count) is not.
  assert.equal(filt([cand({ nbSeeders: 0 })], CTX).length, 0);
  assert.equal(filt([cand({ nbSeeders: -1 })], CTX).length, 1);
  // Size sanity.
  assert.equal(filt([cand({ fileSize: 2 * MB })], CTX).length, 0);
  assert.equal(filt([cand({ fileSize: 40 * GB })], CTX).length, 0);
  // The artist must appear — normalized, so "Bjork" satisfies "Björk".
  assert.equal(filt([cand({ fileName: "Radiohead - OK Computer [FLAC]" })], CTX).length, 0);
  assert.equal(filt([cand()], CTX).length, 1);
});

test("seeders are a floor, not the ranking — format and fit outrank raw swarm", () => {
  const flacAlbum = cand({ nbSeeders: 15 });
  const mp3Discography = cand({
    fileName: "Bjork - Complete Discography 1993-2015 MP3 320",
    fileSize: 12 * GB,
    nbSeeders: 400,
  });
  assert.ok(
    cscore(flacAlbum, CTX) > cscore(mp3Discography, CTX),
    "a fitting FLAC album must outrank a huge top-seeded MP3 discography"
  );
});

test("format keywords follow what the host asked for", () => {
  const name320 = "Bjork - Homogenic (320)";
  const nameFlac = "Bjork - Homogenic [FLAC]";
  assert.ok(fmtScore(nameFlac, "flac") > fmtScore(name320, "flac"));
  assert.ok(fmtScore(name320, "mp3") > fmtScore(nameFlac, "mp3"));
  // No preference: lossless still noses ahead.
  assert.ok(fmtScore(nameFlac, "") > fmtScore(name320, ""));
});

test("ranking caps at the candidate budget", () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push(cand({ fileUrl: "magnet:?xt=urn:btih:" + i, nbSeeders: i + 1 }));
  assert.equal(rank(many, CTX).length, budgets.maxCandidates);
});

// --- Stall detection, percent mapping, budgets ---------------------------------

const stall = plugin._detectResolveStall;
const pct = plugin._resolvePercent;

test("stall detection carries its own bookkeeping", () => {
  let s = { bytes: -1, at: 0 };
  let r = stall(s, 1000, 1000, 5000);
  assert.equal(r.stalled, false);
  s = r.next;
  // No new bytes for less than the window: not stalled, state unchanged.
  r = stall(s, 1000, 4000, 5000);
  assert.equal(r.stalled, false);
  assert.equal(r.next, s);
  // Window exceeded with no bytes: stalled.
  r = stall(s, 1000, 7000, 5000);
  assert.equal(r.stalled, true);
  // Any progress resets the clock.
  r = stall(s, 1001, 7000, 5000);
  assert.equal(r.stalled, false);
});

test("the percent mapping is staged and monotonic", () => {
  assert.ok(pct("search", 0, 0) >= 2);
  assert.ok(pct("search", 0, 1) <= pct("candidate", 0, 0));
  assert.ok(pct("candidate", 0, 1) <= pct("candidate", 1, 0));
  assert.ok(pct("candidate", 2, 1) <= pct("commit", 0, 0) + 1);
  assert.ok(pct("commit", 0, 0) <= pct("download", 0, 0));
  assert.ok(pct("download", 0, 1) <= 100);
  // Fractions are clamped, not trusted.
  assert.equal(pct("download", 0, 7), pct("download", 0, 1));
});

test("budget tripwire: the all-fail worst case stays inside the design envelope", () => {
  // Two searches, then per candidate: attach + metadata. Download stall rides
  // on top only when a candidate commits.
  const worstExamine = budgets.attachAttempts * budgets.attachPollMs + budgets.metaMaxMs;
  const worstAllFail = 2 * budgets.searchMaxMs + budgets.maxCandidates * worstExamine;
  assert.ok(worstAllFail <= 4.5 * 60 * 1000, "all-fail worst case " + worstAllFail + "ms exceeds 4.5min");
  assert.ok(budgets.stallMs <= 3 * 60 * 1000);
});

// --- Janitor & in-torrent file picking -----------------------------------------

const orphan = plugin._isResolveOrphan;
const pickTrack = plugin._pickFileForTrack;
const pickQuery = plugin._pickFileForQuery;

test("the janitor only sweeps what is ours, unowned, and old", () => {
  const t = { hash: "h" };
  const now = 20 * 60 * 1000;
  assert.equal(orphan(t, now - budgets.orphanMaxMs - 1, now, false), true);
  assert.equal(orphan(t, now - 1000, now, false), false, "too fresh");
  assert.equal(orphan(t, now - budgets.orphanMaxMs - 1, now, true), false, "a live job owns it");
  assert.equal(orphan(null, now - budgets.orphanMaxMs - 1, now, false), false, "already gone");
  assert.equal(orphan(t, 0, now, false), false, "never tracked");
});

const FILES = [
  { index: 0, name: "Bjork - Homogenic/01 - Hunter.flac", size: 1, progress: 0, priority: 1 },
  { index: 1, name: "Bjork - Homogenic/05 - Joga.flac", size: 1, progress: 0, priority: 1 },
  { index: 2, name: "Bjork - Homogenic/cover.jpg", size: 1, progress: 0, priority: 1 },
];

test("pickFileForTrack applies the precision matcher inside a torrent", () => {
  const f = pickTrack(FILES, "Bjork - Homogenic (1997) [FLAC]", { title: "Jóga", artist: "Björk" });
  assert.ok(f);
  assert.equal(f.index, 1);
  // Wrong release: nothing clears the threshold, nothing is picked.
  assert.equal(pickTrack(FILES, "Bjork - Homogenic", { title: "Army of Me", artist: "Björk" }), null);
});

test("pickFileForQuery is unambiguous or nothing", () => {
  const f = pickQuery(FILES, "Bjork - Homogenic", "bjork joga");
  assert.ok(f);
  assert.equal(f.index, 1);
  // Two files matching the whole query = ambiguous = decline.
  const twins = [
    { index: 0, name: "Joga (live).flac" },
    { index: 1, name: "Joga (studio).flac" },
  ];
  assert.equal(pickQuery(twins, "Bjork", "bjork joga"), null);
  // No match but exactly one media file: still unambiguous.
  const single = [
    { index: 0, name: "track.mp3" },
    { index: 1, name: "cover.jpg" },
  ];
  assert.ok(pickQuery(single, "whatever", "no such words"));
});
