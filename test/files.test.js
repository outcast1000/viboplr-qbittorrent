const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("mediaKindOf sorts audio, video and everything else", () => {
  assert.equal(plugin._mediaKindOf("01 Song.flac"), "audio");
  assert.equal(plugin._mediaKindOf("Album/track.MP3"), "audio");
  assert.equal(plugin._mediaKindOf("concert.mkv"), "video");
  // The junk every torrent carries must not turn up in a playlist.
  assert.equal(plugin._mediaKindOf("cover.jpg"), null);
  assert.equal(plugin._mediaKindOf("readme.nfo"), null);
  assert.equal(plugin._mediaKindOf(""), null);
});

test("isWindowsPath reads the path, not the platform", () => {
  // A Windows client talking to a Linux seedbox is the normal case, so the
  // separator has to come from the string qBittorrent sent.
  assert.equal(plugin._isWindowsPath("D:\\Downloads"), true);
  assert.equal(plugin._isWindowsPath("D:/Downloads"), true);
  assert.equal(plugin._isWindowsPath("/home/me/downloads"), false);
  assert.equal(plugin._isWindowsPath(""), false);
});

test("joinRemotePath always emits forward slashes", () => {
  // The host slices "file://" off and hands the rest to mpv/convertFileSrc; a
  // surviving backslash breaks there even on Windows.
  assert.equal(plugin._joinRemotePath("D:\\Torrents", "Album\\01.flac"), "D:/Torrents/Album/01.flac");
  assert.equal(plugin._joinRemotePath("/downloads", "Album/01.flac"), "/downloads/Album/01.flac");
});

test("joinRemotePath doesn't double up separators", () => {
  assert.equal(plugin._joinRemotePath("/downloads/", "/Album/01.flac"), "/downloads/Album/01.flac");
  assert.equal(plugin._joinRemotePath("/downloads", ""), "/downloads");
});

test("applyPathMapping rewrites the remote prefix", () => {
  assert.equal(
    plugin._applyPathMapping("/downloads/Album/01.flac", "/downloads", "Z:/torrents"),
    "Z:/torrents/Album/01.flac",
  );
});

test("applyPathMapping is case-insensitive only for a Windows remote", () => {
  // Windows paths are case-insensitive, so a user typing "d:/downloads" must
  // still match. A Linux remote must NOT be folded — /Music and /music are two
  // different directories there.
  assert.equal(plugin._applyPathMapping("D:/Downloads/x.flac", "d:/downloads", "/mnt/dl"), "/mnt/dl/x.flac");
  assert.equal(plugin._applyPathMapping("/Downloads/x.flac", "/downloads", "/mnt/dl"), "/Downloads/x.flac");
});

test("applyPathMapping is a no-op when unset or when the prefix doesn't match", () => {
  assert.equal(plugin._applyPathMapping("/downloads/x.flac", "", ""), "/downloads/x.flac");
  assert.equal(plugin._applyPathMapping("/other/x.flac", "/downloads", "Z:/t"), "/other/x.flac");
});

test("isLikelyLocalHost recognises the loopback spellings", () => {
  assert.equal(plugin._isLikelyLocalHost("http://localhost:8080"), true);
  assert.equal(plugin._isLikelyLocalHost("http://127.0.0.1:8080"), true);
  assert.equal(plugin._isLikelyLocalHost("http://[::1]:8080"), true);
  // A LAN address is someone else's filesystem until the user says otherwise.
  assert.equal(plugin._isLikelyLocalHost("http://192.168.1.50:8080"), false);
  assert.equal(plugin._isLikelyLocalHost("https://nas.local:8080"), false);
  assert.equal(plugin._isLikelyLocalHost(""), false);
});

test("parseFileTrack pulls a track number, artist and title out of a filename", () => {
  assert.deepEqual(plugin._parseFileTrack("Album/03 - Björk - Jóga.flac"), {
    trackNumber: 3,
    artist: "Björk",
    title: "Jóga",
  });
});

test("parseFileTrack leaves the artist null when the filename has none", () => {
  // Inventing one from the folder name would be a guess presented as metadata.
  assert.deepEqual(plugin._parseFileTrack("07 Song Name.mp3"), {
    trackNumber: 7,
    artist: null,
    title: "Song Name",
  });
});

test("parseFileTrack handles no track number and underscore separators", () => {
  const r = plugin._parseFileTrack("Some_Band - Some_Song.opus");
  assert.equal(r.trackNumber, null);
  assert.equal(r.artist, "Some Band");
  assert.equal(r.title, "Some Song");
});

test("parseFileTrack keeps a year in the title rather than reading it as a track number", () => {
  // "1999 - Song" is a title, not track 1999; the 1-3 digit bound is what stops
  // that, so it's worth pinning.
  const r = plugin._parseFileTrack("1999 - Song.flac");
  assert.equal(r.trackNumber, null);
  assert.equal(r.artist, "1999");
  assert.equal(r.title, "Song");
});

test("qbt URIs round-trip", () => {
  const uri = plugin._qbtUri("abc123", 7);
  assert.equal(uri, "qbt://abc123/7");
  // The host hands back everything after "qbt://", so that is what parse sees.
  assert.deepEqual(plugin._parseQbtUri("abc123/7"), { hash: "abc123", index: 7 });
});

test("parseQbtUri rejects anything malformed rather than resolving nonsense", () => {
  assert.equal(plugin._parseQbtUri("abc123"), null);
  assert.equal(plugin._parseQbtUri("/7"), null);
  assert.equal(plugin._parseQbtUri("abc123/notanumber"), null);
  assert.equal(plugin._parseQbtUri(""), null);
});

test("playableFiles offers only finished media", () => {
  // A half-downloaded file opens and then hits EOF partway through, which reads
  // as a corrupt file rather than an incomplete download.
  const files = [
    { index: 0, name: "01.flac", progress: 1 },
    { index: 1, name: "02.flac", progress: 0.4 },
    { index: 2, name: "cover.jpg", progress: 1 },
    { index: 3, name: "00 intro.flac", progress: 1 },
  ];
  const out = plugin._playableFiles(files);
  assert.deepEqual(out.map((f) => f.name), ["00 intro.flac", "01.flac"]);
});

test("playableFiles copes with an empty or absent list", () => {
  assert.deepEqual(plugin._playableFiles([]), []);
  assert.deepEqual(plugin._playableFiles(undefined), []);
});

test("partitionAudio separates the tracks from everything else", () => {
  const { audio, others } = plugin._partitionAudio([
    { index: 0, name: "01 Song.flac" },
    { index: 1, name: "cover.jpg" },
    { index: 2, name: "02 Song.flac" },
    { index: 3, name: "Making Of.mkv" },
    { index: 4, name: "info.nfo" },
  ]);
  assert.deepEqual(audio, [0, 2]);
  // Video counts as "other": on a music release the video extra is usually the
  // bulk of the download and the thing being skipped.
  assert.deepEqual(others, [1, 3, 4]);
});

test("partitionAudio keeps file index 0 and ignores entries with no index", () => {
  // Index 0 is a real file; a truthiness check would drop the first track of
  // every torrent.
  const { audio, others } = plugin._partitionAudio([
    { index: 0, name: "a.flac" },
    { name: "no-index.flac" },
    null,
  ]);
  assert.deepEqual(audio, [0]);
  assert.deepEqual(others, []);
});

test("partitionAudio on an all-audio torrent leaves nothing to skip", () => {
  // The caller uses this to decide whether to offer the bulk button at all.
  const { audio, others } = plugin._partitionAudio([
    { index: 0, name: "a.flac" },
    { index: 1, name: "b.flac" },
  ]);
  assert.deepEqual(audio, [0, 1]);
  assert.deepEqual(others, []);
});
