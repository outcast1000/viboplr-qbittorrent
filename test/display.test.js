const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("formatBytes scales through the units", () => {
  assert.equal(plugin._formatBytes(512), "512 B");
  assert.equal(plugin._formatBytes(1536), "1.5 KB");
  assert.equal(plugin._formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(plugin._formatBytes(1024 * 1024 * 1024 * 2.5), "2.5 GB");
});

test("formatBytes reports unknown sizes as a dash, not as zero", () => {
  assert.equal(plugin._formatBytes(null), "—");
  assert.equal(plugin._formatBytes(undefined), "—");
  assert.equal(plugin._formatBytes(-1), "—");
});

test("formatSpeed shows a dash when nothing is moving", () => {
  // A hard 0 renders as "0 B/s", which reads like a stalled transfer even for a
  // torrent that is simply complete.
  assert.equal(plugin._formatSpeed(0), "—");
  assert.equal(plugin._formatSpeed(2048), "2.0 KB/s");
});

test("formatEta renders qBittorrent's infinity sentinel", () => {
  // 8640000 is what the API sends for "no estimate" — printing it literally
  // would claim a 100-day download.
  assert.equal(plugin._formatEta(8640000), "∞");
  assert.equal(plugin._formatEta(9999999), "∞");
  assert.equal(plugin._formatEta(null), "∞");
});

test("formatEta picks a sensible unit", () => {
  assert.equal(plugin._formatEta(45), "45s");
  assert.equal(plugin._formatEta(300), "5m");
  assert.equal(plugin._formatEta(3900), "1h 5m");
  assert.equal(plugin._formatEta(90000), "1d 1h");
});

test("torrentStateLabel maps both the 4.x and 5.x spellings", () => {
  // qBittorrent 5.0 renamed pausedDL/pausedUP to stoppedDL/stoppedUP; both must
  // read the same in the view.
  assert.equal(plugin._torrentStateLabel("pausedDL"), "Paused");
  assert.equal(plugin._torrentStateLabel("stoppedDL"), "Paused");
  assert.equal(plugin._torrentStateLabel("pausedUP"), "Complete");
  assert.equal(plugin._torrentStateLabel("stoppedUP"), "Complete");
});

test("torrentStateLabel keeps an unknown state visible", () => {
  // A future qBittorrent state should show through rather than be swallowed.
  assert.equal(plugin._torrentStateLabel("somethingNew"), "somethingNew");
  assert.equal(plugin._torrentStateLabel(""), "Unknown");
});

test("isComplete trusts progress as well as state", () => {
  assert.equal(plugin._isComplete({ progress: 1, state: "uploading" }), true);
  assert.equal(plugin._isComplete({ progress: 0.99, state: "downloading" }), false);
  assert.equal(plugin._isComplete({ progress: 0, state: "stoppedUP" }), true);
});

test("isPaused covers both spellings and isErrored covers missing files", () => {
  assert.equal(plugin._isPaused({ state: "pausedDL" }), true);
  assert.equal(plugin._isPaused({ state: "stoppedUP" }), true);
  assert.equal(plugin._isPaused({ state: "downloading" }), false);
  assert.equal(plugin._isErrored({ state: "missingFiles" }), true);
  assert.equal(plugin._isErrored({ state: "error" }), true);
  assert.equal(plugin._isErrored({ state: "downloading" }), false);
});

test("looksLikeTorrentSource accepts magnets and http(s) URLs", () => {
  assert.equal(plugin._looksLikeTorrentSource("magnet:?xt=urn:btih:abc"), true);
  assert.equal(plugin._looksLikeTorrentSource("https://example.com/x.torrent"), true);
  // qBittorrent fetches an http .torrent itself, so any http(s) URL is fair game.
  assert.equal(plugin._looksLikeTorrentSource("http://example.com/download?id=1"), true);
});

test("looksLikeTorrentSource rejects what would only confuse the server", () => {
  assert.equal(plugin._looksLikeTorrentSource(""), false);
  assert.equal(plugin._looksLikeTorrentSource("   "), false);
  assert.equal(plugin._looksLikeTorrentSource("some album name"), false);
  assert.equal(plugin._looksLikeTorrentSource("/home/me/file.torrent"), false);
});

test("magnetDisplayName decodes the display name", () => {
  const uri = "magnet:?xt=urn:btih:abc&dn=Bj%C3%B6rk%20-%20Homogenic&tr=udp://x";
  assert.equal(plugin._magnetDisplayName(uri), "Björk - Homogenic");
});

test("magnetDisplayName handles + as space and survives bad escapes", () => {
  assert.equal(plugin._magnetDisplayName("magnet:?dn=Some+Album&xt=1"), "Some Album");
  // A malformed escape must not throw — it would take an otherwise fine add
  // down with it.
  assert.equal(plugin._magnetDisplayName("magnet:?dn=100%"), "100%");
  assert.equal(plugin._magnetDisplayName("magnet:?xt=urn:btih:abc"), "");
});
