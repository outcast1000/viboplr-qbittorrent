const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const parse = plugin._parseMetadataPreview;

// Shape of qBittorrent's serializeTorrentInfo (master): the file list lives at
// info.files, each entry has path + length, and there is no index field.
const RESPONSE = {
  infohash_v1: "C12FE1C06BBA254A9DC9F519B335AA7C1367A88A",
  id: "c12fe1c06bba254a9dc9f519b335aa7c1367a88a",
  info: {
    name: "Artist - Album [FLAC]",
    length: 500,
    files: [
      { path: "Artist - Album/01 One.flac", length: 200 },
      { path: "Artist - Album/cover.jpg", length: 100 },
      { path: "Artist - Album/02 Two.flac", length: 200 },
    ],
  },
};

test("parses the name, size and file list", () => {
  const p = parse(RESPONSE);
  assert.equal(p.name, "Artist - Album [FLAC]");
  assert.equal(p.totalSize, 500);
  assert.equal(p.files.length, 3);
  assert.equal(p.files[0].name, "Artist - Album/01 One.flac");
  assert.equal(p.files[0].size, 200);
});

test("a file's ARRAY POSITION becomes its index", () => {
  // The response carries no index, and /torrents/filePrio addresses files by
  // position — that equivalence is what lets a choice made before adding be
  // applied after. If it ever broke, the wrong files would be skipped.
  const p = parse(RESPONSE);
  assert.deepEqual(p.files.map((f) => f.index), [0, 1, 2]);
});

test("the parsed files work with the audio/other split", () => {
  // The preview reuses the same helper the Files list does, so "only the audio"
  // means the same thing in both places.
  const p = parse(RESPONSE);
  const { audio, others } = plugin._partitionAudio(p.files);
  assert.deepEqual(audio, [0, 2]);
  assert.deepEqual(others, [1]);
});

test("an in-progress fetch is not mistaken for an answer", () => {
  // qBittorrent replies {} while it is still fetching from the swarm, and
  // infohash-only when metadata is not complete. Treating either as "done"
  // would show an empty download window.
  assert.equal(parse({}), null);
  assert.equal(parse({ infohash_v1: "abc", infohash_v2: "", id: "abc" }), null);
  assert.equal(parse({ info: { name: "x", files: [] } }), null);
});

test("junk responses yield nothing rather than throwing", () => {
  assert.equal(parse(null), null);
  assert.equal(parse("not json"), null);
  assert.equal(parse({ info: null }), null);
});

test("the torrent id is picked up when present", () => {
  // Used as the expected hash after adding, which is the most reliable of the
  // three ways of identifying it.
  assert.equal(parse(RESPONSE).hash, "c12fe1c06bba254a9dc9f519b335aa7c1367a88a");
  assert.equal(parse({ info: { name: "x", files: [{ path: "a.flac", length: 1 }] } }).hash, null);
});
