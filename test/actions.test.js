const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

// Every action id the UI can emit must have a handler registered on activate.
//
// This exists because deleting a block of handlers is silent: the buttons still
// render, clicking them does nothing at all, and no test or syntax check
// notices. That is exactly what happened once — a range delete took fourteen
// handlers with it, and Play, Files, Start all, Stop all, Import and Discard
// were all dead until a live run tripped over one of them.
function registeredActions() {
  const registered = new Set();
  const api = {
    appVersion: "1.0.27",
    log: () => {},
    ui: {
      setViewData: () => {},
      showNotification: () => {},
      onAction: (id) => registered.add(id),
      setBadge: () => {},
      navigateToView: () => {},
    },
    storage: { get: async () => ({}), set: async () => {} },
    network: { fetch: async () => ({ status: 200, text: async () => "", json: async () => ({}) }), openUrl: async () => {} },
    collections: { getLocalCollections: async () => [], resync: async () => {} },
    playback: { playTracks: () => {}, insertTracks: () => {}, getQueue: () => ({ tracks: [], index: 0 }), onResolveStreamByUri: () => {} },
    contextMenu: { onAction: () => {} },
    scheduler: { register: async () => {}, onDue: () => {} },
  };
  const g = Object.freeze({});
  const plugin = new Function("api", "window", "globalThis", "self", "document", SOURCE)(undefined, g, g, g, g);
  plugin.activate(api);
  return registered;
}

// Both spellings the view nodes use: `action: "qbt:x"` on buttons/inputs, and
// `id: "qbt:x"` inside a row list's `actions` array.
function emittedActions() {
  const out = new Set();
  for (const m of SOURCE.matchAll(/(?:action|id|confirmAction|cancelAction): "(qbt:[^"]+)"/g)) {
    // A trailing "-" is a dynamic prefix ("qbt:webidx-" + def.id) whose full
    // ids are registered per indexer definition at runtime — the static scan
    // can't pair those, and the dedicated web-indexer tests cover them.
    if (m[1].endsWith("-")) continue;
    out.add(m[1]);
  }
  return out;
}

test("every action the UI emits has a handler", () => {
  const registered = registeredActions();
  const missing = [...emittedActions()].filter((a) => !registered.has(a)).sort();
  assert.deepEqual(missing, [], `actions with no handler: ${missing.join(", ")}`);
});

test("the handler set covers the core buttons", () => {
  // A tripwire for the reverse mistake — a refactor that stops registering
  // handlers at all would still pass the check above if the emitters went too.
  const registered = registeredActions();
  for (const id of [
    "qbt:add",
    "qbt:search",
    "qbt:search-add",
    "qbt:search-view",
    "qbt:show-files",
    "qbt:close-files",
    "qbt:play-torrent",
    "qbt:play-file",
    "qbt:enqueue-file",
    "qbt:start",
    "qbt:stop",
    "qbt:start-selected",
    "qbt:discard-peek",
    "qbt:delete-ask",
    "qbt:import",
    "qbt:file-download",
    "qbt:file-skip",
    "qbt:file-filter",
    "qbt:file-filter-clear",
    "qbt:save",
  ]) {
    assert.ok(registered.has(id), `missing handler: ${id}`);
  }
});
