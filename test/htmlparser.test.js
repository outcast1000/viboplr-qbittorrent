const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const parseHtml = plugin._parseHtml;
const parseXml = plugin._parseXml;
const text = plugin._nodeText;
const selectAll = plugin._selectAll;
const decode = plugin._decodeEntities;
const childByTag = plugin._childByTag;

// The parser exists because the sandbox has no DOM. It is tolerant of the tag
// soup trackers actually serve — these tests pin the auto-close rules and the
// deliberate limits.

function tags(node) {
  return (node.children || []).filter((c) => c.text === undefined).map((c) => c.tag);
}
function first(root, sel) {
  const all = selectAll(root, sel);
  return all.length ? all[0] : null;
}

test("basic tree with attributes in every quoting variant", () => {
  const root = parseHtml('<div id="a" class=row data-x=\'1\' hidden><span>hi</span></div>');
  const div = first(root, "div");
  assert.ok(div);
  assert.equal(div.attrs.id, "a");
  assert.equal(div.attrs["class"], "row");
  assert.equal(div.attrs["data-x"], "1");
  assert.equal(div.attrs.hidden, "");
  assert.equal(text(div), "hi");
});

test("unclosed td/tr auto-close like a browser would", () => {
  const root = parseHtml("<table><tr><td>a<td>b<tr><td>c</table>");
  const rows = selectAll(root, "tr");
  assert.equal(rows.length, 2);
  assert.deepEqual(tags(rows[0]), ["td", "td"]);
  assert.deepEqual(tags(rows[1]), ["td"]);
  // Text joins WITHOUT inserting spaces — "4<b>2</b>" must read 42, not "4 2".
  // Field extraction always targets one cell, so cross-cell merging ("ab"
  // here) is the harmless side of that trade.
  assert.equal(text(rows[0]), "ab");
});

test("li runs and p-before-block auto-close", () => {
  const root = parseHtml("<ul><li>one<li>two<li>three</ul><p>para<div>block</div>");
  assert.equal(selectAll(root, "li").length, 3);
  const p = first(root, "p");
  // The div must NOT be inside the p.
  assert.equal(selectAll(p, "div").length, 0);
});

test("void elements never swallow siblings", () => {
  const root = parseHtml("<td><img src=x><br>after</td>");
  const td = first(root, "td");
  assert.equal(text(td), "after");
  assert.deepEqual(tags(td), ["img", "br"]);
});

test("a script containing '</table>' does not close the table", () => {
  const root = parseHtml('<table><tr><td><script>var s = "</table>";</script>ok</td></tr></table>');
  const rows = selectAll(root, "table tr");
  assert.equal(rows.length, 1);
  // The cell survives with its trailing text; the script body stayed raw text
  // inside the script element instead of tearing the table apart.
  assert.ok(text(rows[0]).indexOf("ok") !== -1);
  assert.equal(selectAll(root, "table").length, 1);
});

test("a close tag nothing opened is ignored; a skipped close pops through", () => {
  const root = parseHtml("<div></b><span>in</span></div><i>tail</i>");
  const div = first(root, "div");
  assert.deepEqual(tags(div), ["span"]);
  // </div> closed the div even though </b> was junk.
  const i = first(root, "i");
  assert.ok(i);
  assert.notEqual(i.parent, div);
});

test("comments, doctype, and processing instructions vanish", () => {
  const root = parseHtml("<!DOCTYPE html><!-- <tr>fake</tr> --><div>real</div>");
  assert.equal(selectAll(root, "tr").length, 0);
  assert.equal(text(first(root, "div")), "real");
});

test("entities decode in text and attributes; astral entities degrade", () => {
  assert.equal(decode("Tom &amp; Jerry &lt;3 &quot;x&quot; &#65; &#x42; &nbsp;end"), 'Tom & Jerry <3 "x" A B  end');
  assert.equal(decode("&#128512;"), "&#128512;"); // astral: kept literal, documented
  const root = parseHtml('<a href="/x?a=1&amp;b=2">A &amp; B</a>');
  const a = first(root, "a");
  assert.equal(a.attrs.href, "/x?a=1&b=2");
  assert.equal(text(a), "A & B");
});

test("a bare '<' in text is text, not markup", () => {
  const root = parseHtml("<td>5 < 10 seeders</td>");
  assert.equal(text(first(root, "td")), "5 < 10 seeders");
});

test("XML mode: no auto-close, no void list, namespaced tags are just names", () => {
  const xml =
    '<?xml version="1.0"?><rss><channel>' +
    "<item><title>One</title><nyaa:seeders>42</nyaa:seeders><link>https://x/1.torrent</link></item>" +
    "<item><title><![CDATA[Two & Co <raw>]]></title><nyaa:seeders>7</nyaa:seeders></item>" +
    "</channel></rss>";
  const root = parseXml(xml);
  const items = selectAll(root, "item");
  assert.equal(items.length, 2);
  // Namespaced tags are plain names reached via childByTag — selectors refuse
  // ":" in tag names so pseudo-class typos can't silently match nothing.
  assert.equal(text(childByTag(items[0], "nyaa:seeders")), "42");
  // CDATA is verbatim — no entity decoding, no markup interpretation.
  assert.equal(text(first(items[1], "title")), "Two & Co <raw>");
});
