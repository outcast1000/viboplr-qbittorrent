const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const runDefOnBody = plugin._runDefOnBody;
const webSearchAll = plugin._webSearchAll;
const resolveWebFileUrl = plugin._resolveWebFileUrl;
const downloaderFor = plugin._downloaderFor;
const WEB_DEFS = plugin._WEB_DEFS;

const fix = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const defById = (id) => WEB_DEFS.filter((d) => d.id === id)[0];

// Each bundled definition is pinned against a saved page. These are the tests
// that will catch a site redesign (or a parser regression) as a failing build
// rather than a silent zero-results search.

test("tpb (json): rows, magnet, byte-exact size, seeders", () => {
  const rows = runDefOnBody(defById("tpb"), fix("apibay-search.json"));
  assert.equal(rows.length, 10);
  const first = rows[0];
  assert.equal(first.fileName, "Bjork - Homogenic [24 bit FLAC] vinyl");
  assert.ok(first.fileUrl.indexOf("magnet:?xt=urn:btih:01bd238659b63d72459c692bbc2c98dca87e6948") === 0, first.fileUrl);
  assert.ok(first.fileUrl.indexOf("dn=Bjork") !== -1);
  assert.ok(first.fileUrl.indexOf("tr=udp") !== -1);
  assert.equal(first.fileSize, 1780833330);
  assert.equal(first.nbSeeders, 10);
  assert.equal(first.nbLeechers, 0);
  assert.equal(first.engineName, "web:tpb");
  assert.ok(first.descrLink.indexOf("description.php?id=") !== -1);
});

test("tpb (json): the empty-search sentinel yields NO rows", () => {
  const rows = runDefOnBody(defById("tpb"), fix("apibay-empty.json"));
  assert.equal(rows.length, 0);
});

test("nyaa (rss): item extraction incl. namespaced tags", () => {
  const rows = runDefOnBody(defById("nyaa"), fix("nyaa-search.xml"));
  assert.equal(rows.length, 6);
  const first = rows[0];
  assert.ok(first.fileName.length > 10);
  assert.ok(first.fileUrl.indexOf("https://nyaa.si/download/") === 0);
  assert.ok(first.fileUrl.indexOf(".torrent") !== -1);
  assert.equal(first.nbSeeders, 21);
  assert.equal(first.nbLeechers, 11);
  assert.equal(first.fileSize, Math.round(1.1 * 1073741824));
  assert.equal(first.engineName, "web:nyaa");
});

test("x1337 (html + magnetFollow): rows, size regex, deferred magnet", () => {
  const rows = runDefOnBody(defById("x1337"), fix("1337x-search.html"));
  assert.equal(rows.length, 3);
  const first = rows[0];
  // :nth-child(2) skipped the icon link and took the name link.
  assert.equal(first.fileName, "Bjork - Homogenic (1997) [FLAC]");
  assert.equal(first.nbSeeders, 41);
  assert.equal(first.nbLeechers, 7);
  // The size cell embedded a completed-count span; the regex took the size.
  assert.equal(first.fileSize, Math.round(1.4 * 1073741824));
  // No magnet on the list page: fileUrl is the detail URL, flagged for follow.
  assert.equal(first.webFollow, "x1337");
  assert.ok(first.fileUrl.indexOf("https://1337x.to/torrent/5551212/") === 0, first.fileUrl);
  // The tag-soup third row (unclosed tds) still parses cleanly, with the
  // comma-decimal size — the name doesn't bleed into the next cell.
  assert.equal(rows[2].fileName, "Bjork - Vespertine (2001) [24-96 vinyl]");
  assert.equal(rows[2].fileSize, Math.round(2.1 * 1073741824));
});

test("x1337 magnet-follow resolves the detail page to a magnet", async () => {
  const rows = runDefOnBody(defById("x1337"), fix("1337x-search.html"));
  const stub = async () => ({ status: 200, text: async () => fix("1337x-detail.html") });
  const resolved = await resolveWebFileUrl(rows[0], stub);
  assert.ok(resolved.fileUrl.indexOf("magnet:?xt=urn:btih:0123456789abcdef") === 0, resolved.fileUrl);
  assert.equal(resolved.webFollow, undefined);
  // A row that already has a magnet passes through untouched.
  const plain = await resolveWebFileUrl({ fileUrl: "magnet:?xt=urn:btih:x" }, stub);
  assert.equal(plain.fileUrl, "magnet:?xt=urn:btih:x");
});

test("TorrentGalaxy is no longer a bundled definition", () => {
  // Removed rather than left in place: a def that no longer answers costs
  // every search a timeout and reports a failure in the summary panel on
  // every single run. Custom indexers are untouched — a user can paste it back.
  assert.equal(defById("tgx"), undefined);
  assert.deepEqual(WEB_DEFS.map((d) => d.id), ["tpb", "nyaa", "x1337", "bitsearch", "rargb"]);
});

test("bitsearch (html): in-row magnet, size, split swarm", () => {
  const rows = runDefOnBody(defById("bitsearch"), fix("bitsearch-search.html"));
  assert.equal(rows.length, 20);
  const first = rows[0];
  assert.match(first.fileName, /^Pink Floyd The Dark Side Of The Moon \(2024\)/);
  assert.ok(first.fileUrl.indexOf("magnet:?xt=urn:btih:901D809791A2CC7C") === 0, first.fileUrl);
  assert.equal(first.fileSize, Math.round(389.14 * 1024 * 1024));
  assert.equal(first.nbSeeders, 501);
  assert.equal(first.nbLeechers, 397);
  // The "2/22/2024" date span parses to a real timestamp.
  assert.ok(first.added > 0, "no added date");
  // Everything is in the row — no detail fetch to follow.
  assert.equal(first.webFollow, undefined);
});

test("rargb (html): lista2 rows, magnet followed from the detail page", () => {
  const rows = runDefOnBody(defById("rargb"), fix("rargb-search.html"));
  assert.equal(rows.length, 20);
  const first = rows[0];
  assert.match(first.fileName, /A Saucerful Of Secrets/);
  assert.equal(first.nbSeeders, 38);
  assert.equal(first.nbLeechers, 12);
  assert.equal(first.fileSize, Math.round(172.1 * 1024 * 1024));
  // The 4th cell's "2026-08-08 09:06:09" parses to a timestamp.
  assert.ok(first.added > 0, "no added date");
  // The list page carries no magnet: fileUrl is the detail page, tagged for
  // the lazy follow (resolveWebFileUrl) at add time.
  assert.equal(first.webFollow, "rargb");
  assert.ok(first.fileUrl.indexOf("https://rargb.to/torrent/") === 0, first.fileUrl);
});

test("rargb: the followed detail page yields a real magnet", async () => {
  const def = defById("rargb");
  const row = runDefOnBody(def, fix("rargb-search.html"))[0];
  const stub = async () => ({ status: 200, text: async () => fix("rargb-detail.html") });
  const resolved = await resolveWebFileUrl(row, stub);
  assert.ok(resolved.fileUrl.indexOf("magnet:?xt=urn:btih:") === 0, resolved.fileUrl);
  // The follow is spent — the row now carries a real magnet, not a page.
  assert.equal(resolved.webFollow, undefined);
});

test("webSearchAll merges every indexer, isolates a failure as a notice", async () => {
  const bodies = {
    "apibay.org": fix("apibay-search.json"),
    "nyaa.si": fix("nyaa-search.xml"),
  };
  const stub = async (url) => {
    if (url.indexOf("1337x.to") !== -1) return { status: 403, text: async () => "" };
    for (const host in bodies) {
      if (url.indexOf(host) !== -1) return { status: 200, text: async () => bodies[host] };
    }
    throw new Error("unmapped " + url);
  };
  // A fixed trio, not live WEB_DEFS: this test is about merge + failure
  // isolation, and pinning the set keeps it stable as bundled defs come and go.
  const defs = ["tpb", "nyaa", "x1337"].map(defById);
  const rows = await webSearchAll(defs, "bjork", stub, { minGapMs: 0 });
  // Real rows from two sites + one failure notice for 1337x.
  const notices = rows.filter((r) => r.fileSize < 0 && r.nbSeeders < 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].engineName, "web:x1337");
  assert.ok(notices[0].fileName.indexOf("HTTP 403") !== -1);
  const real = rows.filter((r) => r.fileSize >= 0);
  assert.equal(real.length, 10 + 6);
  assert.ok(real.every((r) => r.engineName.indexOf("web:") === 0));
});

test("redirectHijack names the host that answered instead", () => {
  const hijack = plugin._redirectHijack;
  // The real case this was built from: Greece's regulator 302s a blocked
  // site's request to its own notice page, which answers HTTP 200.
  assert.equal(
    hijack("https://1337x.to/category-search/x/Music/1/", "https://edppi.gr/edppi_block/edppi_block.html"),
    "edppi.gr"
  );
  // An honest answer, including www-canonicalisation, is not a hijack.
  assert.equal(hijack("https://1337x.to/a", "https://1337x.to/b"), null);
  assert.equal(hijack("https://thepiratebay.org/x", "https://www.thepiratebay.org/x"), null);
  // A host too old to report the final URL: no claim either way.
  assert.equal(hijack("https://1337x.to/a", undefined), null);
  assert.equal(hijack("", "https://edppi.gr/x"), null);
});

test("a block page wearing a 200 is reported as blocked, not as no results", async () => {
  const stub = async (url) => {
    if (url.indexOf("1337x.to") !== -1) {
      // The ISP intercepts: HTTP 200, from a different host, no torrent rows.
      return { status: 200, url: "https://edppi.gr/edppi_block/edppi_block.html", text: async () => "<html>blocked</html>" };
    }
    // The others answer honestly from where they were asked, with results —
    // apibay's rows parse, so ITS foreign-host case is exercised below.
    return { status: 200, url, text: async () => fix("apibay-search.json") };
  };
  const seen = {};
  const rows = await webSearchAll(WEB_DEFS, "bjork", stub, {
    minGapMs: 0,
    onStatus: (key, status) => { seen[key] = status; },
  });
  const notices = rows.filter((r) => r.fileSize < 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].engineName, "web:x1337");
  assert.match(notices[0].fileName, /redirected to edppi\.gr/);
  assert.match(notices[0].fileName, /blocked on your network/);
  // The code stays the truth — it WAS a 200; the hijack is the diagnosis.
  assert.equal(seen["web:x1337"], 200);
});

test("a redirect that still yields rows is results, not a fault", async () => {
  // A mirror/canonical redirect where the definition still parses: nothing to
  // report — the rows speak for themselves.
  const stub = async (url) => {
    if (url.indexOf("apibay.org") !== -1) {
      return { status: 200, url: "https://apibay-mirror.net/q.php", text: async () => fix("apibay-search.json") };
    }
    return { status: 200, url, text: async () => "<html></html>" };
  };
  const rows = await webSearchAll([defById("tpb")], "bjork", stub, { minGapMs: 0 });
  assert.equal(rows.filter((r) => r.fileSize < 0).length, 0);
  assert.equal(rows.length, 10);
});

test("an old host that reports no final URL keeps the old reading", async () => {
  // No `url` on the response → the hijack check has nothing to stand on, so
  // an empty page stays plain "no results" rather than a guessed accusation.
  const stub = async () => ({ status: 200, text: async () => "<html></html>" });
  const rows = await webSearchAll([defById("x1337")], "bjork", stub, { minGapMs: 0 });
  assert.deepEqual(rows, []);
});

test("the sweep reports each indexer's response code, including the failures", async () => {
  // The code is the diagnosis a bare "no results" hides: 403 is a bot wall,
  // 200-with-nothing means the definition's selectors have gone stale.
  const stub = async (url) => {
    if (url.indexOf("1337x.to") !== -1) return { status: 403, text: async () => "" };
    if (url.indexOf("nyaa.si") !== -1) throw new Error("timed out");
    return { status: 200, text: async () => fix("apibay-search.json") };
  };
  const seen = {};
  await webSearchAll(WEB_DEFS, "bjork", stub, {
    minGapMs: 0,
    onStatus: (key, status) => { seen[key] = status; },
  });
  assert.equal(seen["web:tpb"], 200);
  assert.equal(seen["web:x1337"], 403);
  // 0, not a missing key: "never answered at all" is a different diagnosis
  // from "answered 403", and the row has to be able to say so.
  assert.equal(seen["web:nyaa"], 0);
});

test("downloaderFor strips web engine names, passes qBittorrent ones through", () => {
  assert.equal(downloaderFor({ engineName: "web:tpb" }), "");
  assert.equal(downloaderFor({ engineName: "web:x1337" }), "");
  assert.equal(downloaderFor({ engineName: "1337x" }), "1337x"); // a real qBt search plugin
  assert.equal(downloaderFor({}), "");
});
