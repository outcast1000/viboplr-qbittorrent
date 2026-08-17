const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const parseHtml = plugin._parseHtml;
const parseSelector = plugin._parseSelector;
const selectAll = plugin._selectAll;
const text = plugin._nodeText;

// One test per supported feature; unsupported syntax must ERROR (the selector
// parser doubles as the indexer-definition validator, and a silent mismatch
// would validate a def that can never match anything).

const DOC = parseHtml(
  '<table class="table-list striped"><tbody>' +
    '<tr class="row odd"><td class="coll-1 name"><a href="/icon">i</a><a href="/torrent/1">First Song</a></td>' +
    '<td class="coll-2">41</td><td class="coll-4">1.4 GB <span class="seeds">x</span></td></tr>' +
    '<tr class="row"><td class="coll-1 name"><a href="/icon">i</a><a href="/torrent/2">Second</a></td>' +
    '<td class="coll-2">7</td><td class="coll-4">700 MB</td></tr>' +
    "</tbody></table>" +
    '<div id="side"><a href="magnet:?xt=urn:btih:abc">m</a><span title="12 Seeders">12/3</span></div>'
);

test("tag, class, compound, and universal-by-omission", () => {
  assert.equal(selectAll(DOC, "tr").length, 2);
  assert.equal(selectAll(DOC, ".coll-2").length, 2);
  assert.equal(selectAll(DOC, "td.coll-1").length, 2);
  // Class matching is token-based: "table-list" must not match "table-listx".
  assert.equal(selectAll(DOC, "table.table-list").length, 1);
  assert.equal(selectAll(DOC, "table.striped").length, 1);
  assert.equal(selectAll(DOC, "table.strip").length, 0);
});

test("#id and attribute selectors", () => {
  assert.equal(selectAll(DOC, "#side").length, 1);
  assert.equal(selectAll(DOC, "a[href]").length, 5);
  assert.equal(selectAll(DOC, 'a[href="/torrent/1"]').length, 1);
  assert.equal(selectAll(DOC, "a[href^=magnet]").length, 1);
  assert.equal(selectAll(DOC, "span[title*=Seeder]").length, 1);
  assert.equal(selectAll(DOC, "span[title*=Leecher]").length, 0);
});

test("descendant, child, and the difference between them", () => {
  assert.equal(selectAll(DOC, "table td").length, 6);
  assert.equal(selectAll(DOC, "tbody > tr").length, 2);
  // tr is NOT a direct child of table (tbody intervenes).
  assert.equal(selectAll(DOC, "table > tr").length, 0);
  assert.equal(selectAll(DOC, "table > tbody > tr > td.coll-1 a").length, 4);
});

test(":nth-child picks the icon-vs-name link apart (the 1337x case)", () => {
  const names = selectAll(DOC, "td.coll-1 a:nth-child(2)");
  assert.equal(names.length, 2);
  assert.equal(text(names[0]), "First Song");
  assert.equal(text(names[1]), "Second");
});

test("scoped selection: a row is its own little document", () => {
  const rows = selectAll(DOC, "tbody > tr");
  assert.equal(selectAll(rows[0], "td.coll-2").length, 1);
  assert.equal(text(selectAll(rows[0], "td.coll-2")[0]), "41");
  assert.equal(text(selectAll(rows[1], "td.coll-2")[0]), "7");
});

test("unsupported syntax is an error with the feature named", () => {
  for (const [sel, needle] of [
    ["a, b", "“,”"],
    ["a + b", "“+”"],
    ["a ~ b", "“~”"],
    ["a:not(.x)", "unsupported selector feature"],
    ["a:hover", "unsupported selector feature"],
    ["td[", "unclosed ["],
    ["", "empty selector"],
    [".", "empty class name"],
  ]) {
    const r = parseSelector(sel);
    assert.ok(r.error, "expected error for " + JSON.stringify(sel));
    assert.ok(r.error.indexOf(needle) !== -1, sel + " → " + r.error);
  }
  // And the supported grammar parses clean.
  for (const sel of ["table.table-list tbody > tr", "td.coll-1 a:nth-child(2)", "a[href^=magnet]", "*", "div#x.y[z=1]"]) {
    assert.ok(!parseSelector(sel).error, sel);
  }
});
