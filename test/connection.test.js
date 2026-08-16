const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("normalizeBaseUrl assumes http for a bare host:port", () => {
  assert.equal(plugin._normalizeBaseUrl("localhost:8080"), "http://localhost:8080");
  assert.equal(plugin._normalizeBaseUrl("192.168.1.5:8080"), "http://192.168.1.5:8080");
});

test("normalizeBaseUrl keeps https and strips a trailing slash", () => {
  assert.equal(plugin._normalizeBaseUrl("https://nas.local:8080/"), "https://nas.local:8080");
  assert.equal(plugin._normalizeBaseUrl("http://host:8080///"), "http://host:8080");
});

test("normalizeBaseUrl drops the WebUI's client-side route", () => {
  // Pasting the address bar is the obvious thing to do, and it carries a hash
  // route that would otherwise end up inside every API URL.
  assert.equal(plugin._normalizeBaseUrl("http://localhost:8080/#/downloads"), "http://localhost:8080");
  assert.equal(plugin._normalizeBaseUrl("http://localhost:8080/?x=1"), "http://localhost:8080");
});

test("normalizeBaseUrl preserves a reverse-proxy subpath", () => {
  // qBittorrent behind nginx at /qbt is a normal deployment; stripping the path
  // would send every request to the proxy root.
  assert.equal(plugin._normalizeBaseUrl("https://home.example.com/qbt/"), "https://home.example.com/qbt");
});

test("normalizeBaseUrl treats blank input as unconfigured", () => {
  assert.equal(plugin._normalizeBaseUrl(""), "");
  assert.equal(plugin._normalizeBaseUrl("   "), "");
  assert.equal(plugin._normalizeBaseUrl(null), "");
});

test("compareVersions orders by numeric segment, not string", () => {
  assert.equal(plugin._compareVersions("2.10", "2.9"), 1);
  assert.equal(plugin._compareVersions("2.11.4", "2.11"), 1);
  assert.equal(plugin._compareVersions("2.8.3", "2.8.3"), 0);
  assert.equal(plugin._compareVersions("2.8", "2.11"), -1);
});

test("supportsStartStop switches at WebAPI 2.11", () => {
  // qBittorrent 5.0 (WebAPI 2.11) renamed pause/resume to stop/start.
  assert.equal(plugin._supportsStartStop("2.11.0"), true);
  assert.equal(plugin._supportsStartStop("2.11"), true);
  assert.equal(plugin._supportsStartStop("2.10.4"), false);
  // Unknown version: assume the older names, which is the safer guess.
  assert.equal(plugin._supportsStartStop(null), false);
  assert.equal(plugin._supportsStartStop(""), false);
});

test("encodeForm escapes values", () => {
  assert.equal(plugin._encodeForm({ username: "a b", password: "p&w=1" }), "username=a%20b&password=p%26w%3D1");
});

test("encodeForm omits absent fields but keeps empty strings", () => {
  // An empty password is a real value (qBittorrent allows one); undefined means
  // "don't send this field at all".
  assert.equal(plugin._encodeForm({ a: "", b: null, c: undefined, d: "1" }), "a=&d=1");
});

test("clampPoll keeps the interval inside the allowed band", () => {
  assert.equal(plugin._clampPoll(500), 2000);
  assert.equal(plugin._clampPoll(120000), 60000);
  assert.equal(plugin._clampPoll(5000), 5000);
  assert.equal(plugin._clampPoll("not a number"), 5000);
});
