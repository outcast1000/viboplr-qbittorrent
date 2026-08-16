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

test("a result's subtitle carries the swarm and the source", () => {
  const s = plugin._searchResultSubtitle({
    fileSize: 1024 * 1024 * 500,
    nbSeeders: 12,
    nbLeechers: 3,
    siteUrl: "https://example.org",
  });
  assert.match(s, /12 seeders/);
  assert.match(s, /3 leechers/);
  assert.match(s, /example\.org/);
  // Size lives in the row's trailing column, not in this line — repeating it
  // here would push the swarm off the end of a narrow row.
  assert.ok(!/MB/.test(s), s);
});

test("leechers are shown at zero, so the fields hold their position", () => {
  const s = plugin._searchResultSubtitle({ nbSeeders: 40, nbLeechers: 0 });
  assert.match(s, /40 seeders/);
  assert.match(s, /0 leechers/);
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

test("a subtitle survives a result missing everything", () => {
  // Indexers vary in what they report; a missing field must not blank the row.
  const s = plugin._searchResultSubtitle({});
  assert.match(s, /swarm unknown/);
});

test("an unreported swarm is unknown, not zero", () => {
  // Indexers send -1 for "didn't report". "0 seeders" is a verdict on the
  // torrent and would send the user straight past a live result.
  assert.equal(plugin._swarmCount(-1), null);
  assert.equal(plugin._swarmCount(undefined), null);
  assert.equal(plugin._swarmCount(""), null);
  assert.equal(plugin._swarmCount(0), 0);
  assert.equal(plugin._swarmCount("42"), 42);
  assert.match(plugin._searchResultSubtitle({ nbSeeders: -1, nbLeechers: -1 }), /swarm unknown/);
});

test("a result row leads with the name and puts size in its own column", () => {
  const row = plugin._searchResultRow({
    fileName: "Some Artist - Album (1998) [FLAC]",
    fileUrl: "https://x/y.torrent",
    fileSize: 1024 * 1024 * 500,
    nbSeeders: 12,
    nbLeechers: 3,
  });
  assert.equal(row.title, "Some Artist - Album (1998) [FLAC]");
  assert.equal(row.id, "https://x/y.torrent");
  // formatBytes drops the decimal at 10 units and up, so this is "500 MB".
  assert.equal(row.duration, "500 MB");
  assert.match(row.subtitle, /12 seeders/);
});

test("a result row acts on double-click and Enter", () => {
  // Without a per-row action the host's selectable list only SELECTS on click
  // and does nothing on double-click, which is what got this list replaced with
  // a stack of cards the first time round.
  assert.equal(plugin._searchResultRow({ fileName: "x", fileUrl: "https://x/y" }).action, "qbt:search-add");
});

test("a nameless result still renders a row", () => {
  const row = plugin._searchResultRow({ fileUrl: "https://x/y.torrent" });
  assert.equal(row.title, "(untitled)");
  assert.equal(row.duration, "—");
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

test("the same kind at different seeder counts gives different tiles", () => {
  // The tile is cached by kind+count; caching on kind alone would freeze every
  // row on whichever count happened to be drawn first.
  assert.notEqual(plugin._mediaIconFor("audio", 500), plugin._mediaIconFor("audio", 5));
  assert.equal(plugin._mediaIconFor("audio", 500), plugin._mediaIconFor("audio", 500));
});

test("a result row's tile carries that result's seeders", () => {
  const row = plugin._searchResultRow({ fileName: "Artist - Album [FLAC]", nbSeeders: 250 });
  assert.equal(row.imageUrl, plugin._mediaIconFor("audio", 250));
});
