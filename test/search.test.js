const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const queryFor = plugin._searchQueryForTarget;

test("an album target searches artist + album", () => {
  // Artist first because indexers name releases that way: "Artist - Album [FLAC]".
  assert.equal(
    queryFor({ kind: "album", artistName: "Björk", albumTitle: "Homogenic" }),
    "Björk Homogenic",
  );
});

test("an artist target searches just the artist", () => {
  assert.equal(queryFor({ kind: "artist", artistName: "Autechre" }), "Autechre");
});

test("a track target searches its ALBUM, not its title", () => {
  // Searching one track's title finds single-track rips and misses the release
  // it came from — the album is the useful unit on an indexer.
  assert.equal(
    queryFor({ kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" }),
    "Björk Homogenic",
  );
});

test("a track with no album falls back to its title", () => {
  assert.equal(queryFor({ kind: "track", title: "Some Single", artistName: "Someone" }), "Someone Some Single");
});

test("missing fields are dropped rather than becoming blanks", () => {
  assert.equal(queryFor({ kind: "album", albumTitle: "Homogenic" }), "Homogenic");
  assert.equal(queryFor({ kind: "artist", artistName: "  " }), "");
  assert.equal(queryFor({}), "");
  assert.equal(queryFor(null), "");
});

test("siteLabel reduces an indexer URL to its host", () => {
  assert.equal(plugin._siteLabel("https://www.example-tracker.org/torrent/1"), "example-tracker.org");
  assert.equal(plugin._siteLabel("http://tracker.net:8080/x"), "tracker.net");
  assert.equal(plugin._siteLabel(""), "");
});

test("results are sorted by seeders", () => {
  // Seeders are the difference between a download and a dead entry.
  const sorted = plugin._sortSearchResults([
    { fileName: "a", nbSeeders: 3, fileSize: 100 },
    { fileName: "b", nbSeeders: 40, fileSize: 100 },
    { fileName: "c", nbSeeders: 0, fileSize: 100 },
  ]);
  assert.deepEqual(sorted.map((r) => r.fileName), ["b", "a", "c"]);
});

test("equal seeders break on size, so the order is stable", () => {
  // Otherwise the order depends on which indexer answered first, and the list
  // reshuffles under the user as more results stream in.
  const sorted = plugin._sortSearchResults([
    { fileName: "small", nbSeeders: 5, fileSize: 100 },
    { fileName: "big", nbSeeders: 5, fileSize: 900 },
  ]);
  assert.deepEqual(sorted.map((r) => r.fileName), ["big", "small"]);
});

test("sorting doesn't mutate the caller's array", () => {
  const input = [{ nbSeeders: 1 }, { nbSeeders: 9 }];
  plugin._sortSearchResults(input);
  assert.equal(input[0].nbSeeders, 1);
});

test("any column can order the table, in either direction", () => {
  const rows = [
    { fileName: "beta", fileSize: 200, nbFiles: 3, nbSeeders: 5, nbLeechers: 9, engineName: "jackett" },
    { fileName: "alpha", fileSize: 900, nbFiles: 1, nbSeeders: 1, nbLeechers: 2, engineName: "web:tpb" },
    { fileName: "gamma", fileSize: 500, nbFiles: 8, nbSeeders: 3, nbLeechers: 0, engineName: "web:nyaa" },
  ];
  const order = (by, dir) => plugin._sortSearchResults(rows, by, dir).map((r) => r.fileName);
  assert.deepEqual(order("size", "desc"), ["alpha", "gamma", "beta"]);
  assert.deepEqual(order("size", "asc"), ["beta", "gamma", "alpha"]);
  assert.deepEqual(order("files", "desc"), ["gamma", "beta", "alpha"]);
  assert.deepEqual(order("seeders", "desc"), ["beta", "gamma", "alpha"]);
  assert.deepEqual(order("leechers", "asc"), ["gamma", "alpha", "beta"]);
  assert.deepEqual(order("name", "asc"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(order("name", "desc"), ["gamma", "beta", "alpha"]);
  // Source sorts on facility first, then indexer: "qBittorrent plugin jackett"
  // against "web indexer Nyaa" / "web indexer The Pirate Bay".
  assert.deepEqual(order("source", "asc"), ["beta", "gamma", "alpha"]);
  // An unknown column can't blank or reorder the table — it falls back to the
  // default rather than comparing undefined against undefined.
  assert.deepEqual(order("nonsense", "desc"), order("seeders", "desc"));
  // No arguments at all is still the old, and default, behaviour.
  assert.deepEqual(plugin._sortSearchResults(rows).map((r) => r.fileName), order("seeders", "desc"));
});

test("rows the source said nothing about sink to the bottom either way", () => {
  // Sorting ascending by file count must not open the list with every row that
  // has no file count — that is the opposite of what was asked for.
  const rows = [
    { fileName: "known-1", nbFiles: 5, nbSeeders: 1 },
    { fileName: "unknown", nbSeeders: 1 },
    { fileName: "known-2", nbFiles: 2, nbSeeders: 1 },
  ];
  const order = (dir) => plugin._sortSearchResults(rows, "files", dir).map((r) => r.fileName);
  assert.deepEqual(order("asc"), ["known-2", "known-1", "unknown"]);
  assert.deepEqual(order("desc"), ["known-1", "known-2", "unknown"]);
});

test("a result row is one line — no subtitle at all", () => {
  // Every fact it used to carry has a column now, including the facility (the
  // Source cell's prefix), so a second line would restate the row above it at
  // half the size and double every row's height.
  const row = plugin._searchResultRow({
    fileName: "Artist - Album [FLAC]",
    fileSize: 1024 * 1024 * 500,
    nbSeeders: 12,
    nbLeechers: 3,
    engineName: "jackett",
    siteUrl: "https://example.org",
  });
  assert.equal(row.subtitle, undefined);
});

test("the cells carry the figures, and unknown stays empty", () => {
  const cells = plugin._searchResultCells({
    fileSize: 1024 * 1024 * 500,
    nbFiles: 12,
    nbSeeders: 40,
    nbLeechers: 0,
    engineName: "web:tpb",
  });
  // formatBytes drops the decimal at 10 units and up, so this is "500 MB".
  assert.deepEqual(cells, {
    size: "500 MB",
    files: "12",
    added: "",
    seeders: "40",
    leechers: "0",
    source: "web · The Pirate Bay",
  });
  // Zero is a real leecher count and prints; -1 and absent are "didn't report"
  // and print nothing, which the host renders as an em dash. A cell that said
  // "0" for an unreported figure would be a verdict the source never gave.
  const unknown = plugin._searchResultCells({ nbSeeders: -1, nbLeechers: -1 });
  assert.equal(unknown.seeders, "");
  assert.equal(unknown.leechers, "");
  assert.equal(unknown.size, "");
  assert.equal(unknown.files, "");
  assert.equal(unknown.added, "");
});

test("the Added cell is a relative age, sorted by the raw timestamp", () => {
  // The cell shows "N ... ago" (formatAge); a missing date is an em dash, not
  // "just now" or the epoch.
  const cells = plugin._searchResultCells({ added: Math.floor(Date.now() / 1000) - 3 * 86400 });
  assert.match(cells.added, /3 days ago/);
  assert.equal(plugin._searchResultCells({}).added, "");
  // Sorting keys off the raw seconds, so newest-first is a plain numeric
  // descending — and rows with no date sink to the bottom either way.
  const rows = [
    { fileName: "old", added: 1000, nbSeeders: 1 },
    { fileName: "new", added: 9000, nbSeeders: 1 },
    { fileName: "undated", nbSeeders: 1 },
  ];
  const order = (dir) => plugin._sortSearchResults(rows, "added", dir).map((r) => r.fileName);
  assert.deepEqual(order("desc"), ["new", "old", "undated"]);
  assert.deepEqual(order("asc"), ["old", "new", "undated"]);
});

test("parseDate normalises every shape an indexer ships a date in", () => {
  const d = plugin._parseDate;
  // Raw unix — seconds pass through, milliseconds are folded to seconds.
  assert.equal(d("1363971375"), 1363971375);
  assert.equal(d("1363971375000"), 1363971375);
  // 1337x's awkward form: abbreviated month, ordinal suffix, 2-digit year.
  assert.ok(d("Mar. 3rd '18") > 0);
  // RFC-822 (nyaa), M/D/Y (bitsearch), and a plain datetime (rargb) all parse.
  assert.ok(d("Mon, 17 Aug 2026 12:35:04 -0000") > 0);
  assert.ok(d("2/22/2024") > 0);
  assert.ok(d("2026-08-08 09:06:09") > 0);
  // Newer sorts after older regardless of the source format.
  assert.ok(d("2/22/2024") < d("2026-08-08 09:06:09"));
  // Anything unreadable is null, so the column shows "—" not a wrong date.
  assert.equal(d("not a date"), null);
  assert.equal(d(""), null);
  assert.equal(d(null), null);
});

// --- the per-engine summary ---------------------------------------------------

const RAN = [
  { key: "web:tpb", name: "The Pirate Bay", facility: "web indexer", url: "https://apibay.org/q.php?q=bjork" },
  { key: "web:x1337", name: "1337x", facility: "web indexer", url: "https://1337x.to/search/bjork/" },
  { key: "jackett", name: "jackett", facility: "qBittorrent plugin" },
];

test("the summary counts every engine that ran, including the silent ones", () => {
  const rows = [
    { engineName: "web:tpb" },
    { engineName: "web:tpb" },
    { engineName: "jackett" },
  ];
  const out = plugin._searchEngineSummary(rows, RAN, { "web:x1337": "HTTP 403" }, { "web:tpb": 200, "web:x1337": 403 });
  // Failures first — they are why anyone opens this — then by contribution.
  assert.deepEqual(out.map((r) => r.key), ["web:x1337", "web:tpb", "jackett"]);
  assert.deepEqual(out.map((r) => r.count), [0, 2, 1]);
  // An engine that was asked and returned nothing is the case the merged list
  // cannot show at all: it looks exactly like an engine nobody asked.
  assert.equal(out[0].error, "HTTP 403");
  // The code leads, and isn't then repeated by the error text that IS the
  // code. No facility parenthetical — the rows render under facility group
  // headings, so naming it per line would restate the heading.
  assert.equal(plugin._searchEngineSummaryLine(out[0]), "1337x — HTTP 403 · failed");
  assert.equal(plugin._searchEngineSummaryLine(out[1]), "The Pirate Bay — HTTP 200 · 2 results");
  // A qBittorrent plugin has no code of its own — the plugin never talks to
  // that indexer, qBittorrent does — so its row claims none.
  assert.equal(plugin._searchEngineSummaryLine(out[2]), "jackett — 1 result");
});

test("a summary line separates 'answered badly' from 'never answered'", () => {
  const line = plugin._searchEngineSummaryLine;
  // 200 with nothing in it: the site is up and the definition's selectors have
  // gone stale — a different fix from a bot wall, and invisible without a code.
  assert.equal(
    line({ name: "nyaa", facility: "web indexer", count: 0, error: null, status: 200 }),
    "nyaa — HTTP 200 · no results"
  );
  // No code at all: a timeout or a DNS failure. The reason still shows.
  assert.equal(
    line({ name: "nyaa", facility: "web indexer", count: 0, error: "timed out", status: 0 }),
    "nyaa — no response · failed — timed out"
  );
  assert.equal(
    line({ name: "x", facility: "web indexer", count: 1, error: null, status: 200 }),
    "x — HTTP 200 · 1 result"
  );
});

test("an engine that hasn't answered yet is pending, not 'no results'", () => {
  // Both facilities searching, nothing back yet: every verdict — "no results",
  // "no response" — is an answer the engines haven't given.
  const running = plugin._searchEngineSummary([], RAN, {}, {}, { qbt: true, web: true });
  const byKey = {};
  running.forEach((r) => { byKey[r.key] = r; });
  assert.ok(byKey["web:tpb"].pending);
  assert.ok(byKey["jackett"].pending);
  assert.equal(plugin._searchEngineSummaryLine(byKey["web:tpb"]), "The Pirate Bay — searching…");

  // A web indexer settles INDIVIDUALLY the moment its own fetch answers, even
  // a settled "0" (a timeout) — that is an answer, not a wait.
  const half = plugin._searchEngineSummary([], RAN, {}, { "web:tpb": 200, "web:x1337": 0 }, { qbt: false, web: true });
  const byKey2 = {};
  half.forEach((r) => { byKey2[r.key] = r; });
  assert.ok(!byKey2["web:tpb"].pending);
  assert.equal(plugin._searchEngineSummaryLine(byKey2["web:tpb"]), "The Pirate Bay — HTTP 200 · no results");
  assert.ok(!byKey2["web:x1337"].pending);
  assert.match(plugin._searchEngineSummaryLine(byKey2["web:x1337"]), /no response/);

  // qBittorrent reports the JOB, not its plugins, so a qbt engine stays
  // pending until the job completes — and one with rows already says "so far",
  // because more may land on the next poll.
  const streaming = plugin._searchEngineSummary(
    [{ engineName: "jackett" }, { engineName: "jackett" }],
    RAN, {}, {}, { qbt: true, web: false }
  );
  const jk = streaming.filter((r) => r.key === "jackett")[0];
  assert.ok(jk.pending);
  assert.equal(plugin._searchEngineSummaryLine(jk), "jackett — 2 results so far…");

  // An engine that already FAILED is settled whatever the facility is doing.
  const failedRow = plugin._searchEngineSummary([], RAN, { "web:x1337": "HTTP 403" }, { "web:x1337": 403 }, { qbt: true, web: true })
    .filter((r) => r.key === "web:x1337")[0];
  assert.ok(!failedRow.pending);

  // No activity argument at all (a finished search) — nothing is pending.
  const settled = plugin._searchEngineSummary([], RAN, {}, {});
  assert.ok(settled.every((r) => !r.pending));
});

test("a facility group's tally is its shared story", () => {
  const tally = plugin._engineGroupTally;
  assert.equal(tally([{ count: 2 }, { count: 1 }]), "3 results");
  assert.equal(tally([{ count: 1 }]), "1 result");
  // Results win even while some rows are pending — they are already real.
  assert.equal(tally([{ count: 2, pending: true }, { count: 0, pending: true }]), "2 results");
  assert.equal(tally([{ count: 0, pending: true }, { count: 0, pending: true }]), "searching…");
  assert.equal(tally([{ count: 0, error: "HTTP 403" }, { count: 0, error: "down" }]), "all failed");
  // Mixed emptiness — one failed, one legitimately empty — is just no results.
  assert.equal(tally([{ count: 0, error: "HTTP 403" }, { count: 0 }]), "no results");
});

test("each row carries the search URL it ran, where there is one", () => {
  const out = plugin._searchEngineSummary([{ engineName: "web:tpb" }], RAN, {}, {});
  const byKey = {};
  out.forEach((r) => { byKey[r.key] = r; });
  assert.equal(byKey["web:tpb"].url, "https://apibay.org/q.php?q=bjork");
  // A qBittorrent plugin's request happens inside qBittorrent — we never see
  // its URL, and offering a button that opens nothing would be worse than none.
  assert.equal(byKey["jackett"].url, null);
});

test("an engine that answered but was never declared still gets a row", () => {
  // A qBittorrent plugin can return rows under a name that isn't in
  // /search/plugins. Dropping those rows' engine would leave results in the
  // list that the summary says nobody produced.
  const out = plugin._searchEngineSummary([{ engineName: "surprise" }], RAN, {});
  const extra = out.filter((r) => r.key === "surprise");
  assert.equal(extra.length, 1);
  assert.equal(extra[0].count, 1);
  assert.equal(extra[0].facility, "qBittorrent plugin");
  // …and it is listed once, not twice, when it WAS declared.
  const dup = plugin._searchEngineSummary([{ engineName: "jackett" }], RAN, {});
  assert.equal(dup.filter((r) => r.key === "jackett").length, 1);
});

test("nothing asked and nothing answered means no panel", () => {
  assert.deepEqual(plugin._searchEngineSummary([], [], {}), []);
});

test("the columns are the ones asked for, numbers right-aligned", () => {
  const cols = plugin._SEARCH_COLUMNS;
  // Name is the row's own title — the one column that flexes — so it is not
  // declared here. Added sits with the file facts, before the swarm.
  assert.deepEqual(cols.map((c) => c.id), ["size", "files", "added", "seeders", "leechers", "source"]);
  assert.ok(cols.every((c) => c.sortable), "a column nobody can sort by is just text");
  assert.deepEqual(
    cols.filter((c) => c.align === "right").map((c) => c.id),
    ["size", "files", "added", "seeders", "leechers"]
  );
});

test("a search result is identified by URL, not by position", () => {
  // Results stream in and re-sort by seeders on every poll, so an index captured
  // when a row was drawn can point at a different result — or past the end — by
  // the time it is clicked.
  assert.equal(
    plugin._searchResultId({ fileUrl: "https://x/y.torrent", fileName: "Album" }),
    "https://x/y.torrent",
  );
});

test("a result with no download link still gets an id", () => {
  // It needs one to be clickable at all; the click then explains itself rather
  // than silently doing nothing.
  assert.equal(plugin._searchResultId({ descrLink: "https://x/page", fileName: "Album" }), "https://x/page");
  assert.equal(plugin._searchResultId({ fileName: "Album" }), "Album");
  assert.equal(plugin._searchResultId(null), "");
});

test("rowIds keeps ids as strings", () => {
  // rowIndices would parseInt a URL into NaN and drop the click.
  assert.deepEqual(plugin._rowIds({ selectedIds: ["https://x/y.torrent"] }), ["https://x/y.torrent"]);
  assert.deepEqual(plugin._rowIds({ itemId: "https://x/y.torrent" }), ["https://x/y.torrent"]);
  assert.deepEqual(plugin._rowIds({ selectedIds: ["a", "b"] }), ["a", "b"]);
});

test("rowIds yields nothing when there is nothing to act on", () => {
  assert.deepEqual(plugin._rowIds({}), []);
  assert.deepEqual(plugin._rowIds(null), []);
  assert.deepEqual(plugin._rowIds({ itemId: "" }), []);
});

test("a result missing everything still renders", () => {
  // Indexers vary in what they report; a missing field must not break the row.
  // The cells carry the em dashes, so nothing has to invent a placeholder line.
  assert.equal(plugin._searchResultRow({}).title, "(untitled)");
  assert.equal(plugin._searchResultCells({}).source, "");
});

test("an unreported swarm is unknown, not zero", () => {
  // Indexers send -1 for "didn't report". "0 seeders" is a verdict on the
  // torrent and would send the user straight past a live result.
  assert.equal(plugin._swarmCount(-1), null);
  assert.equal(plugin._swarmCount(undefined), null);
  assert.equal(plugin._swarmCount(""), null);
  assert.equal(plugin._swarmCount(0), 0);
  assert.equal(plugin._swarmCount("42"), 42);
  assert.equal(plugin._searchResultCells({ nbSeeders: -1, nbLeechers: -1 }).seeders, "");
});

test("a result row leads with the name and puts every figure in a cell", () => {
  const row = plugin._searchResultRow({
    fileName: "Some Artist - Album (1998) [FLAC]",
    fileUrl: "https://x/y.torrent",
    fileSize: 1024 * 1024 * 500,
    nbSeeders: 12,
    nbLeechers: 3,
  });
  assert.equal(row.title, "Some Artist - Album (1998) [FLAC]");
  assert.equal(row.id, "https://x/y.torrent");
  assert.equal(row.cells.size, "500 MB");
  assert.equal(row.cells.seeders, "12");
  assert.equal(row.cells.leechers, "3");
  // `duration` was where size used to ride. With a Size column it must NOT be
  // set as well, or the same number is printed twice on one row.
  assert.equal(row.duration, undefined);
});

test("a result row opens its contents on click-the-title, double-click and Enter", () => {
  // The row's action is View contents (adds paused — look before committing),
  // matching the torrent list; Download stays a deliberate overlay/toolbar
  // press, never the side effect of a plain click. Without a per-row action the
  // host's selectable list only SELECTS on click, which is what got this list
  // replaced with a stack of cards the first time round.
  assert.equal(plugin._searchResultRow({ fileName: "x", fileUrl: "https://x/y" }).action, "qbt:search-view");
});

// --- naming the search facility ----------------------------------------------

test("engineLabel names the facility that produced a result", () => {
  // Web rows carry "web:<id>" — name the indexer definition; a qBittorrent
  // search plugin's engineName is already the honest label; no engine, no
  // claim.
  assert.equal(plugin._engineLabel({ engineName: "web:tpb" }), "The Pirate Bay");
  assert.equal(plugin._engineLabel({ engineName: "web:nonsense" }), "nonsense");
  assert.equal(plugin._engineLabel({ engineName: "jackett" }), "jackett");
  assert.equal(plugin._engineLabel({}), "");
});

test("the Source cell names the facility and the indexer, facility first", () => {
  // Both halves in one cell, and the facility leads so that sorting by Source
  // GROUPS the two — every "web · …" together — instead of interleaving them
  // alphabetically by indexer.
  assert.equal(
    plugin._searchSourceCell({ engineName: "jackett", siteUrl: "https://rutracker.org/t/1" }),
    "qBT · jackett"
  );
  assert.equal(plugin._searchSourceCell({ engineName: "web:tpb" }), "web · The Pirate Bay");
  // No engine, no claim — an empty cell, which the host draws as an em dash.
  assert.equal(plugin._searchSourceCell({}), "");
});

test("the row tells the two facilities apart", () => {
  // The whole point: both facilities cover the same trackers, so the same site
  // in the same merged list can be reached two different ways, and without
  // this the user cannot tell a qBittorrent search plugin's row from a row this
  // plugin scraped itself.
  const web = { nbSeeders: 9, engineName: "web:tpb", siteUrl: "https://thepiratebay.org" };
  assert.equal(plugin._searchResultCells(web).source, "web · The Pirate Bay");
  const qbt = { nbSeeders: 9, engineName: "piratebay", siteUrl: "https://thepiratebay.org" };
  assert.equal(plugin._searchResultCells(qbt).source, "qBT · piratebay");
  assert.ok(plugin._isWebResult({ engineName: "web:tpb" }));
  assert.ok(!plugin._isWebResult({ engineName: "piratebay" }));
  assert.ok(!plugin._isWebResult({}));
});

test("the results header counts each facility's contribution", () => {
  const counts = plugin._searchResultCounts([
    { engineName: "web:tpb" },
    { engineName: "web:nyaa" },
    { engineName: "jackett" }
  ]);
  assert.deepEqual(counts, { total: 3, web: 2, qbt: 1 });

  // A facility that returned nothing is the case worth naming — it reads as a
  // thin query otherwise.
  assert.equal(plugin._searchResultBreakdown(counts, true, true), "1 from qBittorrent, 2 from websites");
  assert.equal(
    plugin._searchResultBreakdown({ total: 4, web: 4, qbt: 0 }, true, true),
    "all from websites"
  );
  assert.equal(
    plugin._searchResultBreakdown({ total: 4, web: 0, qbt: 4 }, true, true),
    "all from qBittorrent"
  );
  // Only one facility was asked, so a breakdown says nothing.
  assert.equal(plugin._searchResultBreakdown({ total: 4, web: 4, qbt: 0 }, false, true), "");
  assert.equal(plugin._searchResultBreakdown({ total: 0, web: 0, qbt: 0 }, true, true), "");
});

test("the spinner names both facilities, singular or plural", () => {
  assert.equal(plugin._searchSourceSummary(4, 3), "4 qBittorrent plugins and 3 websites");
  assert.equal(plugin._searchSourceSummary(1, 1), "1 qBittorrent plugin and 1 website");
  // Each half stands alone — the web sweep runs with no qBittorrent plugins
  // installed, and finishes independently of them.
  assert.equal(plugin._searchSourceSummary(0, 2), "2 websites");
  assert.equal(plugin._searchSourceSummary(2, 0), "2 qBittorrent plugins");
  assert.equal(plugin._searchSourceSummary(0, 0), "");
});

test("a nameless result still renders a row", () => {
  const row = plugin._searchResultRow({ fileUrl: "https://x/y.torrent" });
  assert.equal(row.title, "(untitled)");
  // Every cell empty — the host draws the em dashes, one rule for the whole
  // table rather than a placeholder invented per field.
  assert.deepEqual(row.cells, { size: "", files: "", added: "", seeders: "", leechers: "", source: "" });
});

// --- media classification (the row thumbnail) --------------------------------

test("release tags say whether a result is audio or video", () => {
  const kind = plugin._classifyTorrentMedia;
  assert.equal(kind("Some Artist - Album (1998) [FLAC]"), "audio");
  assert.equal(kind("Artist - Discography 1990-2020 MP3 320kbps"), "audio");
  assert.equal(kind("Pink Floyd - The Wall (1982) [24bit 96kHz Vinyl]"), "audio");
  assert.equal(kind("Some.Movie.2021.2160p.UHD.BluRay.x265-GROUP"), "video");
  assert.equal(kind("Show.S01E05.720p.HDTV"), "video");
});

test("video wins when a release carries both", () => {
  // A concert Blu-ray with a FLAC track is still four gigabytes of video.
  // Calling it audio would promise an album and deliver footage.
  assert.equal(plugin._classifyTorrentMedia("Artist - Live At Wembley 1080p BluRay x264 FLAC"), "video");
});

test("a name with no format tags is unknown, not guessed", () => {
  assert.equal(plugin._classifyTorrentMedia("Artist - Album 2020"), null);
  assert.equal(plugin._classifyTorrentMedia("Artist - Album [WEB] (2021)"), null);
  assert.equal(plugin._classifyTorrentMedia(""), null);
  assert.equal(plugin._classifyTorrentMedia(null), null);
});

test("tags are matched as whole tokens, not as substrings", () => {
  // The two that bite: "24k" is not the 4K tag, and "Waves" is not WAV.
  assert.equal(plugin._classifyTorrentMedia("24k Magic - Bruno Mars"), null);
  assert.equal(plugin._classifyTorrentMedia("Waves - Album 2019"), null);
});

test("a single-file torrent falls back to its extension", () => {
  // Torrents are routinely named after the one file inside them, and an
  // extension is evidence when no release tag is present.
  assert.equal(plugin._classifyTorrentMedia("Artist - Song.flac"), "audio");
  assert.equal(plugin._classifyTorrentMedia("Artist - Song.mkv"), "video");
});

test("every row gets an icon, including the unknown ones", () => {
  // The initials the host draws otherwise are two arbitrary letters of a release
  // name, repeated down the list. A blank column would be no better.
  const audio = plugin._mediaIconFor("audio");
  const video = plugin._mediaIconFor("video");
  const unknown = plugin._mediaIconFor(null);
  for (const uri of [audio, video, unknown]) {
    assert.ok(uri.startsWith("data:image/svg+xml,"), uri.slice(0, 40));
    // Percent-encoded, or the '#' of the colour would truncate it as a fragment.
    assert.ok(!/[<>#"]/.test(uri), uri.slice(0, 80));
    assert.match(decodeURIComponent(uri.slice("data:image/svg+xml,".length)), /^<svg [^>]*viewBox=/);
  }
  assert.notEqual(audio, video);
  assert.equal(plugin._mediaIconFor("nonsense"), unknown);
});

test("a result row carries the media icon as its image", () => {
  const row = plugin._searchResultRow({ fileName: "Artist - Album [FLAC]", fileUrl: "https://x/y.torrent" });
  assert.equal(row.imageUrl, plugin._mediaIconFor("audio"));
});

// --- seeder badge ------------------------------------------------------------

test("the seeder badge bands at >100 and >10", () => {
  // Green above 100, yellow above 10, red at or below. The boundaries are
  // strict: 100 is not "over 100".
  assert.equal(plugin._seedBand(101).fill, plugin._seedBand(5000).fill);
  assert.equal(plugin._seedBand(100).fill, plugin._seedBand(11).fill);
  assert.equal(plugin._seedBand(10).fill, plugin._seedBand(0).fill);
  // Three distinct colours, not two.
  const fills = new Set([plugin._seedBand(101).fill, plugin._seedBand(50).fill, plugin._seedBand(1).fill]);
  assert.equal(fills.size, 3);
});

test("an unknown swarm is grey, not red", () => {
  // "The indexer didn't report" is not a verdict on the torrent. Red would
  // condemn results that may be perfectly healthy.
  const unknown = plugin._seedBand(null);
  assert.equal(unknown.fill, plugin._seedBand(undefined).fill);
  for (const n of [0, 5, 50, 500]) assert.notEqual(unknown.fill, plugin._seedBand(n).fill);
});

test("every band's digits contrast against its own fill", () => {
  // The yellow that reads as yellow needs dark text where the other two need
  // light — one shared text colour makes at least one badge unreadable.
  for (const seeds of [500, 50, 1, null]) {
    const band = plugin._seedBand(seeds);
    assert.notEqual(band.text, band.fill);
    assert.match(band.fill, /^#[0-9a-f]{6}$/);
  }
});

test("seeder counts stay within four characters", () => {
  assert.equal(plugin._formatSeedCount(0), "0");
  assert.equal(plugin._formatSeedCount(999), "999");
  assert.equal(plugin._formatSeedCount(1234), "1.2k");
  assert.equal(plugin._formatSeedCount(9999), "9.9k");
  assert.equal(plugin._formatSeedCount(99999), "100k");
  assert.equal(plugin._formatSeedCount(null), "?");
  for (const n of [0, 7, 42, 999, 1234, 99999, null]) {
    assert.ok(plugin._formatSeedCount(n).length <= 4, String(n));
  }
});

test("the tile draws the label and the band colour", () => {
  const svg = plugin._mediaTileSvg("audio", "1.2k", plugin._seedBand(1234));
  assert.match(svg, />1\.2k</);
  assert.match(svg, new RegExp(plugin._seedBand(1234).fill));
  // The glyph is still there — the badge is added to the tile, not instead of it.
  assert.match(svg, /<circle/);
});

test("an unlabelled tile is the glyph alone — no badge, no colour band", () => {
  // The seeder badge these tiles used to carry is the Seeders column now. A
  // coloured bar with no number on it would be a mystery, so the two went
  // together.
  const svg = plugin._mediaTileSvg("audio", "", null);
  assert.match(svg, /<circle/, "the media glyph must survive");
  assert.ok(!/<rect/.test(svg), "the badge is still being drawn");
  assert.ok(!/<text/.test(svg), "the tile is still printing a number");
});

test("a result row's tile says what kind of thing it is, and nothing else", () => {
  const audio = plugin._searchResultRow({ fileName: "Artist - Album [FLAC]", nbSeeders: 250 });
  const video = plugin._searchResultRow({ fileName: "Artist - Live 1080p x265", nbSeeders: 4 });
  assert.equal(audio.imageUrl, plugin._mediaIconFor("audio"));
  assert.notEqual(audio.imageUrl, video.imageUrl);
  // Two results of the same kind now share one tile whatever their swarm —
  // which is the point, and also what keeps the cache from growing per row.
  assert.equal(
    plugin._searchResultRow({ fileName: "Other - Album [MP3]", nbSeeders: 9 }).imageUrl,
    audio.imageUrl
  );
});

// --- filtering a result set ---------------------------------------------------

const MB = 1024 * 1024;
const GB = 1024 * MB;
const ROWS = [
  { fileName: "Artist - Album (1998) [FLAC]", fileSize: 400 * MB, nbSeeders: 120, engineName: "web:tpb", siteUrl: "https://thepiratebay.org" },
  { fileName: "Artist - Album (1998) [MP3 320]", fileSize: 120 * MB, nbSeeders: 4, engineName: "jackett", siteUrl: "https://rutracker.org/t/1" },
  { fileName: "Artist - Live At Wembley 2160p", fileSize: 30 * GB, nbSeeders: 60, engineName: "web:x1337", siteUrl: "https://1337x.to" },
  // Neither figure reported — the case both bands have to decide about.
  { fileName: "Artist - Bootleg", nbSeeders: -1, engineName: "jackett", siteUrl: "https://rutracker.org/t/2" },
];

const names = (rows) => rows.map((r) => r.fileName);

test("no filter set returns the rows untouched", () => {
  const out = plugin._filterSearchResults(ROWS, { text: "", minSeeders: 0, sizeBand: "any", source: "any" });
  assert.deepEqual(names(out), names(ROWS));
  assert.notEqual(out, ROWS, "the caller's array was handed back to be mutated");
  assert.ok(!plugin._searchFilterActive({ text: " ", minSeeders: 0, sizeBand: "any", source: "any" }));
});

test("the text box matches the whole row, not just the release name", () => {
  // The indexer and the site are on screen, so they are what a user types.
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { text: "flac" })), [ROWS[0].fileName]);
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { text: "rutracker" })), [ROWS[1].fileName, ROWS[3].fileName]);
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { text: "pirate bay" })), [ROWS[0].fileName]);
  // Terms are ANDed, like every other filter box in the plugin.
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { text: "artist wembley" })), [ROWS[2].fileName]);
});

test("the seeder band drops rows that can't make the claim", () => {
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { minSeeders: 20 })), [ROWS[0].fileName, ROWS[2].fileName]);
  // -1 is "didn't report", and unknown is not "at least one": letting it pass
  // would put the rows the band exists to hide back in a seeder-sorted list.
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { minSeeders: 1 })), [ROWS[0].fileName, ROWS[1].fileName, ROWS[2].fileName]);
});

test("the size band is half-open, and an unknown size fails it", () => {
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { sizeBand: "250mb-1gb" })), [ROWS[0].fileName]);
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { sizeBand: "lt250mb" })), [ROWS[1].fileName]);
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { sizeBand: "gt20gb" })), [ROWS[2].fileName]);
  // A row sitting exactly on a boundary belongs to the band above it, once.
  const at1gb = [{ fileName: "x", fileSize: GB, nbSeeders: 1 }];
  assert.equal(plugin._filterSearchResults(at1gb, { sizeBand: "250mb-1gb" }).length, 0);
  assert.equal(plugin._filterSearchResults(at1gb, { sizeBand: "1-5gb" }).length, 1);
  // An unrecognized band id falls back to "any" rather than blanking the list.
  assert.equal(plugin._searchSizeBand("nonsense").value, "any");
});

test("the source picker splits the two facilities", () => {
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { source: "web" })), [ROWS[0].fileName, ROWS[2].fileName]);
  assert.deepEqual(names(plugin._filterSearchResults(ROWS, { source: "qbt" })), [ROWS[1].fileName, ROWS[3].fileName]);
});

test("the filters compose", () => {
  const out = plugin._filterSearchResults(ROWS, { text: "artist", minSeeders: 5, sizeBand: "250mb-1gb", source: "web" });
  assert.deepEqual(names(out), [ROWS[0].fileName]);
});
