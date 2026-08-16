const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const classify = plugin._classifyConnectionError;

test("a dead server is 'unreachable'", () => {
  // What plugin_fetch surfaces when the connection never lands. reqwest's
  // Display names no cause, so the generic phrase has to be enough.
  assert.equal(classify("error sending request for url (http://localhost:8080/api/v2/auth/login)"), "unreachable");
  assert.equal(classify("tcp connect error: Connection refused (os error 111)"), "unreachable");
  assert.equal(classify("dns error: failed to lookup address information"), "unreachable");
});

test("a self-signed certificate reads as unreachable, not as an auth problem", () => {
  // The fix text for 'unreachable' is the one that mentions the self-signed
  // toggle, so this must not fall through to 'unknown'.
  assert.equal(classify("invalid peer certificate: UnknownIssuer"), "unreachable");
});

test("a slow server is 'timeout', distinct from unreachable", () => {
  // Different fix: the address resolved, so it's a port or firewall question
  // rather than "is qBittorrent even running".
  assert.equal(classify("operation timed out"), "timeout");
});

test("a refused API key is its own kind", () => {
  // The server is fine and the key is wrong — a different fix from every other
  // failure here.
  assert.equal(classify("qBittorrent rejected the API key"), "apikey");
});

test("no key at all is distinct from a wrong key", () => {
  // "Create a key" and "check the key you pasted" send the user to different
  // places, so they cannot share a message.
  assert.equal(
    classify("qBittorrent needs an API key — this plugin no longer signs in with a username and password"),
    "nokey",
  );
});

test("a 404 means the address is wrong, not the key", () => {
  assert.equal(classify("Reading torrents failed (HTTP 404)"), "notfound");
});

test("the specific messages win over the generic transport patterns", () => {
  // A proxy's error text can carry transport words alongside ours; the plugin's
  // own phrases are matched first on purpose.
  assert.equal(classify("qBittorrent rejected the API key (connection reset)"), "apikey");
});

test("anything unrecognised stays 'unknown' rather than guessing", () => {
  assert.equal(classify("something nobody predicted"), "unknown");
  assert.equal(classify(""), "unknown");
  assert.equal(classify(null), "unknown");
});

test("setupSteps names the qBittorrent screen the user has to open", () => {
  const steps = plugin._setupSteps();
  assert.ok(steps.length >= 4, "expected a real walkthrough");
  const joined = steps.join(" ");
  // The single most useful fact is where the setting lives; if this drifts the
  // instructions stop being actionable.
  assert.match(joined, /Tools → Options → Web UI/);
  assert.match(joined, /8080/);
  assert.match(joined, /Save & connect/);
  // The instructions are now an API-key walkthrough; they must say so, and must
  // name the qBittorrent version that can actually make one.
  assert.match(joined, /API key/i);
  assert.match(joined, /5\.2\.3/);
});

test("the plugin no longer tells anyone to enter a username or password", () => {
  // A leftover credentials instruction would send the user hunting for a field
  // that no longer exists.
  const joined = plugin._setupSteps().join(" ");
  assert.doesNotMatch(joined, /username/i);
  assert.doesNotMatch(joined, /password/i);
});

// --- single list ordering (replaced the Downloading/Completed/All tabs) ---

test("a torrent waiting on the user sorts above everything else", () => {
  // It is the only row that makes no progress until it is touched, so it must
  // not be buried under a screen of active downloads.
  assert.ok(
    plugin._statusRank({ state: "stoppedDL", progress: 0 }, true) <
      plugin._statusRank({ state: "downloading", progress: 0.5 }, false),
  );
});

test("errors outrank anything still moving", () => {
  assert.ok(
    plugin._statusRank({ state: "missingFiles" }, false) <
      plugin._statusRank({ state: "downloading", progress: 0.5 }, false),
  );
});

test("finished torrents sort last, where the Completed tab used to be", () => {
  const done = plugin._statusRank({ state: "stalledUP", progress: 1 }, false);
  for (const t of [
    { state: "downloading", progress: 0.5 },
    { state: "queuedDL", progress: 0 },
    { state: "stalledDL", progress: 0.1 },
    { state: "stoppedDL", progress: 0.2 },
  ]) {
    assert.ok(plugin._statusRank(t, false) < done, JSON.stringify(t));
  }
});

test("active beats stalled beats paused", () => {
  const active = plugin._statusRank({ state: "downloading", progress: 0.5 }, false);
  const stalled = plugin._statusRank({ state: "stalledDL", progress: 0.5 }, false);
  const paused = plugin._statusRank({ state: "stoppedDL", progress: 0.5 }, false);
  assert.ok(active < stalled);
  assert.ok(stalled < paused);
});

test("fetching metadata ranks with the active downloads, not with the stalled", () => {
  // metaDL is qBittorrent working on the torrent; it just has nothing to show
  // for it yet.
  assert.equal(
    plugin._statusRank({ state: "metaDL", progress: 0 }, false),
    plugin._statusRank({ state: "downloading", progress: 0.1 }, false),
  );
});

