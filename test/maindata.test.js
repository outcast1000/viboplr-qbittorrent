const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const merge = plugin._mergeMaindata;

const EMPTY = { torrents: {}, serverState: {}, rid: 0 };

test("a full update replaces everything", () => {
  const prev = { torrents: { old: { hash: "old", name: "Gone" } }, serverState: { dl_info_speed: 10 }, rid: 7 };
  const next = merge(prev, {
    rid: 8,
    full_update: true,
    torrents: { a: { name: "New" } },
    server_state: { dl_info_speed: 99 },
  });
  assert.deepEqual(Object.keys(next.torrents), ["a"]);
  assert.equal(next.serverState.dl_info_speed, 99);
  assert.equal(next.rid, 8);
});

test("a partial update merges fields instead of replacing the torrent", () => {
  // This is the whole reason the merge exists: qBittorrent sends ONLY changed
  // fields, so a replace would blank the name of any torrent whose speed moved.
  const first = merge(EMPTY, {
    rid: 1,
    full_update: true,
    torrents: { a: { name: "Album.flac", progress: 0.1, dlspeed: 100, state: "downloading" } },
  });
  const second = merge(first, { rid: 2, torrents: { a: { progress: 0.4, dlspeed: 250 } } });

  assert.equal(second.torrents.a.name, "Album.flac", "name must survive a delta that omits it");
  assert.equal(second.torrents.a.state, "downloading");
  assert.equal(second.torrents.a.progress, 0.4);
  assert.equal(second.torrents.a.dlspeed, 250);
});

test("every torrent carries its own hash after merging", () => {
  // The hash is the object KEY in the wire format, never a field — but the view
  // and every action need it on the object.
  const next = merge(EMPTY, { rid: 1, full_update: true, torrents: { abc123: { name: "x" } } });
  assert.equal(next.torrents.abc123.hash, "abc123");
});

test("torrents_removed drops entries", () => {
  const first = merge(EMPTY, { rid: 1, full_update: true, torrents: { a: { name: "A" }, b: { name: "B" } } });
  const second = merge(first, { rid: 2, torrents_removed: ["a"] });
  assert.deepEqual(Object.keys(second.torrents), ["b"]);
});

test("server_state merges field-by-field too", () => {
  const first = merge(EMPTY, { rid: 1, full_update: true, server_state: { dl_info_speed: 10, free_space_on_disk: 500 } });
  const second = merge(first, { rid: 2, server_state: { dl_info_speed: 20 } });
  assert.equal(second.serverState.dl_info_speed, 20);
  assert.equal(second.serverState.free_space_on_disk, 500, "an omitted stat must not vanish");
});

test("an empty delta changes nothing but the rid", () => {
  // The common case by far — most polls report nothing.
  const first = merge(EMPTY, { rid: 1, full_update: true, torrents: { a: { name: "A" } } });
  const second = merge(first, { rid: 2 });
  assert.deepEqual(second.torrents, first.torrents);
  assert.equal(second.rid, 2);
});

test("a delta with no rid keeps the previous cursor", () => {
  const first = merge(EMPTY, { rid: 4, full_update: true, torrents: {} });
  const second = merge(first, {});
  assert.equal(second.rid, 4);
});

test("merging does not mutate the previous snapshot", () => {
  const first = merge(EMPTY, { rid: 1, full_update: true, torrents: { a: { name: "A", progress: 0 } } });
  merge(first, { rid: 2, torrents: { a: { progress: 0.9 } }, server_state: { dl_info_speed: 1 } });
  assert.equal(first.torrents.a.progress, 0, "previous snapshot must stay intact");
  assert.equal(first.serverState.dl_info_speed, undefined);
});
