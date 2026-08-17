const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// The tier-3 happy path, end to end, over a scripted qBittorrent: search finds
// one candidate, it is added paused, its files are inspected, ONE file is
// selected and downloaded, and the resolve hands back that file's path. The
// winner stays seeding (the default disposition), so nothing is deleted.

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const HASH = "a".repeat(40);

function textResp(body, status) {
  return {
    status: status || 200,
    text: async () => body,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    },
  };
}
function jsonResp(obj) {
  return { status: 200, text: async () => JSON.stringify(obj), json: async () => obj };
}

test("discovery resolves a track it had to go and find", async () => {
  const state = { added: false, started: false, deletes: [], prios: [], progress: [] };
  let resolveByMetadata = null;

  const torrentRow = () => ({
    name: "Bjork - Homogenic (1997) [FLAC]",
    state: state.started ? "downloading" : "stoppedDL",
    size: 400e6,
    total_size: 400e6,
    progress: state.started ? 1 : 0,
    save_path: "/downloads",
    category: "viboplr",
    added_on: 1700000000,
  });

  const fetchStub = async (url, opts) => {
    const body = (opts && opts.body) || "";
    if (url.includes("/app/webapiVersion")) return textResp("2.11.2");
    if (url.includes("/app/version")) return textResp("v5.2.4");
    if (url.includes("/sync/maindata")) {
      return jsonResp({ rid: 1, full_update: true, torrents: state.added ? { [HASH]: torrentRow() } : {} });
    }
    if (url.includes("/search/plugins")) return jsonResp([{ name: "engine", enabled: true }]);
    if (url.includes("/search/start")) return jsonResp({ id: 7 });
    if (url.includes("/search/results")) {
      return jsonResp({
        status: "Stopped",
        results: [
          {
            fileName: "Bjork - Homogenic (1997) [FLAC]",
            fileUrl: "magnet:?xt=urn:btih:" + HASH,
            fileSize: 400e6,
            nbSeeders: 25,
            nbLeechers: 2,
            engineName: "engine",
            siteUrl: "https://tracker.example",
          },
        ],
      });
    }
    if (url.includes("/search/stop") || url.includes("/search/delete")) return textResp("");
    if (url.includes("/torrents/add")) {
      state.added = true;
      return textResp("Ok.");
    }
    if (url.includes("/torrents/files")) {
      return jsonResp([
        { index: 0, name: "Bjork - Homogenic/01 - Hunter.flac", size: 40e6, progress: state.started ? 1 : 0, priority: 1 },
        { index: 1, name: "Bjork - Homogenic/05 - Joga.flac", size: 40e6, progress: state.started ? 1 : 0, priority: 1 },
        { index: 2, name: "Bjork - Homogenic/cover.jpg", size: 1e6, progress: 0, priority: 1 },
      ]);
    }
    if (url.includes("/torrents/filePrio")) {
      state.prios.push(body);
      return textResp("");
    }
    if (url.includes("/torrents/start") || url.includes("/torrents/resume")) {
      state.started = true;
      return textResp("");
    }
    if (url.includes("/torrents/delete")) {
      state.deletes.push(body);
      return textResp("");
    }
    if (url.includes("/torrents/createCategory")) return textResp("");
    return textResp("", 404);
  };

  const api = {
    appVersion: "1.0.28",
    log: () => {},
    ui: { setViewData: () => {}, showNotification: () => {}, onAction: () => {}, setBadge: () => {} },
    storage: {
      get: async (k) => (k === "settings" ? { baseUrl: "http://127.0.0.1:8080" } : null),
      set: async () => {},
    },
    network: { fetch: fetchStub },
    collections: { getLocalCollections: async () => [], resync: async () => {} },
    playback: { onResolveStreamByUri: () => {}, onStreamResolve: () => {} },
    downloads: {
      onResolveByMetadata: (id, fn) => {
        resolveByMetadata = fn;
      },
      onInteractiveSearch: () => {},
      onInteractiveResolve: () => {},
      reportProgress: (p) => state.progress.push(p && p.percent),
    },
    contextMenu: { onAction: () => {} },
  };

  const g = Object.freeze({});
  const plugin = new Function("api", "window", "globalThis", "self", "document", SOURCE)(undefined, g, g, g, g);
  plugin.activate(api);
  try {
    // Let activation's first refresh land so the plugin knows it is connected.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(resolveByMetadata, "download provider registered");

    const result = await resolveByMetadata("Jóga", "Björk", "Homogenic", null, "flac");

    assert.ok(result, "resolve produced a result");
    assert.ok(result.url.startsWith("file://"), result.url);
    assert.ok(result.url.includes("05 - Joga.flac"), result.url);
    // The commit deselected everything, then selected only the matched file.
    assert.ok(state.prios.some((b) => b.includes("priority=0")), "deselect-all posted: " + state.prios);
    assert.ok(state.prios.some((b) => b.includes("id=1") && b.includes("priority=1")), "single file selected: " + state.prios);
    // Keep-seeding default: the winner was NOT deleted.
    assert.deepEqual(state.deletes, []);
    // Progress flowed and finished at 100.
    assert.ok(state.progress.length > 0, "progress reported");
    assert.equal(state.progress[state.progress.length - 1], 100);
  } finally {
    plugin.deactivate();
  }
});
