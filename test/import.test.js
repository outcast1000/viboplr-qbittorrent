const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const forPath = plugin._collectionForPath;
const detect = plugin._detectCompletions;

const COLLECTIONS = [
  { id: 1, name: "Music", path: "/home/me/Music" },
  { id: 2, name: "Bootlegs", path: "/home/me/Music/Live bootlegs" },
  { id: 3, name: "Musicals", path: "/home/me/Musicals" },
];

test("a downloaded file is matched to its collection", () => {
  const c = forPath("/home/me/Music/Album/01.flac", COLLECTIONS);
  assert.equal(c.id, 1);
});

test("the deepest matching collection wins", () => {
  // Nested collections are legal, and the shallower one would otherwise always
  // claim files belonging to the more specific one.
  const c = forPath("/home/me/Music/Live bootlegs/1977/01.flac", COLLECTIONS);
  assert.equal(c.id, 2);
});

test("matching is on path segments, so a sibling prefix doesn't match", () => {
  // "/home/me/Music" is a character-prefix of "/home/me/Musicals" — matching raw
  // characters would file every musical under Music.
  const c = forPath("/home/me/Musicals/Hamilton/01.flac", COLLECTIONS);
  assert.equal(c.id, 3);
});

test("a file outside every collection matches nothing", () => {
  // This is what stops the plugin rescanning a folder the library doesn't cover
  // — a scan that would find nothing and look broken.
  assert.equal(forPath("/tmp/downloads/x.flac", COLLECTIONS), null);
  assert.equal(forPath("/home/me/Music", []), null);
  assert.equal(forPath("", COLLECTIONS), null);
});

test("the collection root itself matches", () => {
  const c = forPath("/home/me/Music", COLLECTIONS);
  assert.equal(c.id, 1);
});

test("Windows collection paths match case-insensitively", () => {
  const win = [{ id: 9, name: "Music", path: "D:\\Media\\Music" }];
  const c = forPath("d:/media/music/Album/01.flac", win);
  assert.equal(c.id, 9);
});

test("a POSIX collection path is matched case-sensitively", () => {
  // /Music and /music are two different directories on Linux; folding them
  // would import from a folder the user never pointed at.
  assert.equal(forPath("/home/me/music/01.flac", COLLECTIONS), null);
});

test("detectCompletions reports only newly finished torrents", () => {
  const known = { a: true };
  const finished = detect(known, [
    { hash: "a", progress: 1, state: "stoppedUP" },
    { hash: "b", progress: 1, state: "uploading" },
    { hash: "c", progress: 0.5, state: "downloading" },
  ]);
  assert.deepEqual(finished.map((t) => t.hash), ["b"]);
});

test("detectCompletions is quiet when nothing changed", () => {
  const known = { a: true, b: true };
  assert.deepEqual(detect(known, [
    { hash: "a", progress: 1, state: "stoppedUP" },
    { hash: "b", progress: 1, state: "uploading" },
  ]), []);
});

test("detectCompletions ignores torrents still downloading", () => {
  assert.deepEqual(detect({}, [{ hash: "x", progress: 0.99, state: "downloading" }]), []);
});

test("detectCompletions survives a torrent with no hash yet", () => {
  // A magnet mid-metadata-fetch can turn up with fields missing.
  assert.deepEqual(detect({}, [{ progress: 1, state: "uploading" }, null]), []);
});
