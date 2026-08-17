const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const parseSize = plugin._parseSize;
const applyFilters = plugin._applyFilters;
const jsonPath = plugin._jsonPath;
const buildSearchUrl = plugin._buildSearchUrl;
const buildMagnet = plugin._buildMagnet;
const validate = plugin._validateIndexerDef;
const WEB_DEFS = plugin._WEB_DEFS;

test("parseSize handles both decimal conventions and IEC/SI units", () => {
  assert.equal(parseSize("1.4 GB"), Math.round(1.4 * 1073741824));
  assert.equal(parseSize("1,4 Go"), Math.round(1.4 * 1073741824));
  assert.equal(parseSize("1.1 GiB"), Math.round(1.1 * 1073741824));
  assert.equal(parseSize("700 MB"), 700 * 1048576);
  assert.equal(parseSize("1.234,5 MB"), Math.round(1234.5 * 1048576));
  assert.equal(parseSize("1,234.5 MiB"), Math.round(1234.5 * 1048576));
  assert.equal(parseSize("512"), 512); // bare number = bytes
  assert.equal(parseSize("nonsense"), null);
  assert.equal(parseSize(""), null);
});

test("parseInt filter is thousands-separator tolerant", () => {
  assert.equal(applyFilters("1,234", [["parseInt"]]), 1234);
  assert.equal(applyFilters("1.234", [["parseInt"]]), 1234);
  assert.equal(applyFilters("41", [["parseInt"]]), 41);
  assert.equal(applyFilters("", [["parseInt"]]), null);
});

test("regex filter returns group 1, or empty on no match", () => {
  assert.equal(applyFilters("41 / 7", [["regex", "(\\d+)\\s*/"]]), "41");
  assert.equal(applyFilters("41 / 7", [["regex", "/\\s*(\\d+)"]]), "7");
  assert.equal(applyFilters("no digits", [["regex", "(\\d+)"]]), "");
});

test("prepend/append/querystring/replace", () => {
  assert.equal(applyFilters("/x", [["prepend", "https://s.to"]]), "https://s.to/x");
  assert.equal(applyFilters("123", [["append", ".torrent"]]), "123.torrent");
  assert.equal(applyFilters("https://s/a?id=99&x=1", [["querystring", "id"]]), "99");
  assert.equal(applyFilters("a-b-c", [["replace", "-", "_"]]), "a_b_c");
});

test("jsonPath walks dot paths and returns the root for ''", () => {
  const obj = { a: { b: 5 }, name: "x" };
  assert.equal(jsonPath(obj, "a.b"), 5);
  assert.equal(jsonPath(obj, "name"), "x");
  assert.equal(jsonPath(obj, "missing.deep"), undefined);
  assert.equal(jsonPath(obj, ""), obj);
});

test("buildSearchUrl encodes the query once", () => {
  assert.equal(
    buildSearchUrl({ search: { url: "https://s/q?x={q}" } }, "Björk & more"),
    "https://s/q?x=Bj%C3%B6rk%20%26%20more"
  );
});

test("buildMagnet drops junk and zero hashes", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const m = buildMagnet(hash, "My Song", ["udp://t:1/announce"]);
  assert.ok(m.indexOf("xt=urn:btih:" + hash) !== -1);
  assert.ok(m.indexOf("dn=My%20Song") !== -1);
  assert.ok(m.indexOf("tr=udp") !== -1);
  // Case-folded input still matches.
  assert.ok(buildMagnet(hash.toUpperCase(), "x").indexOf(hash) !== -1);
  // The apibay empty-search sentinel and anything non-40-hex → null.
  assert.equal(buildMagnet("0000000000000000000000000000000000000000", "No results"), null);
  assert.equal(buildMagnet("tooshort", "x"), null);
  assert.equal(buildMagnet("", "x"), null);
});

test("every bundled definition validates clean", () => {
  for (const def of WEB_DEFS) {
    assert.deepEqual(validate(def, {}), [], def.id + " should be valid");
  }
});

test("validation reports human problems and catches the landmines", () => {
  assert.ok(validate({}, {}).some((p) => p.indexOf("id") !== -1));
  // Duplicate id.
  assert.ok(validate({ id: "tpb", name: "x", siteUrl: "https://x", type: "json", search: { url: "https://x?q={q}" }, rows: { path: "" }, fields: { fileName: { path: "name" }, fileUrl: { magnet: { infoHash: { path: "h" } } } } }, { tpb: true }).some((p) => p.indexOf("already taken") !== -1));
  // Missing {q}.
  assert.ok(validate({ id: "z", name: "z", siteUrl: "https://z", type: "json", search: { url: "https://z" }, rows: { path: "" }, fields: { fileName: { path: "n" }, fileUrl: { magnet: { infoHash: { path: "h" } } } } }, {}).some((p) => p.indexOf("{q}") !== -1));
  // Bad selector in an html def surfaces the parser's message.
  const bad = validate({ id: "z", name: "z", siteUrl: "https://z", type: "html", search: { url: "https://z?q={q}" }, rows: { selector: "tr, td" }, fields: { fileName: { selector: "a" }, fileUrl: { selector: "a", attribute: "href" } } }, {});
  assert.ok(bad.some((p) => p.indexOf("“,”") !== -1), bad.join(" | "));
  // Unknown filter.
  const uf = validate({ id: "z", name: "z", siteUrl: "https://z", type: "json", search: { url: "https://z?q={q}" }, rows: { path: "" }, fields: { fileName: { path: "n", filters: [["frobnicate"]] }, fileUrl: { magnet: { infoHash: { path: "h" } } } } }, {});
  assert.ok(uf.some((p) => p.indexOf("frobnicate") !== -1));
});
