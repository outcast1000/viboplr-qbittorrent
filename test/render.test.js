const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const { loadPlugin } = require("./harness/sandbox.js");
const plugin_sig = loadPlugin()._fileListSignature;

// End-to-end render smoke test. The pure helpers are covered elsewhere; this
// drives a real activate() → poll → render() and inspects the view data the
// host would actually receive. It exists because the node builders are only
// wired together inside render(), so a wrong node type, a missing action id or
// a list that never gets pushed is invisible to every other test here.
const TORRENTS = {
  aaa: {
    hash: "aaa",
    name: "Some Artist - Album (1998) [FLAC]",
    state: "downloading",
    progress: 0.42,
    size: 500 * 1024 * 1024,
    dlspeed: 2048,
    eta: 300,
    added_on: 200,
    category: "viboplr",
  },
  bbb: {
    hash: "bbb",
    name: "Some.Movie.2021.1080p.BluRay.x265",
    state: "stalledUP",
    progress: 1,
    size: 4 * 1024 * 1024 * 1024,
    ratio: 1.5,
    added_on: 100,
    category: "viboplr",
  },
};

const FILES = [
  { index: 0, name: "01 - First.flac", size: 30 * 1024 * 1024, progress: 1, priority: 1 },
  { index: 1, name: "extras/bonus.mkv", size: 900 * 1024 * 1024, progress: 0, priority: 0 },
];

// The plugin renders TWO surfaces: its sidebar view and the host's Settings →
// qBittorrent panel, both through setViewData with different ids. Keeping them
// apart is load-bearing — a harness that ignored the id read whichever happened
// to be written last, which on the unconfigured screen is the settings panel.
function run(stored, opts) {
  const views = [];
  const settingsViews = [];
  const handlers = {};
  const posts = [];
  const played = [];
  const resolvers = {};
  // A thunk, so a test can change what the server serves mid-run (qBittorrent
  // reports the NEW priorities once they have been posted).
  const filesFor = (opts && opts.files) || (() => FILES);
  // A thunk like `files`, so a test can change what the server reports between
  // polls — the only way to exercise the completion path, since the first poll
  // seeds silently.
  const torrentsRaw = (opts && opts.torrents) || TORRENTS;
  const torrentsFor = () => (typeof torrentsRaw === "function" ? torrentsRaw() : torrentsRaw);
  const api = {
    appVersion: (opts && opts.appVersion) || "1.0.28",
    log: () => {},
    ui: {
      setViewData: (id, data) => (id === "qbittorrent" ? views : settingsViews).push(data),
      showNotification: () => {},
      onAction: (id, fn) => { handlers[id] = fn; },
      setBadge: () => {},
      navigateToView: () => {},
    },
    storage: { get: async () => (stored === undefined ? { baseUrl: "http://localhost:8080", apiKey: "k" } : stored), set: async () => {} },
    network: {
      fetch: async (url, init) => {
        // The plugin urlencodes its form into the body, so decode it back here
        // rather than asserting on a field it never sends.
        if (init && init.method === "POST") {
          const form = {};
          for (const pair of String(init.body || "").split("&")) {
            if (!pair) continue;
            const [k, v] = pair.split("=");
            form[decodeURIComponent(k)] = decodeURIComponent(v || "");
          }
          posts.push({ url, form });
        }
        const body =
          url.includes("/app/webapiVersion") ? "2.11"
            : url.includes("/app/version") ? "v5.2.4"
              : url.includes("/torrents/files") ? JSON.stringify(filesFor())
                : url.includes("/sync/maindata") ? JSON.stringify({ rid: 1, full_update: true, torrents: torrentsFor(), server_state: {} })
                  : "Ok.";
        return { status: 200, ok: true, text: async () => body, json: async () => JSON.parse(body) };
      },
      openUrl: async () => {},
    },
    collections: { getLocalCollections: async () => [], resync: async () => {} },
    playback: {
      playTracks: (tracks, startIndex, context) => played.push({ tracks, startIndex, context }),
      insertTracks: () => {},
      getQueue: () => ({ tracks: [], index: 0 }),
      onResolveStreamByUri: (scheme, handler) => { resolvers[scheme] = handler; },
    },
    contextMenu: { onAction: () => {} },
    scheduler: { register: async () => {}, onDue: () => {} },
  };
  const g = Object.freeze({});
  const plugin = new Function("api", "window", "globalThis", "self", "document", SOURCE)(undefined, g, g, g, g);
  plugin.activate(api);
  return { plugin, views, settingsViews, handlers, api, posts, played, resolvers };
}

// Let the activate-time promise chain (settings read → version probe → poll)
// settle — comfortably more turns than the chain is deep.
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// `buttons` as well as `children`: a toolbar's buttons are not children, and a
// walk that missed them reported the contents panel as having no way back.
function walk(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  for (const btn of node.buttons || []) walk(btn, out);
  return out;
}

const last = (views) => views[views.length - 1];

// The Info tab's rows are two-column layouts (label node + value node), so a
// flat join of text contents can't see a pair. Read them structurally.
function kvRows(nodes) {
  const out = {};
  for (const n of nodes) {
    if (n.className !== "plugin-kv") continue;
    const key = (n.children || []).find((c) => c.className === "plugin-kv-key");
    const val = (n.children || []).find((c) => c.className === "plugin-kv-value");
    if (key) out[key.content] = val ? val.content : "";
  }
  return out;
}

const headings = (nodes) => nodes.filter((n) => n.className === "plugin-heading").map((n) => n.content);

// The poll timer keeps the process alive until deactivate(), so a FAILED
// assertion would otherwise hang the whole run rather than reporting itself.
async function withPlugin(fn, stored, opts) {
  const ctx = run(stored, opts);
  await settle();
  try {
    await fn(ctx);
  } finally {
    ctx.plugin.deactivate();
  }
}

test("the torrents view renders one row list, not a stack of sections", async () => {
  await withPlugin(async ({ views }) => {
    const nodes = walk(last(views));
    const lists = nodes.filter((n) => n.type === "track-row-list");
    assert.equal(lists.length, 1, "expected exactly one torrent row list");
    assert.equal(lists[0].items.length, 2);
    // No per-torrent sections left over from the card layout.
    assert.equal(nodes.filter((n) => n.type === "section").length, 0);
  });
});

test("each torrent row carries name, size, status and a tile", async () => {
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const row = list.items.find((i) => i.id === "aaa");
    assert.equal(row.title, "Some Artist - Album (1998) [FLAC]");
    assert.match(row.subtitle, /^Downloading/);
    assert.match(row.subtitle, /500 MB/);
    assert.equal(row.duration, undefined);
    assert.match(row.imageUrl, /^data:image\/svg\+xml,/);
  });
});

test("the row list offers exactly the four torrent actions", async () => {
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.deepEqual(list.actions.map((a) => a.id), [
      "qbt:play-torrent",
      "qbt:start",
      "qbt:stop",
      "qbt:delete-ask",
    ]);
    // No Contents button — the row itself opens the contents, on a plain click
    // and on double-click, so a third route would only cost tray width.
    assert.ok(!list.actions.some((a) => a.id === "qbt:show-files"));
    assert.equal(list.items[0].action, "qbt:show-files", "the row no longer opens at all");
    assert.equal(list.openOnClick, true);
  });
});

test("opening a torrent's contents replaces the list", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:show-files"]({ selectedIds: ["aaa"], itemId: "aaa" });
    await settle();
    const nodes = walk(last(views));
    // The list's own furniture is gone: no add box and no start-all/stop-all,
    // which would be ambiguous about what they act on. (The panel has a
    // stats-grid of its own — the torrent's facts, not the server's.)
    // By action, not by node type — the panel has a search-input of its own now
    // (the file filter), so counting them would pass for the wrong reason.
    assert.ok(!nodes.some((n) => n.action === "qbt:add"), "the list's add box is still here");
    assert.ok(!nodes.some((n) => n.action === "qbt:start-all"), "the list's Start all is still here");
    assert.ok(nodes.some((n) => n.type === "detail-header"), "no hero");
    // The hero carries Back as `backAction` — the host's own control, in the
    // same place as on every Artist/Album/Track page — not a button labelled
    // "← Back" that only looks like one.
    const back = nodes.find((n) => n.action === "qbt:close-files" || n.backAction === "qbt:close-files");
    assert.ok(back, "no way back to the list");
    // And the file rows are there, one per file.
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.equal(list.items.length, FILES.length);
  });
});

test("a file row states whether it is selected for download", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const skipped = list.items.find((i) => i.id === "1");
    const kept = list.items.find((i) => i.id === "0");
    assert.match(skipped.subtitle, /Not selected/);
    assert.match(kept.subtitle, /Downloaded/);
    // A deselected file must not be playable or draggable into the queue.
    assert.equal(skipped.path, null);
  });
});

test("Back returns to the list", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    const nodes = walk(last(views));
    assert.ok(nodes.some((n) => n.action === "qbt:add"), "the add box didn't come back");
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.equal(list.items.length, 2, "expected the torrent list back");
  });
});

test("removing a multi-row selection confirms once, by count", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:delete-ask"]({ selectedIds: ["aaa", "bbb"] });
    await settle();
    const confirm = walk(last(views)).find((n) => n.type === "confirm");
    assert.ok(confirm, "no confirm rendered");
    assert.match(confirm.message, /2 torrents/);
    // Cancel must be the harmless side — the host fires it on Escape too.
    assert.equal(confirm.cancelAction, "qbt:delete-cancel");
    handlers["qbt:delete-cancel"]();
  });
});

test("the tab strip is Torrents / Search / Debug / Settings", async () => {
  await withPlugin(async ({ views }) => {
    const tabs = walk(last(views)).find((n) => n.type === "tabs");
    assert.deepEqual(tabs.tabs.map((t) => t.id), ["torrents", "search", "debug", "settings"]);
    assert.equal(tabs.tabs[0].count, 2);
  });
});

test("web indexers: export fills the box, and a pasted array imports", async () => {
  await withPlugin(async ({ handlers, settingsViews }) => {
    // Settings-row controls hang off `.control`, which the shared walk() skips.
    const deep = (node, out = []) => {
      if (!node || typeof node !== "object") return out;
      out.push(node);
      for (const child of node.children || []) deep(child, out);
      for (const btn of node.buttons || []) deep(btn, out);
      if (node.control) deep(node.control, out);
      return out;
    };
    const draftValue = () => {
      const inputs = deep(last(settingsViews)).filter((n) => n.type === "text-input" && n.action === "qbt:web-draft");
      return inputs.length ? inputs[inputs.length - 1].value : null;
    };
    const settingsText = () =>
      deep(last(settingsViews))
        .filter((n) => n.type === "settings-row")
        .map((n) => n.label + " " + (n.description || ""))
        .join("\n");

    // Export all → the box holds a JSON array of every bundled indexer.
    handlers["qbt:web-export"]({});
    const exported = JSON.parse(draftValue());
    assert.ok(Array.isArray(exported));
    assert.ok(exported.some((d) => d.id === "tpb"));

    // View one → the box holds just that definition.
    handlers["qbt:webview-nyaa"]({});
    assert.equal(JSON.parse(draftValue()).id, "nyaa");

    // Import an array of two custom indexers in one go.
    const mine = [
      { id: "mysite", name: "My Site", siteUrl: "https://mysite.example", type: "rss", search: { url: "https://mysite.example/rss?q={q}" }, rows: { tag: "item" }, fields: { fileName: { tag: "title" }, fileUrl: { tag: "link" } } },
      { id: "other", name: "Other", siteUrl: "https://other.example", type: "json", search: { url: "https://other.example/api?q={q}" }, rows: { path: "" }, fields: { fileName: { path: "name" }, fileUrl: { magnet: { infoHash: { path: "h" } } } } },
    ];
    handlers["qbt:web-draft"]({ value: JSON.stringify(mine) });
    handlers["qbt:web-add"]({});
    const afterImport = settingsText();
    assert.ok(afterImport.includes("Search My Site"), afterImport);
    assert.ok(afterImport.includes("Search Other"), afterImport);
    // The box is cleared on a successful add.
    assert.equal(draftValue(), "");

    const countRows = (prefix) => settingsText().split("\n").filter((l) => l.indexOf(prefix) === 0).length;
    assert.equal(countRows("Search My Site"), 1);

    // Re-importing an EXISTING custom id REPLACES it (edit-via-View-JSON), it
    // does not add a second row.
    handlers["qbt:web-draft"]({ value: JSON.stringify(Object.assign({}, mine[0], { name: "My Site Renamed" })) });
    handlers["qbt:web-add"]({});
    // Still exactly one "My Site …" row, now the renamed one.
    assert.equal(countRows("Search My Site"), 1);
    assert.ok(settingsText().includes("Search My Site Renamed"));
    assert.equal(draftValue(), "");
  });
});

test("the debug tab runs the real stream resolver and narrates each step", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:tab"]({ tabId: "debug" });
    let nodes = walk(last(views));
    // The workbench: three fields, two run buttons, a clear button.
    for (const action of ["qbt:debug-title", "qbt:debug-artist", "qbt:debug-album"]) {
      assert.ok(nodes.some((n) => n.type === "text-input" && n.action === action), "missing input " + action);
    }
    for (const action of ["qbt:debug-stream", "qbt:debug-stream-fetch", "qbt:debug-download", "qbt:debug-clear"]) {
      assert.ok(nodes.some((n) => n.action === action), "missing button " + action);
    }
    // A miss narrates the decline instead of failing silently.
    handlers["qbt:debug-title"]({ value: "No Such Song" });
    handlers["qbt:debug-artist"]({ value: "Nobody" });
    handlers["qbt:debug-stream"]({});
    await settle();
    const texts = walk(last(views))
      .filter((n) => n.type === "text")
      .map((n) => n.content)
      .join("\n");
    assert.ok(texts.includes("STREAM resolve"), texts);
    // Each lookup names its target and what it asked — the cache line carries
    // the NORMALIZED needles the matcher actually used.
    assert.ok(texts.includes("[local cache] matching title “no such song” + artist “nobody”"), texts);
    assert.ok(texts.includes("no match"), texts);
    assert.ok(texts.includes("DECLINED"), texts);
    // Clearing empties the log.
    handlers["qbt:debug-clear"]({});
    const after = walk(last(views)).filter((n) => n.type === "text").map((n) => n.content).join("\n");
    assert.ok(!after.includes("STREAM resolve"), after);
  });
});

test("fetch & play runs discovery on a cache miss; the instant entry never does", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:tab"]({ tabId: "debug" });
    handlers["qbt:debug-title"]({ value: "No Such Song" });
    handlers["qbt:debug-artist"]({ value: "Nobody" });
    // The instant entry declines flat on a miss…
    handlers["qbt:debug-stream"]({});
    await settle();
    let texts = walk(last(views)).filter((n) => n.type === "text").map((n) => n.content).join("\n");
    assert.ok(texts.includes("stream: [local cache] no match — decline"), texts);
    assert.ok(!texts.includes("discovery"), texts);
    // …while fetch & play goes searching (the harness has no search plugins,
    // so the race settles immediately on "found nothing").
    handlers["qbt:debug-clear"]({});
    handlers["qbt:debug-stream-fetch"]({});
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    texts = walk(last(views)).filter((n) => n.type === "text").map((n) => n.content).join("\n");
    assert.ok(texts.includes("starting discovery, racing it against the 50s budget"), texts);
    assert.ok(texts.includes("discovery found nothing — decline"), texts);
  });
});

test("the downloaded-only stream resolver serves a finished file as qbt://", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:tab"]({ tabId: "debug" });
    // "01 - First.flac" is complete in torrent aaa, whose name carries the
    // artist — a clean tier-1 hit end to end through the debug runner.
    handlers["qbt:debug-title"]({ value: "First" });
    handlers["qbt:debug-artist"]({ value: "Some Artist" });
    handlers["qbt:debug-stream"]({});
    // The resolve re-fetches the torrent's file list; give the chain a moment.
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    const texts = walk(last(views)).filter((n) => n.type === "text").map((n) => n.content).join("\n");
    assert.ok(texts.includes("RESULT: qbt://aaa/0"), texts);
  });
});

test("fetch & play waits out the download and then answers", async () => {
  // The file starts incomplete and DESELECTED; the server flips it to done
  // once the plugin has posted the start — exactly the select-start-wait walk.
  const holder = { posts: null };
  const files = () => {
    const started = !!(holder.posts && holder.posts.some((p) => p.url.includes("/torrents/start") || p.url.includes("/torrents/resume")));
    return [{ index: 0, name: "01 - First.flac", size: 30 * 1024 * 1024, progress: started ? 1 : 0.2, priority: 0 }];
  };
  const torrents = {
    aaa: {
      hash: "aaa",
      name: "Some Artist - Album (1998) [FLAC]",
      state: "stoppedDL",
      progress: 0.2,
      size: 500 * 1024 * 1024,
      added_on: 200,
      category: "viboplr",
    },
  };
  await withPlugin(
    async (ctx) => {
      holder.posts = ctx.posts;
      ctx.handlers["qbt:tab"]({ tabId: "debug" });
      ctx.handlers["qbt:debug-title"]({ value: "First" });
      ctx.handlers["qbt:debug-artist"]({ value: "Some Artist" });
      ctx.handlers["qbt:debug-stream-fetch"]({});
      await new Promise((r) => setTimeout(r, 100));
      await settle();
      const texts = walk(last(ctx.views)).filter((n) => n.type === "text").map((n) => n.content).join("\n");
      assert.ok(texts.includes("starting it and waiting"), texts);
      assert.ok(texts.includes("RESULT: qbt://aaa/0"), texts);
      // It selected the deselected file and started the paused torrent.
      assert.ok(ctx.posts.some((p) => p.url.includes("/torrents/filePrio") && p.form.priority === "1"), "file selected");
      assert.ok(ctx.posts.some((p) => p.url.includes("/torrents/start") || p.url.includes("/torrents/resume")), "torrent started");
    },
    undefined,
    { files, torrents }
  );
});

// --- the unconfigured setup screen -------------------------------------------

test("an unconfigured plugin shows the setup steps and an Open settings button", async () => {
  await withPlugin(async ({ views }) => {
    const nodes = walk(last(views));
    assert.ok(nodes.some((n) => n.type === "section" && /Setting up/.test(n.title)), "no setup guide");
    assert.ok(nodes.some((n) => n.action === "qbt:open-settings"), "no Open settings button");
  }, {});
});

test("Open settings actually opens the settings", async () => {
  // The regression this guards: the unconfigured branch of render() returns
  // before the tab strip and the settings branch are ever reached, so setting
  // activeTab and re-rendering drew the SAME screen — a button whose only
  // effect was to render itself again.
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:open-settings"]();
    await settle();
    const nodes = walk(last(views));
    assert.ok(
      nodes.some((n) => n.type === "text-input" || n.type === "settings-row"),
      "settings never rendered — still on the setup screen",
    );
    assert.ok(!nodes.some((n) => n.action === "qbt:open-settings"), "still showing the setup screen's own button");
  }, {});
});

test("the unconfigured settings screen has a way back", async () => {
  // There is no tab strip on this screen, so without this the user is stranded
  // in a form with no explanation of what its fields want.
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:open-settings"]();
    await settle();
    assert.ok(walk(last(views)).some((n) => n.action === "qbt:close-settings"), "no way back");
    handlers["qbt:close-settings"]();
    await settle();
    assert.ok(
      walk(last(views)).some((n) => n.type === "section" && /Setting up/.test(n.title)),
      "Back didn't return to the setup steps",
    );
  }, {});
});

// --- "View contents" arms the torrent ----------------------------------------
//
// A peek adds the torrent paused; once the file list arrives it is STARTED with
// every file set to skip, so including a file downloads it on the spot instead
// of selecting it and waiting for a second Start press.

const ALL_WANTED = [
  { index: 0, name: "01 - First.flac", size: 10 * 1024 * 1024, progress: 0, priority: 1 },
  { index: 1, name: "extras/bonus.mkv", size: 900 * 1024 * 1024, progress: 0, priority: 1 },
];
const NONE_WANTED = ALL_WANTED.map((f) => ({ ...f, priority: 0 }));

// What qBittorrent ACTUALLY reports for a torrent with every file deselected:
// nothing is wanted, so nothing is missing, so it is 100% complete and seeding.
// Not a byte of it exists on disk. Every "is this finished?" reader has to
// survive this shape, and a fixture that reported 42% would never prove it.
const PARKED = {
  aaa: {
    hash: "aaa",
    name: "Some Artist - Album (1998) [FLAC]",
    state: "stalledUP",
    progress: 1,
    size: 0,
    total_size: 910 * 1024 * 1024,
    ratio: 0,
    added_on: 200,
    category: "viboplr",
  },
};

test("arming deselects every file BEFORE starting the torrent", async () => {
  // The whole safety of the feature is this order. Starting a torrent whose
  // files are still at their default priority downloads the entire release —
  // which is precisely what "View contents" must never do.
  let served = ALL_WANTED;
  await withPlugin(async ({ plugin, posts, handlers, api }) => {
    // Serve the deselected list once the priorities have been posted, the way a
    // real qBittorrent would.
    const realFetch = api.network.fetch;
    api.network.fetch = async (url, init) => {
      if (init && init.method === "POST" && url.includes("filePrio")) served = NONE_WANTED;
      return realFetch(url, init);
    };
    // armPeek works off the cached file list, so fill it the way the real flow
    // does. Without this it bails on an empty list and asserts nothing.
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    posts.length = 0;
    const armed = await plugin._armPeek("aaa");
    assert.equal(armed, true, "arming reported failure");
    const prio = posts.findIndex((p) => p.url.includes("/torrents/filePrio") && String(p.form.priority) === "0");
    const start = posts.findIndex((p) => /\/torrents\/(start|resume)/.test(p.url));
    assert.ok(prio >= 0, "never deselected the files:\n" + posts.map((p) => p.url).join("\n"));
    assert.ok(start >= 0, "never started the torrent:\n" + posts.map((p) => p.url).join("\n"));
    assert.ok(prio < start, "started BEFORE deselecting — that downloads the whole release");
    // And it deselected everything, not just some of it.
    assert.deepEqual(String(posts[prio].form.id).split("|").sort(), ["0", "1"]);
  }, undefined, { files: () => served });
});

test("arming refuses to start if qBittorrent kept a file selected", async () => {
  // Verified rather than assumed: qBittorrent silently keeps a completed
  // file's priority, and starting a torrent that still wants something would
  // download it behind the user's back.
  await withPlugin(async ({ plugin, posts, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    posts.length = 0;
    const armed = await plugin._armPeek("aaa");
    assert.equal(armed, false, "claimed to be armed while a file was still wanted");
    assert.ok(
      !posts.some((p) => /\/torrents\/(start|resume)/.test(p.url)),
      "started a torrent that still wanted files",
    );
  }, undefined, { files: () => ALL_WANTED });
});

// --- how the state reads -----------------------------------------------------

test("a torrent with nothing selected is never shown as finished", async () => {
  // qBittorrent reports it 100% complete — nothing is wanted, so nothing is
  // missing — having downloaded none of it.
  await withPlugin(async ({ plugin, handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" }); // populates the file cache
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    const row = walk(last(views)).find((n) => n.type === "track-row-list").items.find((i) => i.id === "aaa");
    assert.match(row.subtitle, /^Choose files to start/);
    // Not the green "done" band, and not a full bar.
    assert.match(decodeURIComponent(row.imageUrl), />0%</);
  }, undefined, { files: () => NONE_WANTED });
});

test("the contents panel of an unchosen torrent leads with what to do", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const nodes = walk(last(views));
    const says = (n) =>
      [n.content, n.status, n.subtitle, n.title].some((v) => typeof v === "string" && /Choose files to start|include the ones you want/i.test(v));
    assert.ok(nodes.some(says), "the panel never says what to do");
    // The progress bar must not read 100% over an empty download.
    const bar = nodes.find((n) => n.type === "progress-bar");
    assert.equal(bar.value, 0);
  }, undefined, { files: () => NONE_WANTED });
});

test("a parked torrent shows 0% and its real size, not 100% of nothing", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    const row = walk(last(views)).find((n) => n.type === "track-row-list").items[0];
    assert.match(decodeURIComponent(row.imageUrl), />0%</);
    assert.match(row.subtitle, /^Choose files to start/);
    // `size` is the WANTED size and reads 0 B while nothing is selected; the
    // row has to show what the torrent actually weighs.
    assert.match(row.subtitle, /910 MB/);
    // No seeding facts on a torrent that has never downloaded anything.
    assert.ok(!/ratio/.test(row.subtitle), row.subtitle);
  }, undefined, { files: () => NONE_WANTED, torrents: PARKED });
});

test("a parked torrent is never announced as a finished download", async () => {
  // qBittorrent reports a torrent with nothing selected as 100% complete and
  // seeding. Without the guard this toasts "Finished downloading: …" and
  // rescans the library for an empty folder.
  //
  // It has to become parked BETWEEN polls: the first poll seeds knownComplete
  // silently, so a torrent already "complete" when the plugin starts can never
  // be announced either way and the test would prove nothing.
  const seen = [];
  let serving = TORRENTS;
  await withPlugin(async ({ handlers, api }) => {
    api.ui.showNotification = (m) => seen.push(m);
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    // Every file is now deselected, so qBittorrent starts calling it complete.
    serving = PARKED;
    handlers["qbt:refresh"]();
    await settle();
    await settle();
    assert.ok(!seen.some((m) => /Finished downloading/.test(m)), "announced: " + seen.join(" | "));
  }, undefined, { files: () => NONE_WANTED, torrents: () => serving });
});

test("isFinished asks the files, not how we got here", async () => {
  // The guard every "is this done?" reader goes through. Pinned directly now
  // that the Active / Finished stats which used to observe it are gone.
  await withPlugin(async ({ plugin, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    // qBittorrent says 100% and seeding; not a byte of it exists.
    assert.equal(plugin._isFinished(PARKED.aaa), false);
    // A genuinely finished torrent is unaffected.
    assert.equal(plugin._isFinished({ hash: "other", state: "stalledUP", progress: 1 }), true);
  }, undefined, { files: () => NONE_WANTED, torrents: PARKED });
});
test("including a file in a parked torrent starts it downloading straight away", async () => {
  // The point of arming: picking a file IS the decision, so there is no second
  // "Start download" press between the user and the thing they just chose.
  let served = NONE_WANTED;
  await withPlugin(async ({ plugin, posts, handlers, api }) => {
    const realFetch = api.network.fetch;
    api.network.fetch = async (url, init) => {
      if (init && init.method === "POST" && url.includes("filePrio")) {
        served = /priority=1/.test(String(init.body || "")) ? ALL_WANTED : NONE_WANTED;
      }
      return realFetch(url, init);
    };
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    assert.equal(await plugin._armPeek("aaa"), true, "could not arm");
    posts.length = 0;

    handlers["qbt:file-download"]({ selectedIds: ["0"] });
    await settle();
    await settle();

    const include = posts.findIndex((p) => p.url.includes("filePrio") && String(p.form.priority) === "1");
    const start = posts.findIndex((p) => /\/torrents\/(start|resume)/.test(p.url));
    assert.ok(include >= 0, "never included the file:\n" + posts.map((p) => p.url).join("\n"));
    assert.ok(start >= 0, "selected the file but never started the download:\n" + posts.map((p) => p.url).join("\n"));
    assert.ok(include < start, "started before including the file");
  }, undefined, { files: () => served, torrents: PARKED });
});

test("skipping a file does not start the download", async () => {
  // Deselecting is not a decision to download anything, so it must not end the
  // hold — otherwise trimming one unwanted file commits you to all the rest.
  await withPlugin(async ({ plugin, posts, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    await plugin._armPeek("aaa");
    posts.length = 0;

    handlers["qbt:file-skip"]({ selectedIds: ["1"] });
    await settle();
    await settle();

    assert.ok(
      !posts.some((p) => /\/torrents\/(start|resume)/.test(p.url)),
      "skipping a file started the download:\n" + posts.map((p) => p.url).join("\n"),
    );
  }, undefined, { files: () => NONE_WANTED, torrents: PARKED });
});

test("a file list with string priorities still renders deselected files as such", async () => {
  // The defect this guards, end to end through fetchFiles: qBittorrent (via a
  // proxy, or on an older build) can send `priority` as the string "0". The
  // old `typeof === "number"` check rejected that and fell through to the
  // default of 1, so a file the user had deselected rendered as
  // "Downloading 0%" — a claim about a file that would never move.
  const STRINGY = [
    { index: "0", name: "01 - First.flac", size: "10485760", progress: "0", priority: "0" },
    { index: "1", name: "extras/bonus.mkv", size: "943718400", progress: "0", priority: "1" },
  ];
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const deselected = list.items.find((i) => i.id === "0");
    assert.ok(deselected, "the string index was dropped: " + JSON.stringify(list.items.map((i) => i.id)));
    assert.match(deselected.subtitle, /^Not selected for download/);
    assert.match(decodeURIComponent(deselected.imageUrl), />skip</);
    // The size came through as a string too and must not read as "—". It sits
    // on the detail line now, not in a trailing column.
    assert.match(deselected.subtitle, /10 MB/);
    assert.equal(deselected.duration, undefined);
  }, undefined, { files: () => STRINGY });
});

test("a stopped torrent's selected files do not claim to be downloading", async () => {
  const STOPPED = {
    aaa: { hash: "aaa", name: "Album [FLAC]", state: "stoppedDL", progress: 0.4, size: 100, total_size: 100, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    for (const item of list.items) {
      assert.ok(!/^Downloading/.test(item.subtitle), item.title + " → " + item.subtitle);
    }
  }, undefined, { files: () => ALL_WANTED, torrents: STOPPED });
});

// --- the contents panel as a detail page -------------------------------------

const MIXED = [
  { index: 0, name: "01 - First.flac", size: 10 * 1024 * 1024, progress: 0, priority: 1 },
  { index: 1, name: "02 - Second.flac", size: 12 * 1024 * 1024, progress: 0, priority: 1 },
  { index: 2, name: "extras/Making Of.mkv", size: 900 * 1024 * 1024, progress: 0, priority: 1 },
  { index: 3, name: "cover.jpg", size: 400 * 1024, progress: 0, priority: 1 },
];

async function openContents(fn, opts) {
  await withPlugin(async (ctx) => {
    ctx.handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    await fn(ctx, walk(last(ctx.views)));
  }, undefined, opts);
}

test("the panel leads with a hero carrying the name and Back", async () => {
  await openContents(async (_ctx, nodes) => {
    const hero = nodes.find((n) => n.type === "detail-header");
    assert.ok(hero, "no hero");
    assert.equal(hero.title, "Some Artist - Album (1998) [FLAC]");
    assert.equal(hero.backAction, "qbt:close-files");
    assert.match(hero.subtitle, /Downloading/);
  }, { files: () => MIXED });
});

test("the Info tab carries the torrent's facts as plain text", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:detail-tab"]({ tabId: "info" });
    await settle();
    const nodes = walk(last(views));
    const kv = kvRows(nodes);
    for (const wanted of [
      "Status", "Progress", "Size", "Downloaded", "Uploaded", "Ratio", "Active for", "Added",
      "Seeds", "Leechers", "Availability", "Trackers", "Last full copy seen", "Last activity", "Hash",
    ]) {
      assert.ok(wanted in kv, "missing " + wanted + " — has " + Object.keys(kv).join(", "));
    }
    // Headings are marked as headings, not left looking like another row.
    assert.deepEqual(headings(nodes), ["Transfer", "Swarm", "Files and location"]);
    // Plain text — no stat tiles, no card wrappers.
    assert.equal(nodes.filter((n) => n.type === "stats-grid").length, 0);
    assert.equal(nodes.filter((n) => n.type === "section").length, 0);
    // Server-wide figures belong to the list, not to one torrent.
    assert.ok(!("Free space" in kv), Object.keys(kv).join(", "));
  }, undefined, { files: () => MIXED });
});

test("the Info tab spells the swarm out", async () => {
  // The row's compact "12/40" is for scanning; this tab has the width and is
  // where someone comes to find out what the numbers mean.
  const SWARMY = {
    aaa: {
      hash: "aaa", name: "Album [FLAC]", state: "downloading", progress: 0.42,
      total_size: 100, added_on: 1, category: "viboplr",
      num_seeds: 12, num_complete: 40, num_leechs: 3, num_incomplete: 9,
    },
  };
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:detail-tab"]({ tabId: "info" });
    await settle();
    const kv = kvRows(walk(last(views)));
    assert.match(kv.Seeds, /^12 connected/);
    assert.match(kv.Seeds, /40 in the swarm/);
    assert.match(kv.Leechers, /^3 connected/);
  }, undefined, { files: () => MIXED, torrents: SWARMY });
});
test("speeds and a time-left are hidden on a torrent that isn't moving", async () => {
  // A column of dashes is noise on a finished torrent and reads like a fault on
  // a stopped one.
  const STOPPED = {
    aaa: { hash: "aaa", name: "Album [FLAC]", state: "stoppedDL", progress: 0.4, size: 100, total_size: 100, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:detail-tab"]({ tabId: "info" });
    await settle();
    const kv = kvRows(walk(last(views)));
    assert.ok("Downloaded" in kv, Object.keys(kv).join(", "));
    assert.ok(!("Time left" in kv), Object.keys(kv).join(", "));
    assert.ok(!("Download speed" in kv), Object.keys(kv).join(", "));
    // Nor an upload speed — a stopped torrent isn't seeding either.
    assert.ok(!("Upload speed" in kv), Object.keys(kv).join(", "));
  }, undefined, { files: () => MIXED, torrents: STOPPED });
});
test("a torrent list row opens on a plain click", async () => {
  // The host only fires a row's `action` on click when the list opts in; this
  // pins the opt-in being sent, since without it a click merely selects.
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.equal(list.openOnClick, true);
    assert.equal(list.items[0].action, "qbt:show-files");
  });
});

// --- filtering the contents --------------------------------------------------

test("the contents panel offers a live filter box", async () => {
  await openContents(async (_ctx, nodes) => {
    const box = nodes.find((n) => n.type === "search-input" && n.action === "qbt:file-filter");
    assert.ok(box, "no filter box");
    // No buttonLabel and no submitOnly, or the host would only fire on Enter
    // and the list would not narrow as you type.
    assert.ok(!box.buttonLabel, "a button label makes the input submit-only");
    assert.ok(!box.submitOnly);
    // Per-torrent text memory, matching the plugin's own per-hash filter state.
    assert.equal(box.stateKey, "qbt-files:aaa");
  }, { files: () => MIXED });
});

test("typing narrows the file list", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    assert.equal(walk(last(views)).find((n) => n.type === "track-row-list").items.length, 4);

    handlers["qbt:file-filter"]({ query: "flac" });
    await settle();
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.deepEqual(list.items.map((i) => i.id), ["0", "1"]);
  }, undefined, { files: () => MIXED });
});

test("a filter with no matches offers a way out", async () => {
  // An empty list with no explanation reads as "this torrent has no files".
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:file-filter"]({ query: "zzzz" });
    await settle();
    const nodes = walk(last(views));
    assert.ok(nodes.some((n) => typeof n.content === "string" && /Nothing matches/.test(n.content)));
    assert.ok(nodes.some((n) => n.action === "qbt:file-filter-clear"), "no way to clear it");

    handlers["qbt:file-filter-clear"]({ hash: "aaa" });
    await settle();
    assert.equal(walk(last(views)).find((n) => n.type === "track-row-list").items.length, 4);
  }, undefined, { files: () => MIXED });
});

test("each torrent keeps its own filter", async () => {
  // A single shared string would show one torrent's filter text over another
  // torrent's file list the moment you opened a second one.
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:file-filter"]({ query: "flac" });
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    handlers["qbt:show-files"]({ itemId: "bbb" });
    await settle();
    const box = walk(last(views)).find((n) => n.type === "search-input" && n.action === "qbt:file-filter");
    assert.equal(box.value, "", "the other torrent's filter leaked across");
    assert.equal(box.stateKey, "qbt-files:bbb");
  }, undefined, { files: () => MIXED });
});

// --- selection presets on the file list --------------------------------------

test("the file list offers Audio and Video as selection presets", async () => {
  // Presets sit with the host list's All / None because that is what they are:
  // they SELECT rows. The declared actions are what act on a selection — which
  // is why there is no second Download toolbar duplicating the idea.
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.deepEqual(list.selectionPresets.map((p) => p.label), ["Audio", "Video"]);
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "audio").ids, ["0", "1"]);
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "video").ids, ["2"]);
  }, { files: () => MIXED });
});

test("a preset with nothing of its kind is empty, so the host disables it", async () => {
  const ALL_AUDIO = [
    { index: 0, name: "a.flac", size: 10, progress: 0, priority: 1 },
    { index: 1, name: "b.flac", size: 10, progress: 0, priority: 1 },
  ];
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "video").ids, []);
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "audio").ids, ["0", "1"]);
  }, { files: () => ALL_AUDIO });
});

test("presets follow the filter, so they can't select a hidden row", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:file-filter"]({ query: "flac" });
    await settle();
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.deepEqual(list.items.map((i) => i.id), ["0", "1"]);
    // The .mkv is filtered out, so Video has nothing to offer.
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "video").ids, []);
    assert.deepEqual(list.selectionPresets.find((p) => p.id === "audio").ids, ["0", "1"]);
  }, undefined, { files: () => MIXED });
});

test("the file actions read as verbs that suit a selection", async () => {
  // They apply to the whole selection from the list's toolbar, where
  // "Don't download this file" was wrong on both counts.
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    const byId = Object.fromEntries(list.actions.map((a) => [a.id, a.label]));
    assert.equal(byId["qbt:file-download"], "Download");
    assert.equal(byId["qbt:file-skip"], "Skip");
  }, { files: () => MIXED });
});

test("there is no second Download toolbar", async () => {
  await openContents(async (_ctx, nodes) => {
    assert.ok(!nodes.some((n) => n.type === "toolbar" && n.title === "Download"));
  }, { files: () => MIXED });
});

test("an empty file list never renders as \"0 files\"", async () => {
  // A torrent with no files does not exist; an empty answer means qBittorrent
  // isn't ready to describe it yet. The row omits the count rather than stating
  // something that cannot be true.
  await withPlugin(async ({ views }) => {
    const row = walk(last(views)).find((n) => n.type === "track-row-list").items[0];
    assert.ok(!/\bfiles?\b/.test(row.subtitle), row.subtitle);
  }, undefined, { files: () => [] });
});

test("the panel's hero is plain — title and Back, no artwork", async () => {
  // A torrent has no image of its own, so the full hero was a 320px scrimmed
  // panel wrapped around a placeholder disc. The Back button is the reason to
  // keep the hero at all: it's the one every detail page in the app uses.
  await openContents(async (_ctx, nodes) => {
    const hero = nodes.find((n) => n.type === "detail-header");
    assert.equal(hero.plain, true);
    assert.equal(hero.backAction, "qbt:close-files");
    assert.equal(hero.imageUrl, undefined, "still sending artwork");
    assert.equal(hero.playAction, undefined, "Play is on the file rows now");
    assert.equal(hero.actions, undefined, "no overflow menu");
  }, { files: () => MIXED });
});

test("the torrent's own actions live in the hero, where Play/Enqueue would", async () => {
  // Those two verbs don't fit a torrent — you start and stop it — so these
  // replace the pair rather than sitting in a second bar underneath.
  await openContents(async (_ctx, nodes) => {
    const hero = nodes.find((n) => n.type === "detail-header");
    assert.deepEqual(hero.buttons.map((b) => b.id), ["qbt:stop", "qbt:delete-ask"]);
    assert.equal(hero.playAction, undefined);
    assert.equal(hero.enqueueAction, undefined);
    // And nothing left behind underneath it.
    assert.ok(!nodes.some((n) => n.type === "toolbar"), "a toolbar is still rendered");
  }, { files: () => MIXED });
});

test("a stopped torrent leads with Start", async () => {
  const STOPPED = {
    aaa: { hash: "aaa", name: "x", state: "stoppedDL", progress: 0.4, total_size: 100, added_on: 1, category: "viboplr" },
  };
  await openContents(async (_ctx, nodes) => {
    const hero = nodes.find((n) => n.type === "detail-header");
    assert.equal(hero.buttons[0].id, "qbt:start");
    assert.equal(hero.buttons[0].label, "Start");
    // The thing to do next should look like it.
    assert.equal(hero.buttons[0].variant, "primary");
  }, { files: () => MIXED, torrents: STOPPED });
});

test("the panel splits into Files and Info, Files first", async () => {
  await openContents(async (_ctx, nodes) => {
    // Two tab strips on screen: the view's own, then the panel's.
    const strips = nodes.filter((n) => n.type === "tabs");
    const panel = strips[strips.length - 1];
    assert.deepEqual(panel.tabs.map((t) => t.id), ["files", "info"]);
    assert.equal(panel.activeTab, "files", "Info shouldn't be what you land on");
    assert.equal(panel.tabs[0].count, MIXED.length);
    // And the Files tab is the one rendered.
    assert.ok(nodes.some((n) => n.type === "track-row-list"));
    assert.ok(nodes.some((n) => n.action === "qbt:file-filter"), "the filter belongs with the files");
  }, { files: () => MIXED });
});

test("the Info tab replaces the file list rather than sitting under it", async () => {
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:detail-tab"]({ tabId: "info" });
    await settle();
    const nodes = walk(last(views));
    assert.ok(!nodes.some((n) => n.type === "track-row-list"), "the file list is still rendered");
    assert.ok(!nodes.some((n) => n.action === "qbt:file-filter"), "the file filter is still rendered");
    // Back to Files.
    handlers["qbt:detail-tab"]({ tabId: "files" });
    await settle();
    assert.ok(walk(last(views)).some((n) => n.type === "track-row-list"));
  }, undefined, { files: () => MIXED });
});

test("a deselected file still shows its size", async () => {
  // It is the figure you decide on — how much the thing you are skipping would
  // have cost.
  await openContents(async (_ctx, nodes) => {
    const row = nodes.find((n) => n.type === "track-row-list").items[0];
    assert.match(row.subtitle, /^Not selected for download.*10 MB$/, row.subtitle);
  }, { files: () => NONE_WANTED });
});

test("a file's size sits after its status, not in a trailing column", async () => {
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    for (const item of list.items) {
      assert.equal(item.duration, undefined, item.title + " still has a size column");
      assert.match(item.subtitle, /(B|KB|MB|GB)$/, item.title + " → " + item.subtitle);
    }
    // Status first, size last — the order the row is read in.
    const downloading = list.items.find((i) => i.id === "2");
    assert.match(downloading.subtitle, /^Downloading.*900 MB$/, downloading.subtitle);
  }, { files: () => MIXED });
});

test("the list still declares all four, so the toolbar can offer them", async () => {
  // A multi-row selection can legitimately need both directions, and the
  // declared order is what keeps the shared buttons in the same slot per row.
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.deepEqual(list.actions.map((a) => a.id), [
      "qbt:play-file",
      "qbt:enqueue-file",
      "qbt:file-download",
      "qbt:file-skip",
    ]);
  }, { files: () => MIXED });
});

test("Play on a file row plays that file and nothing else", async () => {
  // It used to start the whole torrent from that point, on the argument that
  // clicking a track in any other list does that. But this list is a torrent's
  // contents, most of which is usually not music, and "play this one" is the
  // only reading of a button on a single file.
  const DONE = [
    { index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "02 - Second.flac", size: 10, progress: 1, priority: 1 },
    { index: 2, name: "03 - Third.flac", size: 10, progress: 1, priority: 1 },
  ];
  await withPlugin(async ({ handlers, played }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:play-file"]({ selectedIds: ["1"], itemId: "1" });
    await settle();
    assert.equal(played.length, 1, "nothing played");
    assert.equal(played[0].tracks.length, 1, "played " + played[0].tracks.length + " tracks, not 1");
    assert.match(played[0].tracks[0].title, /Second/);
  }, undefined, { files: () => DONE });
});

test("Play on a multi-row selection plays exactly those files", async () => {
  const DONE = [
    { index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "02 - Second.flac", size: 10, progress: 1, priority: 1 },
    { index: 2, name: "03 - Third.flac", size: 10, progress: 1, priority: 1 },
  ];
  await withPlugin(async ({ handlers, played }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:play-file"]({ selectedIds: ["0", "2"] });
    await settle();
    assert.equal(played[0].tracks.length, 2);
    assert.match(played[0].tracks[0].title, /First/);
    assert.match(played[0].tracks[1].title, /Third/);
  }, undefined, { files: () => DONE });
});

test("Play on an unfinished file says so rather than playing something else", async () => {
  const seen = [];
  await withPlugin(async ({ handlers, api, played }) => {
    api.ui.showNotification = (m) => seen.push(m);
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    // index 1 in MIXED is a .flac at 0% — not on disk yet.
    handlers["qbt:play-file"]({ selectedIds: ["1"], itemId: "1" });
    await settle();
    assert.equal(played.length, 0, "played a file that isn't downloaded");
    assert.ok(seen.some((m) => /hasn't finished downloading/.test(m)), seen.join(" | "));
  }, undefined, { files: () => [
    { index: 0, name: "01.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "02.flac", size: 10, progress: 0.5, priority: 1 },
  ] });
});

test("a file that finishes while the panel is open stops saying 0%", async () => {
  // The reported bug, end to end: /sync/maindata describes TORRENTS, and the
  // file list is a separate endpoint that was only read on open and after a
  // priority change. So a file downloaded while you watched sat at
  // "Downloading 0%" for ever, however far qBittorrent had actually got.
  let serving = [
    { index: 0, name: "01 - First.flac", size: 10, progress: 0, priority: 1 },
  ];
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    let row = walk(last(views)).find((n) => n.type === "track-row-list").items[0];
    assert.match(row.subtitle, /^Downloading/);

    // qBittorrent finishes it. The torrent poll alone must not be trusted to
    // notice — the file list has to be re-read.
    serving = [{ index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 }];
    handlers["qbt:refresh"]();
    await settle();
    await settle();

    row = walk(last(views)).find((n) => n.type === "track-row-list").items[0];
    assert.equal(row.subtitle.split("  ·  ")[0], "Downloaded", row.subtitle);
  }, undefined, { files: () => serving });
});

test("a file that finishes while the panel is open becomes playable", async () => {
  // The second half of the same bug: Play read the stale cache and refused with
  // "nothing finished downloading" about a file that plainly had.
  let serving = [
    { index: 0, name: "01 - First.flac", size: 10, progress: 0, priority: 1 },
  ];
  const seen = [];
  await withPlugin(async ({ handlers, api, played }) => {
    api.ui.showNotification = (m) => seen.push(m);
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    serving = [{ index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 }];
    handlers["qbt:refresh"]();
    await settle();
    await settle();

    handlers["qbt:play-file"]({ selectedIds: ["0"], itemId: "0" });
    await settle();
    assert.equal(played.length, 1, "refused to play a finished file: " + seen.join(" | "));
    assert.equal(played[0].tracks.length, 1);
  }, undefined, { files: () => serving });
});

test("the refresh happens only while a torrent is open", async () => {
  // One request per poll is the cost, so it has to be paid only when there is
  // a panel to keep live.
  const fileReads = (posts, all) => all.filter((u) => u.includes("/torrents/files")).length;
  await withPlugin(async ({ handlers, api, posts }) => {
    const urls = [];
    const realFetch = api.network.fetch;
    api.network.fetch = (u, init) => { urls.push(u); return realFetch(u, init); };

    urls.length = 0;
    handlers["qbt:refresh"]();
    await settle();
    await settle();
    assert.equal(fileReads(posts, urls), 0, "read a file list with nothing open");

    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    urls.length = 0;
    handlers["qbt:refresh"]();
    await settle();
    await settle();
    assert.ok(fileReads(posts, urls) >= 1, "never refreshed the open torrent");

    handlers["qbt:close-files"]();
    await settle();
    urls.length = 0;
    handlers["qbt:refresh"]();
    await settle();
    await settle();
    assert.equal(fileReads(posts, urls), 0, "still reading after the panel closed");
  }, undefined, { files: () => FILES });
});
test("an unchanged file list does not churn the view", async () => {
  // The panel redraws every poll anyway; rebuilding the rows and their tiles
  // for a list that hasn't moved is work for nothing.
  const sig = (files) => plugin_sig(files);
  const a = [{ index: 0, name: "a.flac", size: 1, progress: 0.5, priority: 1 }];
  const b = [{ index: 0, name: "a.flac", size: 1, progress: 0.5, priority: 1 }];
  const c = [{ index: 0, name: "a.flac", size: 1, progress: 1, priority: 1 }];
  assert.equal(sig(a), sig(b));
  assert.notEqual(sig(a), sig(c));
  // A priority change counts too — that's what a Download/Skip press produces.
  assert.notEqual(sig(a), sig([{ index: 0, name: "a.flac", size: 1, progress: 0.5, priority: 0 }]));
});

test("a file inside a folder shows the folder in its row", async () => {
  const NESTED = [
    { index: 0, name: "CD1/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "CD2/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 2, name: "extras/scans/front.jpg", size: 10, progress: 0, priority: 0 },
    { index: 3, name: "folder.jpg", size: 10, progress: 0, priority: 0 },
  ];
  await openContents(async (_ctx, nodes) => {
    const titles = nodes.find((n) => n.type === "track-row-list").items.map((i) => i.title);
    // The two discs' track 1 are no longer the same row twice.
    assert.ok(titles.includes("CD1 / First"), titles.join(" | "));
    assert.ok(titles.includes("CD2 / First"), titles.join(" | "));
    assert.ok(titles.includes("extras / scans / front.jpg"), titles.join(" | "));
    // A file at the root is unchanged.
    assert.ok(titles.includes("folder.jpg"), titles.join(" | "));
  }, { files: () => NESTED });
});

test("filtering by folder name now explains its own results", async () => {
  // The filter already matched on the full path; the rows just didn't show it,
  // so searching "extras" returned rows with no visible reason to match.
  const NESTED = [
    { index: 0, name: "CD1/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "extras/bonus.mkv", size: 10, progress: 0, priority: 0 },
  ];
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:file-filter"]({ query: "extras" });
    await settle();
    const items = walk(last(views)).find((n) => n.type === "track-row-list").items;
    assert.equal(items.length, 1);
    assert.match(items[0].title, /^extras \//);
  }, undefined, { files: () => NESTED });
});

test("the torrent's own folder is stripped from every row title", async () => {
  // qBittorrent reports paths including the torrent's wrapper directory. The
  // hero already names it, so the rows show what is relative to it.
  const N = "Some Artist - Album (1998) [FLAC]";
  const WRAPPED = [
    { index: 0, name: N + "/CD1/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: N + "/CD2/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 2, name: N + "/folder.jpg", size: 10, progress: 0, priority: 0 },
  ];
  await openContents(async (_ctx, nodes) => {
    const titles = nodes.find((n) => n.type === "track-row-list").items.map((i) => i.title);
    assert.deepEqual(titles.sort(), ["CD1 / First", "CD2 / First", "folder.jpg"]);
    for (const t of titles) assert.ok(!t.includes(N), "the wrapper survived: " + t);
  }, { files: () => WRAPPED });
});

test("a filter narrows the list without re-titling what is left", async () => {
  // The shared folder is computed across ALL files. Computing it from the
  // filtered view would strip a different amount as you typed, so a row would
  // change its name while you were reading it.
  const N = "Release";
  const WRAPPED = [
    { index: 0, name: N + "/CD1/01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: N + "/CD2/02 - Second.flac", size: 10, progress: 1, priority: 1 },
  ];
  await withPlugin(async ({ handlers, views }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const before = walk(last(views)).find((n) => n.type === "track-row-list").items[0].title;
    assert.equal(before, "CD1 / First");

    handlers["qbt:file-filter"]({ query: "cd1" });
    await settle();
    const items = walk(last(views)).find((n) => n.type === "track-row-list").items;
    assert.equal(items.length, 1);
    assert.equal(items[0].title, before, "the row renamed itself when filtered");
  }, undefined, { files: () => WRAPPED });
});

// --- what the now-playing source panel is told --------------------------------

test("the resolver reports the real file path, not just the stream URL", async () => {
  // Without `sourceUrl` the host has nothing but the track's own URI, so a file
  // sitting on this disk was described in the source panel as "qbt://<hash>/0",
  // with no path shown and no Open folder button. A bare URL string has nowhere
  // to carry it; the one-candidate object form does, and the host treats that
  // exactly like a bare URL.
  const T = {
    aaa: {
      hash: "aaa", name: "Album", state: "stalledUP", progress: 1,
      size: 10, total_size: 10, added_on: 1, category: "viboplr",
      save_path: "/mnt/music/incoming",
    },
  };
  await withPlugin(async ({ resolvers, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const out = await resolvers.qbt("aaa/0");
    assert.ok(out && typeof out === "object", "still returning a bare URL string");
    assert.equal(out.sourceUrl, "file:///mnt/music/incoming/01 - First.flac");
    // And it is still a playable stream for the host's selector.
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].url, out.sourceUrl);
  }, undefined, {
    torrents: T,
    files: () => [{ index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 }],
  });
});

test("an unresolvable file still fails loudly rather than reporting nothing", async () => {
  const T = {
    aaa: { hash: "aaa", name: "Album", state: "stalledUP", progress: 1, size: 10, total_size: 10, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ resolvers, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    await assert.rejects(() => resolvers.qbt("aaa/0"), /didn't report where it saved/);
  }, undefined, {
    torrents: T,
    files: () => [{ index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 }],
  });
});

test("a file row offers only what it can actually do", async () => {
  // Play and Add to queue are for a file that EXISTS — the bytes on disk. On a
  // file still being fetched they act on nothing. Download and Skip are the
  // choice about whether to fetch it, in two directions, so a row offers the
  // one it is not already in; a downloaded file is past that choice entirely.
  const MIX = [
    { index: 0, name: "done.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "partial.flac", size: 10, progress: 0.5, priority: 1 },
    { index: 2, name: "skipped.mkv", size: 10, progress: 0, priority: 0 },
  ];
  await openContents(async (_ctx, nodes) => {
    const byId = Object.fromEntries(
      nodes.find((n) => n.type === "track-row-list").items.map((i) => [i.id, i.actions]),
    );
    assert.deepEqual(byId["0"], ["qbt:play-file", "qbt:enqueue-file"]);
    assert.deepEqual(byId["1"], ["qbt:file-skip"]);
    assert.deepEqual(byId["2"], ["qbt:file-download"]);
  }, { files: () => MIX });
});

test("double-click fires what the row put first, never a fallback", async () => {
  // The host falls back to the first visible action when a row names none, so
  // an unnamed row would double-click into whatever happened to be there.
  const MIX = [
    { index: 0, name: "done.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "partial.flac", size: 10, progress: 0.5, priority: 1 },
    { index: 2, name: "skipped.mkv", size: 10, progress: 0, priority: 0 },
  ];
  await openContents(async (_ctx, nodes) => {
    const byId = Object.fromEntries(
      nodes.find((n) => n.type === "track-row-list").items.map((i) => [i.id, i.action]),
    );
    assert.equal(byId["0"], "qbt:play-file");
    assert.equal(byId["1"], "qbt:file-skip");
    assert.equal(byId["2"], "qbt:file-download");
  }, { files: () => MIX });
});

test("the list still declares all four for the selection toolbar", async () => {
  // A multi-row selection can legitimately need any of them, and the declared
  // order is what keeps a shared button in the same slot from row to row.
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.deepEqual(list.actions.map((a) => a.id), [
      "qbt:play-file",
      "qbt:enqueue-file",
      "qbt:file-download",
      "qbt:file-skip",
    ]);
  }, { files: () => MIXED });
});

test("an older host gets the bare URL, not a file:// candidate", async () => {
  // Until 1.0.28 the host assumed every candidate was a network stream: it
  // handed the URL to the media element verbatim and told mpv it was http. A
  // file:// there is unloadable in the webview, so the object form would break
  // playback outright rather than merely losing the path readout.
  const T = {
    aaa: { hash: "aaa", name: "Album", state: "stalledUP", progress: 1, size: 10, total_size: 10, added_on: 1, category: "viboplr", save_path: "/mnt/music" },
  };
  const files = () => [{ index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 }];

  await withPlugin(async ({ resolvers, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const out = await resolvers.qbt("aaa/0");
    assert.equal(typeof out, "string", "sent a candidate list to a host that mishandles it");
    assert.equal(out, "file:///mnt/music/01 - First.flac");
  }, undefined, { torrents: T, files, appVersion: "1.0.27" });

  // And the newer host still gets the attribution.
  await withPlugin(async ({ resolvers, handlers }) => {
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const out = await resolvers.qbt("aaa/0");
    assert.equal(typeof out, "object");
    assert.equal(out.sourceUrl, "file:///mnt/music/01 - First.flac");
  }, undefined, { torrents: T, files, appVersion: "1.0.28" });
});
