const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const manifest = require("../manifest.json");

// The host-drawn header over the view (api.ui.setViewHeader, Viboplr 1.0.77+).
// viewHeaderFor is pure; render.test.js covers the push and the view it frees up.
const plugin = loadPlugin();
const header = plugin._viewHeaderFor;
const CTX = { baseUrl: "http://localhost:8080/", qbtVersion: "v5.2.4", category: "", canOpenUrl: true };
const KINDS = ["ok", "connecting", "unconfigured", "host", "qbt-old", "unreachable", "timeout", "nokey", "apikey", "notfound", "unknown"];

test("the default subtitle is the manifest's", () => {
  assert.equal(manifest.viewHeader.subtitle, plugin._VIEW_HEADER_SUBTITLE);
});

test("connected: version and address, Connected, Refresh + Open Web UI", () => {
  const h = header({ kind: "ok" }, CTX);
  assert.equal(h.subtitle, "qBittorrent v5.2.4 · localhost:8080");
  assert.deepEqual(h.status, { variant: "success", label: "Connected" });
  assert.deepEqual(h.actions, [
    { label: "Refresh", action: "qbt:refresh" },
    { label: "Open Web UI", action: "qbt:open-webui" },
  ]);
});

test("an active category filter is named while connected", () => {
  const h = header({ kind: "ok" }, { ...CTX, category: "music" });
  assert.equal(h.subtitle, "qBittorrent v5.2.4 · localhost:8080 · category “music”");
});

test("not set up: the manifest subtitle, a muted word, no buttons", () => {
  const h = header({ kind: "unconfigured" }, { ...CTX, baseUrl: "" });
  assert.equal(h.subtitle, plugin._VIEW_HEADER_SUBTITLE);
  assert.deepEqual(h.status, { variant: "muted", label: "Not set up" });
  assert.deepEqual(h.actions, []);
});

test("every failure kind is one error word, with the address and Refresh still there", () => {
  for (const kind of ["unreachable", "timeout", "nokey", "apikey", "notfound", "unknown", "qbt-old"]) {
    const h = header({ kind }, { ...CTX, qbtVersion: null });
    assert.equal(h.status.variant, "error", kind);
    assert.equal(h.subtitle, "localhost:8080", kind);
    assert.equal(h.actions[0].action, "qbt:refresh", kind);
  }
  assert.equal(header({ kind: "apikey" }, CTX).status.label, "Key rejected");
  assert.equal(header({ kind: "unreachable" }, CTX).status.label, "Unreachable");
});

test("connecting is muted, not an error", () => {
  assert.deepEqual(header({ kind: "connecting" }, CTX).status, { variant: "muted", label: "Connecting…" });
});

test("an unrecognised kind falls back to Error rather than no status", () => {
  assert.deepEqual(header({ kind: "something-new" }, CTX).status, { variant: "error", label: "Error" });
});

test("no Open Web UI button on a host that can't open URLs", () => {
  const h = header({ kind: "ok" }, { ...CTX, canOpenUrl: false });
  assert.deepEqual(h.actions.map((a) => a.action), ["qbt:refresh"]);
});

test("the address keeps a reverse-proxy subpath but drops the scheme", () => {
  assert.equal(plugin._displayAddress("https://example.com/qbt/"), "example.com/qbt");
});

test("every state fits the host's limits", () => {
  for (const kind of KINDS) {
    const h = header({ kind }, CTX);
    assert.ok(h.subtitle.length <= 160, kind);
    assert.ok(h.status.label.length <= 32, kind);
    assert.ok(h.actions.length <= 2, kind);
    for (const a of h.actions) assert.ok(a.label.length <= 24, kind);
  }
});
