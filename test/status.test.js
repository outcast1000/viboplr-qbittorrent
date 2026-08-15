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

test("bad credentials are 'auth'", () => {
  assert.equal(classify("qBittorrent rejected the username or password"), "auth");
});

test("an IP ban is its own kind, not just an auth failure", () => {
  // Fixing the password alone won't clear it — the user has to wait it out, and
  // only this branch says so.
  assert.equal(classify("qBittorrent has temporarily banned this IP after too many failed logins"), "banned");
});

test("a rejected session points at the host version, not the password", () => {
  // The credentials were ACCEPTED here; the cookie is what went missing. Telling
  // the user to check their password would send them somewhere useless.
  assert.equal(classify("qBittorrent kept rejecting the session. Viboplr 1.0.27 or newer is needed"), "session");
  assert.equal(classify("qBittorrent accepted the login but sent no session cookie"), "session");
});

test("a 404 means the address is wrong, not the credentials", () => {
  assert.equal(classify("Reading torrents failed (HTTP 404)"), "notfound");
});

test("the specific messages win over the generic transport patterns", () => {
  // "qBittorrent rejected the session" would match nothing in the transport set,
  // but a proxy's error text can contain both — the plugin's own phrases are
  // checked first on purpose.
  assert.equal(classify("qBittorrent kept rejecting the session (connection reset)"), "session");
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
});
