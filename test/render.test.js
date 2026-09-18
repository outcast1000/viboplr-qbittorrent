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
  const ctxActions = {};
  const navigations = [];
  const posts = [];
  const opened = [];
  const played = [];
  const resolvers = {};
  // A thunk, so a test can change what the server serves mid-run (qBittorrent
  // reports the NEW priorities once they have been posted). It is passed the
  // HASH being asked about, because the list fetches every torrent's files to
  // decorate its rows — so "this torrent holds media and that one doesn't" is
  // now a thing a test needs to be able to say.
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
      navigateToView: (id) => { navigations.push(id); },
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
        // A test can answer endpoints the defaults don't know (the search
        // flow); returning null/undefined falls through to them.
        const custom = opts && opts.onFetch ? opts.onFetch(url) : null;
        const body = custom != null ? custom
          : url.includes("/app/webapiVersion") ? "2.11"
            : url.includes("/app/version") ? "v5.2.4"
              : url.includes("/torrents/files") ? JSON.stringify(filesFor(/hash=([^&]*)/.exec(url)?.[1] ?? ""))
                : url.includes("/sync/maindata") ? JSON.stringify({ rid: 1, full_update: true, torrents: torrentsFor(), server_state: {} })
                  : "Ok.";
        return { status: 200, ok: true, text: async () => body, json: async () => JSON.parse(body) };
      },
      openUrl: async (url) => { opened.push(url); },
    },
    collections: { getLocalCollections: async () => [], resync: async () => {} },
    playback: {
      playTracks: (tracks, startIndex, context) => played.push({ tracks, startIndex, context }),
      insertTracks: () => {},
      getQueue: () => ({ tracks: [], index: 0 }),
      onResolveStreamByUri: (scheme, handler) => { resolvers[scheme] = handler; },
    },
    contextMenu: { onAction: (id, fn) => { ctxActions[id] = fn; } },
    scheduler: { register: async () => {}, onDue: () => {} },
  };
  const g = Object.freeze({});
  const plugin = new Function("api", "window", "globalThis", "self", "document", SOURCE)(undefined, g, g, g, g);
  plugin.activate(api);
  return { plugin, views, settingsViews, handlers, ctxActions, navigations, api, posts, opened, played, resolvers };
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

test("one header row: filter, Add, Refresh and the status share the line", async () => {
  await withPlugin(async ({ views }) => {
    const nodes = walk(last(views));
    // The old toolbar node is gone; its two surviving actions and the status
    // ride the filter line instead, so the list keeps one row of furniture.
    assert.ok(!nodes.some((n) => n.type === "toolbar"), "the toolbar row is back");
    const row = nodes.find((n) => n.type === "layout" && n.direction === "horizontal" &&
      (n.children || []).some((c) => c.action === "qbt:list-filter"));
    assert.ok(row, "no header row holding the filter");
    const actions = (row.children || []).map((c) => c.action);
    assert.ok(actions.includes("qbt:add-toggle"), "Add torrent left the header row");
    assert.ok(actions.includes("qbt:refresh"), "Refresh left the header row");
    const status = (row.children || []).find((c) => c.type === "text");
    assert.match(status.content, /Connected/);
    assert.match(status.className, /plugin-toolbar-status--success/);
    // Start all / Stop all are gone for good: the selection bar's All + Start /
    // All + Stop is the same act.
    assert.ok(!nodes.some((n) => n.action === "qbt:start-all" || n.action === "qbt:stop-all"));
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
    // No Contents button — the row itself opens the contents, on a title click
    // and on double-click, so a third route would only cost tray width.
    assert.ok(!list.actions.some((a) => a.id === "qbt:show-files"));
    assert.equal(list.items[0].action, "qbt:show-files", "the row no longer opens at all");
    assert.equal(list.openOnClick, "title");
  });
});

test("a row offers only the actions that would do something to it", async () => {
  // "aaa" is downloading and holds a finished .flac; "bbb" is seeding a file
  // with nothing playable in it.
  const files = (hash) =>
    hash === "bbb"
      ? [{ index: 0, name: "readme.nfo", size: 1024, progress: 1, priority: 1 }]
      : FILES;
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const row = (id) => list.items.find((i) => i.id === id).actions;
    // Running, with a playable file: Play and Stop, and no Start that would be
    // a no-op on something already going.
    assert.deepEqual(row("aaa"), ["qbt:play-torrent", "qbt:stop", "qbt:delete-ask"]);
    // Finished, so every file is on disk — and not one of them is media, so
    // there is nothing to play however complete it is.
    assert.deepEqual(row("bbb"), ["qbt:stop", "qbt:delete-ask"]);
    // The list still DECLARES all four; the row names the subset it shows.
    assert.deepEqual(list.actions.map((a) => a.id), [
      "qbt:play-torrent",
      "qbt:start",
      "qbt:stop",
      "qbt:delete-ask",
    ]);
  }, undefined, { files });
});

test("a stopped row offers Start instead of Stop", async () => {
  const torrents = {
    aaa: { hash: "aaa", name: "Parked", state: "stoppedDL", progress: 0.4, size: 100, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const actions = list.items[0].actions;
    assert.ok(actions.indexOf("qbt:start") >= 0, actions.join());
    assert.ok(actions.indexOf("qbt:stop") < 0, actions.join());
  }, undefined, { torrents });
});

test("Play and Start are not both triangles", async () => {
  // Only the glyph is on screen — the label is a tooltip — and "▶" beside "⏵"
  // read as two goes at the same button. Stop is a square, not a pause bar:
  // qBittorrent has no pause.
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const icon = (id) => list.actions.find((a) => a.id === id).icon;
    assert.equal(icon("qbt:play-torrent"), "▶");
    assert.notEqual(icon("qbt:start"), icon("qbt:play-torrent"));
    assert.ok(!/[▶⏵▷►]/.test(icon("qbt:start")), "Start still looks like Play: " + icon("qbt:start"));
    assert.ok(!/[⏸‖]/.test(icon("qbt:stop")), "Stop still looks like Pause: " + icon("qbt:stop"));
  });
});

test("the badge counts the whole torrent, not the selected files", async () => {
  // One small file picked out of a big release: `progress` says 100%, and the
  // badge must not.
  const torrents = {
    aaa: {
      hash: "aaa", name: "Big Release", state: "stalledUP", progress: 1,
      completed: 5 * 1024 * 1024, size: 5 * 1024 * 1024, total_size: 500 * 1024 * 1024,
      added_on: 1, category: "viboplr",
    },
  };
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    const svg = decodeURIComponent(list.items[0].imageUrl);
    assert.match(svg, />1%</, svg.slice(-120));
    assert.ok(!/>100%</.test(svg), "the badge still reads the selection's progress");
  }, undefined, { torrents });
});

// "first" is in both torrents' file lists and in neither torrent's NAME, so
// both rows here are file matches — which is what the list under the torrents
// is for. ("flac" would match one of them by name and contribute no file row.)
test("the matching files are a multi-selection list of their own", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:list-filter"]({ query: "first" });
    await settle();
    // Two lists on screen, both multi-select: each toolbar acts on its own
    // list's selection, and with Start all / Stop all gone no button is
    // ambiguous about which. Multi is what lets "pick five found files and
    // Play / Download them" be a gesture rather than only a handler contract.
    const lists = walk(last(views)).filter((n) => n.type === "track-row-list");
    assert.equal(lists.length, 2);
    const matches = lists[1];
    assert.equal(matches.selectable, true);
    assert.ok(!matches.selectionMode, "absent selectionMode = the host default, multi");
    // No Downloaded preset: "show me the ones I have" is the Downloaded only
    // view toggle, which changes what is on screen rather than what is
    // highlighted; All / None select what the toggle left visible.
    assert.ok(!matches.selectionPresets);
    // The SAME buttons a file gets inside its torrent — a file is a file, and
    // which list you found it in is not a property of it. There is no "Open
    // torrent": this list is about the files, and each row already names the
    // torrent it came from.
    assert.deepEqual(matches.actions.map((a) => a.id), [
      "qbt:play-file",
      "qbt:enqueue-file",
      "qbt:file-open",
      "qbt:file-folder",
      "qbt:file-download",
      "qbt:file-skip",
    ]);
    // The row's id is the FILE INDEX now — the background read landed — so it
    // says what it is, offers to play, and carries a path for drag-to-queue.
    const row = matches.items[0];
    assert.match(row.id, /^qbtm:[^:]+:0$/);
    assert.match(row.subtitle, /^Downloaded/);
    assert.match(row.path, /^qbt:\/\/[^/]+\/0$/);
    assert.deepEqual(row.actions, ["qbt:play-file", "qbt:enqueue-file", "qbt:file-folder"]);
    assert.equal(row.action, "qbt:play-file", "double-click plays it, as it would inside its torrent");
  });
});

test("a match that isn't downloaded offers no Play", async () => {
  await withPlugin(async ({ views, handlers }) => {
    // "extras/bonus.mkv" is deselected and at 0%.
    handlers["qbt:list-filter"]({ query: "bonus" });
    await settle();
    const matches = walk(last(views)).filter((n) => n.type === "track-row-list")[1];
    const row = matches.items[0];
    // Deselected and not downloaded, so the one thing to offer is the choice it
    // is not already in — exactly what the same file offers inside its torrent.
    assert.deepEqual(row.actions, ["qbt:file-download"]);
    assert.equal(row.path, null);
    assert.match(row.subtitle, /Not selected/);
  });
});

test("playing a multi-torrent selection queues every torrent's files, in order", async () => {
  // The toolbar's Play acts on the whole selection, like Start / Stop / Remove.
  // It used to play only the first torrent (with a "playing the first" note),
  // from when the torrent list was single-selection and a many-hash call was
  // only a handler contract.
  const torrents = {
    aaa: { hash: "aaa", name: "Album One [FLAC]", state: "stalledUP", progress: 1, size: 1, added_on: 200, category: "viboplr" },
    bbb: { hash: "bbb", name: "Album Two [FLAC]", state: "stalledUP", progress: 1, size: 1, added_on: 100, category: "viboplr" },
  };
  const files = (hash) => [
    { index: 0, name: hash + " 01.flac", size: 1, progress: 1, priority: 1 },
    { index: 1, name: hash + " 02.flac", size: 1, progress: 1, priority: 1 },
  ];
  await withPlugin(async ({ views, handlers, played }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    handlers["qbt:play-torrent"]({ selectedIds: list.items.map((i) => i.id) });
    await settle();
    await settle();
    assert.equal(played.length, 1, "one queue, not one play per torrent");
    assert.equal(played[0].tracks.length, 4, "every selected torrent's files");
    // Torrent by torrent, in the order the list showed them — never interleaved
    // by whichever file list answered first.
    const hashesInOrder = played[0].tracks.map((t) => /^qbt:\/\/([^/]+)/.exec(t.path)[1]);
    assert.deepEqual(hashesInOrder, [
      list.items[0].id, list.items[0].id,
      list.items[1].id, list.items[1].id,
    ]);
    assert.match(played[0].context.name, /2 torrents/);
  }, undefined, { torrents, files: (hash) => files(hash) });
});

// Drives the handler directly with the selection the match list's own toolbar
// now builds. It is what keeps the shared play/enqueue path honest about
// grouping by torrent — the contents list can send several rows at once too.
test("playing several match rows queues them in the order shown, across torrents", async () => {
  await withPlugin(async ({ views, handlers, played }) => {
    handlers["qbt:list-filter"]({ query: "first" });
    await settle();
    const matches = walk(last(views)).filter((n) => n.type === "track-row-list")[1];
    assert.equal(matches.items.length, 2, "precondition: one match in each torrent");
    handlers["qbt:play-file"]({ selectedIds: matches.items.map((i) => i.id) });
    await settle();
    assert.equal(played.length, 1);
    // One track per matched torrent, in the order the list showed them —
    // through the same builder a torrent's own file list uses, so the entries
    // carry real metadata rather than filenames.
    assert.equal(played[0].tracks.length, 2);
    assert.match(played[0].context.name, /Matching “first”/);
    assert.ok(played[0].tracks.every((t) => /^qbt:\/\//.test(t.path)), "tracks must be playable qbt:// entries");
  });
});

test("every match is listed and selectable, up to the whole-list limit", async () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push({ index: i, name: "Disc/" + i + ".flac", size: 10, progress: 1, priority: 1 });
  const torrents = {
    aaa: { hash: "aaa", name: "A Release", state: "stalledUP", progress: 1, size: 90, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:list-filter"]({ query: "disc" });
    await settle();
    const matches = walk(last(views)).filter((n) => n.type === "track-row-list")[1];
    // No stand-in row: a match with no row is a file you cannot play, queue or
    // skip, and a search that withholds most of what it found is worse than a
    // long list.
    assert.equal(matches.items.length, 9);
    assert.ok(!matches.items.some((i) => /:more$/.test(i.id)));
  }, undefined, { files: () => many, torrents });
});

test("a match row's Download / Skip act on the right torrent's file", async () => {
  // The proof that one set of handlers really serves both lists: nothing is
  // "open" here, so a handler reading expandedHash would act on nothing — or,
  // worse, on whatever was open last.
  const files = () => [
    { index: 0, name: "Disc/have.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "Disc/want.flac", size: 10, progress: 0, priority: 0 },
  ];
  const torrents = {
    aaa: { hash: "aaa", name: "A Release", state: "downloading", progress: 0.5, size: 20, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ views, handlers, posts }) => {
    handlers["qbt:list-filter"]({ query: "want" });
    await settle();
    const row = walk(last(views)).filter((n) => n.type === "track-row-list")[1].items[0];
    assert.deepEqual(row.actions, ["qbt:file-download"], "a skipped file offers the choice it isn't in");

    handlers["qbt:file-download"]({ selectedIds: [row.id], itemId: row.id });
    await settle();
    const post = posts.filter((p) => /filePrio/.test(p.url)).pop();
    assert.ok(post, "no priority was posted");
    assert.equal(post.form.hash, "aaa", "the row's own torrent, not whatever was open");
    assert.equal(post.form.id, "1");
    assert.equal(post.form.priority, "1");
  }, undefined, { files, torrents });
});

test("“Files only” hides the torrent rows, keeping the matches", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:list-filter"]({ query: "first" });
    await settle();
    assert.equal(walk(last(views)).filter((n) => n.type === "track-row-list").length, 2);

    handlers["qbt:view-files-only"]({ checked: true });
    await settle();
    const nodes = walk(last(views));
    const lists = nodes.filter((n) => n.type === "track-row-list");
    assert.equal(lists.length, 1, "the torrent list should be gone");
    assert.ok(lists[0].items.every((i) => /^qbtm:/.test(i.id)), "what remains must be the file matches");
    // The header row stays: it carries the filter, Add torrent, Refresh and
    // the connection status, none of which are about the rows being hidden.
    assert.ok(nodes.some((n) => n.action === "qbt:add-toggle"));
    assert.ok(nodes.some((n) => n.action === "qbt:list-filter"));

    handlers["qbt:view-files-only"]({ checked: false });
    await settle();
    assert.equal(walk(last(views)).filter((n) => n.type === "track-row-list").length, 2);
  });
});

test("“Downloaded only” drops the matches that aren't on disk", async () => {
  const files = () => [
    { index: 0, name: "Disc/have.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "Disc/want.flac", size: 10, progress: 0.5, priority: 1 },
  ];
  const torrents = {
    aaa: { hash: "aaa", name: "A Release", state: "downloading", progress: 0.75, size: 20, added_on: 1, category: "viboplr" },
  };
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:list-filter"]({ query: "disc" });
    await settle();
    const matchList = () => walk(last(views)).filter((n) => n.type === "track-row-list")[1];
    const heading = () => walk(last(views)).filter((n) => n.type === "text" && /Matching files/.test(n.content || ""))[0];
    assert.equal(matchList().items.length, 2);

    handlers["qbt:view-downloaded-only"]({ checked: true });
    await settle();
    assert.equal(matchList().items.length, 1);
    assert.match(matchList().items[0].title, /have\.flac/);
    // Both numbers, always: "1" over a list the user just narrowed would read
    // as "that is all there was".
    assert.match(heading().content, /downloaded only \(1 of 2\)/);
  }, undefined, { files, torrents });
});

test("the view toggles only appear when there are file matches to view", async () => {
  await withPlugin(async ({ views, handlers }) => {
    // A query that matches a torrent's NAME contributes no file rows, so
    // neither toggle would have anything to act on.
    handlers["qbt:list-filter"]({ query: "movie" });
    await settle();
    const toggles = walk(last(views)).filter((n) => n.type === "toggle");
    assert.equal(toggles.length, 0);

    handlers["qbt:list-filter"]({ query: "first" });
    await settle();
    assert.deepEqual(
      walk(last(views)).filter((n) => n.type === "toggle").map((n) => n.label),
      ["Files only", "Downloaded only"],
    );
  });
});

test("a view filter left on cannot blank a later search", async () => {
  // The modes are deliberately sticky across queries — "I'm looking for files I
  // already have" is a mode, not a property of one query — so the guard is that
  // they do nothing when a search has no file matches at all.
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:list-filter"]({ query: "first" });
    await settle();
    handlers["qbt:view-files-only"]({ checked: true });
    await settle();
    assert.equal(walk(last(views)).filter((n) => n.type === "track-row-list").length, 1);

    handlers["qbt:list-filter"]({ query: "movie" });
    await settle();
    const lists = walk(last(views)).filter((n) => n.type === "track-row-list");
    assert.equal(lists.length, 1, "the torrent list must come back");
    assert.ok(lists[0].items.every((i) => !/^qbtm:/.test(i.id)), "and it must be the torrents");
  });
});

test("a single character filters names only, and says so", async () => {
  await withPlugin(async ({ views, handlers, posts }) => {
    const before = posts.length;
    handlers["qbt:list-filter"]({ query: "f" });
    await settle();
    const nodes = walk(last(views));
    // One letter matches nearly every file in every release, so searching
    // inside them would cost a library-wide fetch to answer nothing.
    assert.equal(nodes.filter((n) => n.type === "track-row-list").length, 1, "no matching-files list for one character");
    assert.ok(
      nodes.some((n) => /type one more character/i.test(n.content || "")),
      "the boundary has to be stated — the box promises to search inside torrents",
    );
    assert.equal(posts.length, before, "one character must not kick off any fetching");

    // Two is enough.
    handlers["qbt:list-filter"]({ query: "fi" });
    await settle();
    const after = walk(last(views));
    assert.equal(after.filter((n) => n.type === "track-row-list").length, 2);
    assert.ok(!after.some((n) => /type one more character/i.test(n.content || "")));
  });
});

test("the torrent list is multi-selection again; so are the files inside one", async () => {
  await withPlugin(async ({ views, handlers }) => {
    const torrents = walk(last(views)).find((n) => n.type === "track-row-list");
    // Multi restored: with the title as the open hotspot, a plain body click
    // builds the selection, so the toolbar's Play / Start / Stop / Remove have
    // a selection to act on that no longer costs a modifier to build.
    assert.ok(!torrents.selectionMode, "absent selectionMode = the host default, multi");
    assert.equal(torrents.selectable, true);
    assert.ok(!torrents.selectionPresets, "no named subsets of torrents to select");

    // The files inside a torrent are the opposite case: choosing which of them
    // download is inherently a multi-row job, and the presets are the point.
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    const files = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.ok(!files.selectionMode, "the files list must stay multi-selection");
    assert.ok(files.selectionPresets.length > 0);
  });
});

test("opening a torrent's contents replaces the list", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:show-files"]({ selectedIds: ["aaa"], itemId: "aaa" });
    await settle();
    const nodes = walk(last(views));
    // The list's own furniture is gone: no add box and no header row, whose
    // torrent-list filter would filter nothing on this screen. (The panel has a
    // stats-grid of its own — the torrent's facts, not the server's.)
    // By action, not by node type — the panel has a search-input of its own now
    // (the file filter), so counting them would pass for the wrong reason.
    assert.ok(!nodes.some((n) => n.action === "qbt:add"), "the list's add box is still here");
    assert.ok(!nodes.some((n) => n.action === "qbt:add-toggle"), "the list's Add torrent is still here");
    assert.ok(!nodes.some((n) => n.action === "qbt:list-filter"), "the list's filter is still here");
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
    // The list's own furniture is back. The add box itself lives behind the
    // toolbar button now, so that button — not the input — is what returns.
    assert.ok(nodes.some((n) => n.action === "qbt:add-toggle"), "the add button didn't come back");
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.equal(list.items.length, 2, "expected the torrent list back");
  });
});

test("the add box hides behind the header-row button, and toggles", async () => {
  await withPlugin(async ({ views, handlers }) => {
    // A list with torrents in it: the box is closed, so the row above the list
    // is the header row rather than a paste field nobody is using.
    assert.ok(!walk(last(views)).some((n) => n.action === "qbt:add"), "the add box is open over a populated list");

    handlers["qbt:add-toggle"]();
    await settle();
    const opened = walk(last(views));
    const box = opened.find((n) => n.action === "qbt:add");
    assert.ok(box, "the button didn't open the add box");
    assert.equal(box.type, "search-input");
    // Paste is the only route a plugin has to the clipboard, and a copied
    // magnet is the whole point of this box.
    assert.equal(box.pasteButton, true);
    assert.ok(opened.some((n) => n.type === "section" && n.title === "Add a torrent"), "the box has no panel around it");

    handlers["qbt:add-toggle"]();
    await settle();
    assert.ok(!walk(last(views)).some((n) => n.action === "qbt:add"), "the box didn't close again");
  });
});

test("an empty list opens the add box for you, and can still close it", async () => {
  // Nothing to watch, so the one thing to do is the thing on screen.
  await withPlugin(async ({ views, handlers }) => {
    assert.ok(walk(last(views)).some((n) => n.action === "qbt:add"), "an empty list didn't offer the add box");

    // And the button is not dead on that screen: closing must stay closed,
    // rather than reopening itself from the empty list on the next render.
    handlers["qbt:add-toggle"]();
    await settle();
    const nodes = walk(last(views));
    assert.ok(!nodes.some((n) => n.action === "qbt:add"), "the add box reopened itself");
    // With no box above it, the empty state points at the button instead.
    const empty = nodes.find((n) => n.type === "text" && /No torrents/.test(n.content || ""));
    assert.match(empty.content, /Add torrent/);
  }, undefined, { torrents: {} });
});

test("a successful add puts the box away", async () => {
  const HASH = "a".repeat(40);
  const ADDED = { hash: HASH, name: "Added Thing", state: "downloading", progress: 0, size: 1024, added_on: 300, category: "viboplr" };
  // The server reports the new torrent from the moment the add is posted, so
  // the add verifies itself on its first look instead of polling for it —
  // otherwise the retry loop outlives the test and its next refresh lands on a
  // deactivated plugin.
  let landed = false;
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:add-toggle"]();
    await settle();
    assert.ok(walk(last(views)).some((n) => n.action === "qbt:add"), "precondition: the box should be open");

    landed = true;
    handlers["qbt:add"]({ query: "magnet:?xt=urn:btih:" + HASH });
    await settle();
    assert.ok(!walk(last(views)).some((n) => n.action === "qbt:add"), "the box stayed open after the add");
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.ok(list.items.some((i) => i.id === HASH), "the added torrent never reached the list");
  }, undefined, { torrents: () => (landed ? Object.assign({}, TORRENTS, { [HASH]: ADDED }) : TORRENTS) });
});

test("removing a multi-row selection confirms once, by count", async () => {
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:delete-ask"]({ selectedIds: ["aaa", "bbb"] });
    await settle();
    const nodes = walk(last(views));
    const confirm = nodes.find((n) => n.type === "confirm");
    assert.ok(confirm, "no confirm rendered");
    assert.match(confirm.message, /2 torrents/);
    // The confirm is a host modal OVER the view, not a replacement for it —
    // the torrent list must still be rendered underneath.
    assert.ok(
      nodes.some((n) => n.type === "track-row-list"),
      "the view behind the confirm was cleared"
    );
    // Cancel must be the harmless side — the host fires it on Escape too.
    assert.equal(confirm.cancelAction, "qbt:delete-cancel");
    handlers["qbt:delete-cancel"]();
  });
});

test("removing keeps the files unless the user ticks the box", async () => {
  await withPlugin(async ({ views, handlers, posts }) => {
    handlers["qbt:delete-ask"]({ selectedIds: ["aaa"] });
    await settle();
    const confirm = walk(last(views)).find((n) => n.type === "confirm");
    // The destructive reading is an opt-in inside the dialog, and it starts
    // OFF — qBittorrent deletes outright, with no Recycle Bin behind it.
    assert.match(confirm.checkboxLabel, /delete the downloaded files/i);
    assert.ok(!confirm.checkboxDefault);

    // Confirming without the tick is the old behaviour: the transfer stops,
    // the files stay.
    handlers["qbt:delete-confirm"]({});
    await settle();
    let post = posts.filter((p) => /torrents\/delete/.test(p.url)).pop();
    assert.ok(post, "nothing was deleted");
    assert.equal(post.form.hashes, "aaa");
    assert.equal(post.form.deleteFiles, "false");

    // Ticking it is the only thing that passes deleteFiles=true, and it rides
    // in on the action payload the host merges the checkbox state into.
    handlers["qbt:delete-ask"]({ selectedIds: ["bbb"] });
    await settle();
    handlers["qbt:delete-confirm"]({ checkboxChecked: true });
    await settle();
    post = posts.filter((p) => /torrents\/delete/.test(p.url)).pop();
    assert.equal(post.form.hashes, "bbb");
    assert.equal(post.form.deleteFiles, "true");
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

test("Upgrade with qBittorrent lands on Music Search with the track prefilled", async () => {
  await withPlugin(async ({ views, ctxActions, navigations, handlers }) => {
    // Leave a stale narration behind so the action's log reset is observable.
    handlers["qbt:tab"]({ tabId: "debug" });
    handlers["qbt:debug-title"]({ value: "Old Song" });
    handlers["qbt:debug-stream"]({});
    await settle();

    ctxActions["qbt-upgrade"]({ kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" });
    assert.deepEqual(navigations, ["qbittorrent"]);
    const nodes = walk(last(views));
    const tabs = nodes.find((n) => n.type === "tabs");
    assert.equal(tabs.activeTab, "debug");
    assert.ok(tabs.tabs.some((t) => t.id === "debug" && t.label === "Music Search"));
    const val = (action) => nodes.find((n) => n.type === "text-input" && n.action === action).value;
    assert.equal(val("qbt:debug-title"), "Jóga");
    assert.equal(val("qbt:debug-artist"), "Björk");
    assert.equal(val("qbt:debug-album"), "Homogenic");
    // The previous run's narration would read as this track's — it is cleared.
    const texts = nodes.filter((n) => n.type === "text").map((n) => n.content).join("\n");
    assert.ok(!texts.includes("STREAM resolve"), texts);
    // Nothing runs on landing: Search & download genuinely adds torrents, so
    // it must wait for the click.
    assert.ok(!nodes.some((n) => n.type === "loading"));

    // A target with no title or artist has nothing to search for — no navigation.
    ctxActions["qbt-upgrade"]({ kind: "track" });
    assert.equal(navigations.length, 1);
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
    // Match the narration marker, not the bare word — the tab's intro copy
    // legitimately mentions discovery.
    assert.ok(!texts.includes("starting discovery"), texts);
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
test("a torrent list row opens on a title click", async () => {
  // The host only fires a row's `action` on click when the list opts in; this
  // pins the opt-in being sent, since without it a click merely selects. The
  // "title" value narrows the hotspot to the row's name — clicking the rest of
  // the row selects it — and an older host reads it as truthy, i.e. as the
  // open-anywhere behaviour this list shipped with.
  await withPlugin(async ({ views }) => {
    const list = walk(last(views)).find((n) => n.type === "track-row-list");
    assert.equal(list.openOnClick, "title");
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

test("the list declares every action a row can offer", async () => {
  // A multi-row selection can legitimately need any of them, and the declared
  // order is what keeps the shared buttons in the same slot per row.
  //
  // It must cover everything fileRowActions can return: Open and Show folder
  // were missing here and therefore never rendered — the row asked for them and
  // the host, never having heard of them, dropped them.
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.deepEqual(list.actions.map((a) => a.id), [
      "qbt:play-file",
      "qbt:enqueue-file",
      "qbt:file-open",
      "qbt:file-folder",
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
    // Show folder rides along wherever there are bytes on disk to reveal — the
    // finished file AND the one still downloading (its folder exists now) — but
    // stays off the skipped one, which has nothing on disk. The fetch choice
    // still leads on the partial row, so its double-click is unchanged.
    assert.deepEqual(byId["0"], ["qbt:play-file", "qbt:enqueue-file", "qbt:file-folder"]);
    assert.deepEqual(byId["1"], ["qbt:file-skip", "qbt:file-folder"]);
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

test("a downloaded non-media file really gets its Open / Show folder buttons", async () => {
  // fileRowActions has offered these since 0.26.0, but the list never declared
  // them, so the host filtered them out of every row and a downloaded .nfo had
  // no buttons at all. Asserting the ROW's subset and the LIST's declaration
  // separately is what missed it.
  const withArt = [
    { index: 0, name: "01 - First.flac", size: 10, progress: 1, priority: 1 },
    { index: 1, name: "cover.jpg", size: 4, progress: 1, priority: 1 },
  ];
  await openContents(async (_ctx, nodes) => {
    const list = nodes.find((n) => n.type === "track-row-list");
    const declared = list.actions.map((a) => a.id);
    const art = list.items.find((i) => /cover/.test(i.title));
    assert.deepEqual(art.actions, ["qbt:file-open", "qbt:file-folder"]);
    for (const id of art.actions) assert.ok(declared.indexOf(id) >= 0, id + " is not declared, so it cannot render");
  }, { files: () => withArt });
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

// --- Search tab -----------------------------------------------------------

test("a search names its facilities, opens on title clicks, and keeps indexer failures out of the UI", async () => {
  const results = {
    status: "Stopped",
    results: [
      { fileName: "Artist - Album [FLAC]", fileUrl: "https://x/a.torrent", fileSize: 100, nbSeeders: 5, nbLeechers: 1, engineName: "jackett", siteUrl: "https://rutracker.org/t/1" },
      // A qBittorrent search plugin reports its own failure as a fake result
      // row: -1 size and swarm, the error text as the name.
      { fileName: "invalid credentials — check your API key", fileUrl: "https://jackett/help", fileSize: -1, nbSeeders: -1, nbLeechers: -1, engineName: "jackett" },
    ],
  };
  const onFetch = (url) =>
    url.includes("/search/plugins") ? JSON.stringify([{ name: "jackett", enabled: true }])
      : url.includes("/search/start") ? JSON.stringify({ id: 7 })
        : url.includes("/search/results") ? JSON.stringify(results)
          : null;
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:search"]({ query: "artist album" });
    await settle();
    await settle();
    const nodes = walk(last(views));
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.ok(list, "no results list rendered");
    // The failure row is a diagnostic: logged at ingestion, never a row and
    // never a warning banner burying the results the working indexers found.
    assert.equal(list.items.length, 1);
    assert.ok(!nodes.some((n) => /check your API key/.test(n.content || "")), "the indexer failure leaked into the UI");
    // Same gesture as the torrent list: the name opens the contents (paused),
    // the rest of the row selects; Download stays a deliberate button press.
    assert.equal(list.openOnClick, "title");
    assert.equal(list.items[0].action, "qbt:search-view");
    // Who found it, in two halves: the indexer in its own sortable column (the
    // site alone can't say which of your indexers is working), the facility in
    // the line underneath (the indexer alone can't say which of the two ran it).
    assert.equal(list.items[0].cells.source, "qBT · jackett");
    // One line per result — the facility rides the Source cell's prefix, so
    // there is nothing left for a subtitle to say.
    assert.equal(list.items[0].subtitle, undefined);
    // The table itself: the six columns, ordered by seeders until told otherwise.
    assert.deepEqual(list.columns.map((c) => c.id), ["size", "files", "added", "seeders", "leechers", "source"]);
    assert.equal(list.showHeader, true);
    assert.equal(list.sortBy, "seeders");
    assert.equal(list.sortDir, "desc");
    // …and the header owns up to which facility the results came from: the web
    // sweep ran alongside qBittorrent here and returned nothing, which a bare
    // "1 results" would have hidden.
    assert.ok(
      nodes.some((n) => /^1 results — all from qBittorrent/.test(String(n.content || ""))),
      "no source breakdown in the results header"
    );
  }, undefined, { onFetch });
});

test("the engine summary is collapsed, and explains a search that found nothing", async () => {
  // The case it exists for: a plugin that reported a CONFIGURATION ERROR. Those
  // arrive as fake result rows (-1 size and swarm) which are never rendered as
  // torrents — so before this panel, "0 results" and "your indexer is broken"
  // looked identical on screen and the reason was in the console only.
  const results = {
    status: "Stopped",
    results: [
      { fileName: "invalid credentials — check your API key", fileUrl: "https://jackett/help", fileSize: -1, nbSeeders: -1, nbLeechers: -1, engineName: "jackett" },
    ],
  };
  const onFetch = (url) =>
    url.includes("/search/plugins") ? JSON.stringify([{ name: "jackett", enabled: true }])
      : url.includes("/search/start") ? JSON.stringify({ id: 7 })
        : url.includes("/search/results") ? JSON.stringify(results)
          : null;
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:search"]({ query: "artist album" });
    await settle();
    await settle();
    const nodes = () => walk(last(views));
    const toggle = nodes().find((n) => n.action === "qbt:engine-summary-toggle");
    assert.ok(toggle, "no engine summary");
    // Collapsed by default: the count and the failure tally, nothing else.
    // Both facilities are in the roster — the web sweep ran here too — so the
    // count is every engine asked, not just qBittorrent's.
    assert.match(toggle.label, /6 search engines/);
    assert.match(toggle.label, /· \d+ failed/);
    assert.ok(!nodes().some((n) => /check your API key/.test(String(n.content || ""))), "the panel was open");

    handlers["qbt:engine-summary-toggle"]();
    await settle();
    // Open, the indexer's own words are there — the failure a result row must
    // never be allowed to look like.
    assert.ok(nodes().some((n) => /jackett .* failed — invalid credentials/.test(String(n.content || ""))));
    // Each web indexer's response code is on its own row — the harness answers
    // 403 for one of them and serves the rest.
    assert.ok(nodes().some((n) => /HTTP \d{3}/.test(String(n.content || ""))), "no response codes");
    // …and the panel says once why the qBittorrent rows carry none.
    assert.ok(nodes().some((n) => /no response code of theirs/.test(String(n.content || ""))));
    // The rows are grouped by facility, each group headlining its own tally —
    // the two halves fail differently and are fixed in different places.
    const sections = nodes().filter((n) => n.type === "section");
    assert.ok(sections.some((s) => /^qBittorrent plugins — /.test(String(s.title))), "no qbt group");
    assert.ok(sections.some((s) => /^Web indexers — /.test(String(s.title))), "no web group");
    handlers["qbt:engine-summary-toggle"]();
    await settle();
    assert.ok(!nodes().some((n) => /check your API key/.test(String(n.content || ""))));
  }, undefined, { onFetch });
});

test("a web indexer's row links to the exact search it ran", async () => {
  // The one check a response code can't make on its own: a 403 or an empty 200
  // is either the site blocking us or the definition having gone stale, and
  // opening the same URL in a browser tells the two apart in one click.
  const onFetch = (url) =>
    url.includes("/search/plugins") ? JSON.stringify([{ name: "jackett", enabled: true }])
      : url.includes("/search/start") ? JSON.stringify({ id: 7 })
        : url.includes("/search/results") ? JSON.stringify({ status: "Stopped", results: [] })
          : null;
  await withPlugin(async ({ views, handlers, opened }) => {
    handlers["qbt:search"]({ query: "bjork homogenic" });
    await settle();
    await settle();
    handlers["qbt:engine-summary-toggle"]();
    await settle();
    const buttons = walk(last(views)).filter((n) => n.action === "qbt:open-engine-search");
    // One per bundled WEB indexer and no more: a qBittorrent plugin's request
    // is made inside qBittorrent, so there is no URL of ours to offer.
    assert.equal(buttons.length, loadPlugin()._WEB_DEFS.length);
    const urls = buttons.map((b) => b.data.url);
    // The URL carries the query as it was actually sent, percent-encoded.
    assert.ok(urls.some((u) => /apibay\.org.*bjork%20homogenic/.test(u)), urls.join(" "));

    handlers["qbt:open-engine-search"](buttons[0].data);
    await settle();
    assert.deepEqual(opened, [buttons[0].data.url]);
    // A button with nothing behind it must not reach the opener.
    handlers["qbt:open-engine-search"]({});
    await settle();
    assert.equal(opened.length, 1);
  }, undefined, { onFetch });
});

test("a header click re-orders the table without re-searching", async () => {
  const MB = 1024 * 1024;
  const results = {
    status: "Stopped",
    results: [
      { fileName: "big but dead", fileUrl: "https://x/a.torrent", fileSize: 900 * MB, nbSeeders: 2, nbLeechers: 0, engineName: "jackett", siteUrl: "https://rutracker.org/t/1" },
      { fileName: "small but alive", fileUrl: "https://x/b.torrent", fileSize: 120 * MB, nbSeeders: 400, nbLeechers: 9, engineName: "jackett", siteUrl: "https://rutracker.org/t/2" },
    ],
  };
  let starts = 0;
  const onFetch = (url) => {
    if (url.includes("/search/plugins")) return JSON.stringify([{ name: "jackett", enabled: true }]);
    if (url.includes("/search/start")) { starts++; return JSON.stringify({ id: 7 }); }
    if (url.includes("/search/results")) return JSON.stringify(results);
    return null;
  };
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:search"]({ query: "artist album" });
    await settle();
    await settle();
    const list = () => walk(last(views)).find((n) => n.type === "track-row-list");
    const order = () => list().items.map((r) => r.title);
    // Seeders descending until told otherwise — for a torrent that is the
    // difference between a download and a dead entry.
    assert.deepEqual(order(), ["small but alive", "big but dead"]);

    handlers["qbt:result-sort"]({ column: "size", direction: "desc" });
    await settle();
    assert.deepEqual(order(), ["big but dead", "small but alive"]);
    // The header shows which column it is on, so the order is never a mystery.
    assert.equal(list().sortBy, "size");
    assert.equal(list().sortDir, "desc");

    // Clicking the sorted column flips it; the host's suggested direction is
    // only a suggestion, and the plugin owns the state either way.
    handlers["qbt:result-sort"]({ column: "size", direction: "asc" });
    await settle();
    assert.deepEqual(order(), ["small but alive", "big but dead"]);
    assert.equal(list().sortDir, "asc");

    // A fresh TEXT column opens at A, not Z — "desc" is only the right default
    // for a number.
    handlers["qbt:result-sort"]({ column: "name", direction: "desc" });
    await settle();
    assert.equal(list().sortDir, "asc");
    assert.deepEqual(order(), ["big but dead", "small but alive"]);

    // An unknown column is ignored rather than blanking the order.
    handlers["qbt:result-sort"]({ column: "nonsense" });
    await settle();
    assert.equal(list().sortBy, "name");
    assert.equal(starts, 1, "sorting re-ran the search");
  }, undefined, { onFetch });
});

test("the results filter row narrows what's on screen without re-searching", async () => {
  const MB = 1024 * 1024;
  const results = {
    status: "Stopped",
    results: [
      { fileName: "Artist - Album [FLAC]", fileUrl: "https://x/a.torrent", fileSize: 400 * MB, nbSeeders: 120, nbLeechers: 2, engineName: "jackett", siteUrl: "https://rutracker.org/t/1" },
      { fileName: "Artist - Album [MP3]", fileUrl: "https://x/b.torrent", fileSize: 120 * MB, nbSeeders: 3, nbLeechers: 1, engineName: "jackett", siteUrl: "https://rutracker.org/t/2" },
    ],
  };
  let starts = 0;
  const onFetch = (url) => {
    if (url.includes("/search/plugins")) return JSON.stringify([{ name: "jackett", enabled: true }]);
    if (url.includes("/search/start")) { starts++; return JSON.stringify({ id: 7 }); }
    if (url.includes("/search/results")) return JSON.stringify(results);
    return null;
  };
  await withPlugin(async ({ views, handlers }) => {
    handlers["qbt:search"]({ query: "artist album" });
    await settle();
    await settle();
    const rows = () => (walk(last(views)).find((n) => n.type === "track-row-list") || { items: [] }).items;
    assert.equal(rows().length, 2);

    // The strip sits under the search box, and its text field is a LIVE filter
    // (no buttonLabel) — it narrows as you type rather than on a press.
    const strip = walk(last(views)).find((n) => n.action === "qbt:result-filter");
    assert.ok(strip, "no results filter box");
    assert.ok(!strip.buttonLabel, "the filter box waits for a button press");

    handlers["qbt:result-filter"]({ query: "flac" });
    await settle();
    assert.deepEqual(rows().map((r) => r.title), ["Artist - Album [FLAC]"]);
    // The count owns up to hiding rows, and NOTHING was re-fetched — this is a
    // second pass over results already in hand.
    assert.ok(walk(last(views)).some((n) => /^1 of 2 results/.test(String(n.content || ""))));
    assert.equal(starts, 1, "filtering re-ran the search");

    handlers["qbt:result-filter"]({ query: "" });
    handlers["qbt:result-seeders"]({ value: "100" });
    await settle();
    assert.deepEqual(rows().map((r) => r.title), ["Artist - Album [FLAC]"]);

    // Filtered down to nothing is not "nothing found": the rows are still
    // there, so the way out offered is the filters, not the query.
    handlers["qbt:result-size"]({ value: "gt20gb" });
    await settle();
    assert.equal(rows().length, 0);
    assert.ok(walk(last(views)).some((n) => /No result matches these filters/.test(String(n.content || ""))));
    handlers["qbt:result-filter-clear"]();
    await settle();
    assert.equal(rows().length, 2);
  }, undefined, { onFetch });
});

// --- A search peek is not a torrent -----------------------------------------
//
// "View contents" on a search result ADDS the torrent, paused, because that is
// the only way to read a file list. That add is an implementation detail of
// reading the result: the torrent must not turn up in the list (or its count,
// or the badge), and leaving the contents must return to the results and throw
// it away rather than strand a paused torrent nothing can reach any more.

const PEEK_HASH = "c".repeat(40);
const PEEK_MAGNET = "magnet:?xt=urn:btih:" + PEEK_HASH + "&dn=Peeked+Release";

function peekRun() {
  let added = false;
  const results = {
    status: "Stopped",
    results: [
      { fileName: "Peeked Release [FLAC]", fileUrl: PEEK_MAGNET, fileSize: 100, nbSeeders: 5, nbLeechers: 0, engineName: "jackett" },
    ],
  };
  return {
    onFetch: (url) => {
      // The add is what makes qBittorrent report the torrent from here on.
      if (url.includes("/torrents/add")) added = true;
      return url.includes("/search/plugins") ? JSON.stringify([{ name: "jackett", enabled: true }])
        : url.includes("/search/start") ? JSON.stringify({ id: 7 })
          : url.includes("/search/results") ? JSON.stringify(results)
            : null;
    },
    torrents: () => {
      if (!added) return TORRENTS;
      const withPeek = { ...TORRENTS };
      withPeek[PEEK_HASH] = {
        hash: PEEK_HASH,
        name: "Peeked Release [FLAC]",
        state: "pausedDL",
        progress: 0,
        size: 0,
        total_size: 500 * 1024 * 1024,
        added_on: 300,
        category: "viboplr",
      };
      return withPeek;
    },
  };
}

async function openPeek(handlers) {
  handlers["qbt:search"]({ query: "peeked release" });
  await settle();
  await settle();
  handlers["qbt:search-view"]({ itemId: PEEK_MAGNET });
  await settle();
  await settle();
}

test("a peeked search result never joins the torrent list", async () => {
  const { onFetch, torrents } = peekRun();
  await withPlugin(async ({ views, handlers }) => {
    await openPeek(handlers);
    const nodes = walk(last(views));
    assert.ok(
      nodes.some((n) => n.type === "detail-header" && /Peeked Release/.test(n.title || "")),
      "the contents never opened",
    );
    // The tab strip renders above the contents panel, so its count is visible
    // from here — and it counts the list the user would drop back into.
    const tabs = nodes.find((n) => n.type === "tabs" && n.action === "qbt:tab");
    assert.equal(tabs.tabs.find((t) => t.id === "torrents").count, 2, "the peek was counted as a torrent");
  }, undefined, { onFetch, torrents });
});

test("Back from a peek returns to the search results and discards the torrent", async () => {
  const { onFetch, torrents } = peekRun();
  await withPlugin(async ({ views, handlers, posts }) => {
    await openPeek(handlers);
    posts.length = 0;
    handlers["qbt:close-files"]();
    await settle();
    const nodes = walk(last(views));
    const tabs = nodes.find((n) => n.type === "tabs" && n.action === "qbt:tab");
    assert.equal(tabs.activeTab, "search", "Back landed somewhere other than the search results");
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.ok(list && list.items.some((i) => i.id === PEEK_MAGNET), "the results the peek came from didn't come back");
    // Nothing downloaded, and the row that could have removed it by hand is
    // gone with the list — so leaving has to clean it up.
    const del = posts.find((p) => p.url.includes("/torrents/delete"));
    assert.ok(del, "the peeked torrent was left behind in qBittorrent");
    assert.equal(del.form.hashes, PEEK_HASH);
    assert.equal(del.form.deleteFiles, "false", "a peek must never delete data the user already had");
  }, undefined, { onFetch, torrents });
});

test("starting a peeked torrent keeps it: Back then leads to the list that holds it", async () => {
  const { onFetch, torrents } = peekRun();
  await withPlugin(async ({ views, handlers, posts }) => {
    await openPeek(handlers);
    handlers["qbt:start"]({ hash: PEEK_HASH });
    await settle();
    posts.length = 0;
    handlers["qbt:close-files"]();
    await settle();
    const nodes = walk(last(views));
    const tabs = nodes.find((n) => n.type === "tabs" && n.action === "qbt:tab");
    assert.equal(tabs.activeTab, "torrents", "a download the user committed to sent them back to the search");
    assert.ok(!posts.some((p) => p.url.includes("/torrents/delete")), "removed a torrent the user had started");
    const list = nodes.find((n) => n.type === "track-row-list");
    assert.ok(list && list.items.some((i) => i.id === PEEK_HASH), "the started torrent never joined the list");
  }, undefined, { onFetch, torrents });
});

// --- A file list is only a progress figure while it is current ---------------
//
// The list badge sums the torrent's FILE list when it has one, which is more
// precise than the torrent's own figure. But only the open torrent's list is
// kept current — every other copy is a snapshot. Looking inside a download and
// coming back out used to pin its badge to whatever it read at that moment for
// the rest of the session.

// The two disagree on purpose, so the badge says which one it read: the file
// list is stuck at 20%, the torrent itself reports 80% downloaded.
const STALE_FILES = [{ index: 0, name: "01 - First.flac", size: 1000 * 1024 * 1024, progress: 0.2, priority: 1 }];
const MOVING = {
  aaa: {
    hash: "aaa",
    name: "Some Artist - Album (1998) [FLAC]",
    state: "downloading",
    progress: 0.8,
    completed: Math.round(0.8 * 1000 * 1024 * 1024),
    size: 1000 * 1024 * 1024,
    total_size: 1000 * 1024 * 1024,
    added_on: 200,
    category: "viboplr",
  },
};

// The percentage is baked into the row tile's data-URI SVG — the only place a
// row states it.
function tilePercent(imageUrl) {
  const svg = decodeURIComponent(String(imageUrl || "").replace(/^data:image\/svg\+xml[^,]*,/, ""));
  const m = /(\d+)%/.exec(svg);
  return m ? m[1] + "%" : null;
}
const rowPercent = (views) => {
  const list = walk(last(views)).find((n) => n.type === "track-row-list");
  return list ? tilePercent(list.items[0].imageUrl) : null;
};

test("a stale file list stops standing in for the torrent's own progress", async () => {
  await withPlugin(async ({ views, handlers }) => {
    // Never opened: nothing cached, so the row reads the torrent itself.
    assert.equal(rowPercent(views), "80%");

    // Look inside and come back out. The list just came from qBittorrent, so
    // it is the better figure and the badge uses it.
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    assert.equal(rowPercent(views), "20%", "a just-read file list should be what the badge counts");

    // Nothing refreshes that copy once the panel is shut, so a minute later it
    // is a record of the past and the torrent's live bytes answer instead.
    const realNow = Date.now;
    Date.now = () => realNow() + 60000;
    try {
      handlers["qbt:refresh"]();
      await settle();
      assert.equal(rowPercent(views), "80%", "the badge is still pinned to the file list it read a minute ago");
    } finally {
      Date.now = realNow;
    }
  }, undefined, { torrents: MOVING, files: () => STALE_FILES });
});

// The reported row, exactly: a release added through *View contents* — so its
// file list was read while the torrent was still empty — left to download, and
// now seeding. It read "Seeding · 12 files · 286 MB · ratio 0.00" behind a 0%
// badge, and nothing it ever did moved that number: the badge was counting a
// file list captured before a byte had arrived.
const SEED_SIZE = 286 * 1024 * 1024;

function seedFixtures() {
  let finished = false;
  return {
    finish: () => { finished = true; },
    torrents: () => ({
      aaa: {
        hash: "aaa",
        name: "[Bitsearch.to] The Sound - From the Lions Mouth (1981) [FLAC]",
        state: finished ? "stalledUP" : "downloading",
        progress: finished ? 1 : 0,
        completed: finished ? SEED_SIZE : 0,
        size: SEED_SIZE,
        total_size: SEED_SIZE,
        added_on: 200,
        category: "viboplr",
      },
    }),
    files: () => {
      const out = [];
      for (let i = 0; i < 12; i++) {
        out.push({ index: i, name: "CD1/" + (i + 1) + " - Track.flac", size: SEED_SIZE / 12, progress: finished ? 1 : 0, priority: 1 });
      }
      return out;
    },
  };
}

test("a torrent read while it was empty still reaches 100% once it has seeded", async () => {
  const fx = seedFixtures();
  await withPlugin(async ({ views, handlers }) => {
    // What "View contents" (and "choose which files download") does on the way
    // in: the file list is fetched and cached with every file at 0%.
    handlers["qbt:show-files"]({ itemId: "aaa" });
    await settle();
    handlers["qbt:close-files"]();
    await settle();
    assert.equal(rowPercent(views), "0%");

    // It downloads and starts seeding. Nothing re-reads that cached list —
    // the torrent's own bytes have to be what the badge counts by now.
    const realNow = Date.now;
    Date.now = () => realNow() + 600000;
    try {
      fx.finish();
      handlers["qbt:refresh"]();
      await settle();
      const row = walk(last(views)).find((n) => n.type === "track-row-list").items[0];
      assert.match(row.subtitle, /Seeding/, "fixture no longer describes a seeding torrent");
      assert.equal(rowPercent(views), "100%", "a finished, seeding torrent is still showing the 0% it was added at");
    } finally {
      Date.now = realNow;
    }
  }, undefined, { torrents: fx.torrents, files: fx.files });
});
