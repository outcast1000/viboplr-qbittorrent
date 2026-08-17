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

test("tgx (html): in-row magnet, badge size, split swarm", () => {
  const rows = runDefOnBody(defById("tgx"), fix("tgx-search.html"));
  assert.equal(rows.length, 2);
  const first = rows[0];
  assert.equal(first.fileName, "Bjork - Homogenic (1997) [FLAC]");
  assert.ok(first.fileUrl.indexOf("magnet:?xt=urn:btih:89abcdef") === 0, first.fileUrl);
  assert.equal(first.fileSize, Math.round(1.42 * 1073741824));
  assert.equal(first.nbSeeders, 41);
  assert.equal(first.nbLeechers, 7);
  assert.equal(first.webFollow, undefined); // magnet was in the row
});

test("webSearchAll merges every indexer, isolates a failure as a notice", async () => {
  const bodies = {
    "apibay.org": fix("apibay-search.json"),
    "nyaa.si": fix("nyaa-search.xml"),
    "torrentgalaxy.to": fix("tgx-search.html"),
  };
  const stub = async (url) => {
    if (url.indexOf("1337x.to") !== -1) return { status: 403, text: async () => "" };
    for (const host in bodies) {
      if (url.indexOf(host) !== -1) return { status: 200, text: async () => bodies[host] };
    }
    throw new Error("unmapped " + url);
  };
  const rows = await webSearchAll(WEB_DEFS, "bjork", stub, { minGapMs: 0 });
  // Real rows from three sites + one failure notice for 1337x.
  const notices = rows.filter((r) => r.fileSize < 0 && r.nbSeeders < 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].engineName, "web:x1337");
  assert.ok(notices[0].fileName.indexOf("HTTP 403") !== -1);
  const real = rows.filter((r) => r.fileSize >= 0);
  assert.equal(real.length, 10 + 6 + 2);
  assert.ok(real.every((r) => r.engineName.indexOf("web:") === 0));
});

test("downloaderFor strips web engine names, passes qBittorrent ones through", () => {
  assert.equal(downloaderFor({ engineName: "web:tpb" }), "");
  assert.equal(downloaderFor({ engineName: "web:x1337" }), "");
  assert.equal(downloaderFor({ engineName: "1337x" }), "1337x"); // a real qBt search plugin
  assert.equal(downloaderFor({}), "");
});
