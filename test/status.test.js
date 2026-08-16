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
  assert.match(joined, /5\.2\.4/);
});

test("the plugin no longer tells anyone to enter a username or password", () => {
  // A leftover credentials instruction would send the user hunting for a field
  // that no longer exists.
  const joined = plugin._setupSteps().join(" ");
  assert.doesNotMatch(joined, /username/i);
  assert.doesNotMatch(joined, /password/i);
});
