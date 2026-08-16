const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("magnetHash reads a v1 hex info hash", () => {
  assert.equal(
    plugin._magnetHash("magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=x"),
    "c12fe1c06bba254a9dc9f519b335aa7c1367a88a",
  );
});

test("magnetHash reads a v2 hash and lowercases both", () => {
  const v2 = "a".repeat(64).toUpperCase();
  assert.equal(plugin._magnetHash("magnet:?xt=urn:btmh:" + v2), "a".repeat(64));
});

test("magnetHash refuses a base32 hash rather than returning a wrong one", () => {
  // qBittorrent reports hex, so a base32 value would never match anything. The
  // caller falls back to diffing the torrent list, which always works — a wrong
  // hash would silently attach the flow to someone else's torrent.
  assert.equal(plugin._magnetHash("magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOA"), null);
  assert.equal(plugin._magnetHash("https://example.org/x.torrent"), null);
  assert.equal(plugin._magnetHash(""), null);
});

test("newHashes finds what the add produced", () => {
  const before = { a: true, b: true };
  const after = { a: {}, b: {}, c: {} };
  assert.deepEqual(plugin._newHashes(before, after), ["c"]);
});

test("newHashes reports nothing when nothing appeared", () => {
  assert.deepEqual(plugin._newHashes({ a: true }, { a: {} }), []);
  assert.deepEqual(plugin._newHashes({}, {}), []);
});

test("newHashes treats an absent 'before' as everything being new", () => {
  assert.deepEqual(plugin._newHashes(null, { a: {}, b: {} }).sort(), ["a", "b"]);
});

test("hasMetadata is false while a magnet is still fetching it", () => {
  // metaDL is the window where there is a torrent but no file list to choose
  // from — the whole reason the selection flow has to wait.
  assert.equal(plugin._hasMetadata({ state: "metaDL", size: 0 }), false);
  assert.equal(plugin._hasMetadata({ state: "forcedMetaDL", size: 0 }), false);
});

test("hasMetadata is true once a size is known", () => {
  assert.equal(plugin._hasMetadata({ state: "stoppedDL", size: 12345 }), true);
  assert.equal(plugin._hasMetadata({ state: "pausedDL", total_size: 999 }), true);
});

test("normalizeTorrentName ignores the punctuation indexers disagree on", () => {
  // "Artist - Album [FLAC]" from a tracker vs "Artist-Album-FLAC" in qBittorrent
  // is the same release.
  assert.equal(
    plugin._normalizeTorrentName("Artist - Album [FLAC] (2001)"),
    plugin._normalizeTorrentName("artist.album.flac.2001"),
  );
});

test("findTorrentByName matches an added torrent by its name", () => {
  const map = {
    aaa: { name: "Some Other Thing 2020" },
    bbb: { name: "Artist - Album [FLAC]" },
  };
  assert.equal(plugin._findTorrentByName(map, "Artist.Album.FLAC"), "bbb");
});

test("findTorrentByName refuses an ambiguous match", () => {
  // Two candidates means we cannot tell which torrent the user just added, and
  // attaching a pause-and-wait flow to the wrong one is worse than not attaching.
  const map = {
    a: { name: "Greatest Hits Volume 1" },
    b: { name: "Greatest Hits Volume 2" },
  };
  assert.equal(plugin._findTorrentByName(map, "Greatest Hits Volume"), null);
});

test("findTorrentByName refuses a name too short to be distinctive", () => {
  // A short prefix can match half a library.
  assert.equal(plugin._findTorrentByName({ a: { name: "Live" } }, "Live"), null);
  assert.equal(plugin._findTorrentByName({ a: { name: "x" } }, ""), null);
});

test("findTorrentByName copes with an empty list", () => {
  assert.equal(plugin._findTorrentByName({}, "Artist - Album [FLAC]"), null);
  assert.equal(plugin._findTorrentByName(null, "Artist - Album [FLAC]"), null);
});

test("hasMetadata is false for a torrent that is gone or empty", () => {
  assert.equal(plugin._hasMetadata(null), false);
  assert.equal(plugin._hasMetadata({ state: "stoppedDL", size: 0 }), false);
});
