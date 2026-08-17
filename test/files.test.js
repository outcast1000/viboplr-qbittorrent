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

const TORRENT = { hash: "abc123", name: "Radiohead - In Rainbows (2007) [FLAC 24-96]" };
const FILE = { index: 3, name: "Disc 1/03 - Nude.flac" };

test("mergeFileTrack prefers the file's own tags over the filename", () => {
  // The whole point: a tagged file should reach the queue as what it says it
  // is, not as whatever the release folder's naming scheme left behind.
  const t = plugin._mergeFileTrack(TORRENT, FILE, {
    title: "Nude",
    artist: "Radiohead",
    album: "In Rainbows",
    track_number: 3,
    duration_secs: 255.3,
  });
  assert.deepEqual(t, {
    path: "qbt://abc123/3",
    title: "Nude",
    artist_name: "Radiohead",
    album_title: "In Rainbows",
    track_number: 3,
    duration_secs: 255.3,
  });
});

test("mergeFileTrack merges per field rather than all-or-nothing", () => {
  // Tagged with an artist but no track number: the number is still there in the
  // filename, and dropping it would reorder an album in the queue.
  const t = plugin._mergeFileTrack(TORRENT, FILE, { artist: "Radiohead", duration_secs: 255.3 });
  assert.equal(t.artist_name, "Radiohead");
  assert.equal(t.title, "Nude");
  assert.equal(t.track_number, 3);
  // No album tag, so the torrent name stands — same as before tags existed.
  assert.equal(t.album_title, TORRENT.name);
});

test("mergeFileTrack falls back to the filename parse with no tags at all", () => {
  // An untagged release, an unreachable seedbox and a host too old to read tags
  // all arrive here, and all must behave exactly as the plugin did before.
  assert.deepEqual(plugin._mergeFileTrack(TORRENT, FILE, null), {
    path: "qbt://abc123/3",
    title: "Nude",
    artist_name: null,
    album_title: TORRENT.name,
    track_number: 3,
    duration_secs: null,
  });
});

test("mergeFileTrack takes album_artist only as a second choice", () => {
  // On a compilation album_artist is "Various Artists" while the per-track
  // artist is the one worth showing, so it must never outrank it.
  const comp = plugin._mergeFileTrack(TORRENT, FILE, {
    artist: "Portishead",
    album_artist: "Various Artists",
  });
  assert.equal(comp.artist_name, "Portishead");
  // With no track artist it is better than nothing.
  const only = plugin._mergeFileTrack(TORRENT, FILE, { album_artist: "Various Artists" });
  assert.equal(only.artist_name, "Various Artists");
});

test("mergeFileTrack ignores blank and zero tag values", () => {
  // Taggers write empty frames and a literal 0 track number; both would
  // otherwise beat a filename that actually knows the answer.
  const t = plugin._mergeFileTrack(TORRENT, FILE, {
    title: "   ",
    artist: "",
    track_number: 0,
    duration_secs: 0,
  });
  assert.equal(t.title, "Nude");
  assert.equal(t.artist_name, null);
  assert.equal(t.track_number, 3);
  // A zero duration is "unknown", not a zero-length track.
  assert.equal(t.duration_secs, null);
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

test("partitionByKind separates audio, video and everything else", () => {
  const { audio, video, other, all } = plugin._partitionByKind([
    { index: 0, name: "01 Song.flac" },
    { index: 1, name: "cover.jpg" },
    { index: 2, name: "02 Song.flac" },
    { index: 3, name: "Making Of.mkv" },
    { index: 4, name: "info.nfo" },
  ]);
  assert.deepEqual(audio, [0, 2]);
  // Video is its own group now: the Download toolbar offers it as a choice,
  // where the old audio-only split lumped it in with the scans and the .nfo.
  assert.deepEqual(video, [3]);
  assert.deepEqual(other, [1, 4]);
  assert.deepEqual(all, [0, 1, 2, 3, 4]);
});

test("partitionByKind keeps file index 0 and ignores entries with no index", () => {
  // Index 0 is a real file; a truthiness check would drop the first track of
  // every torrent.
  const { audio, all } = plugin._partitionByKind([
    { index: 0, name: "a.flac" },
    { name: "no-index.flac" },
    null,
  ]);
  assert.deepEqual(audio, [0]);
  assert.deepEqual(all, [0]);
});

test("partitionByKind on an all-audio torrent leaves the other groups empty", () => {
  // The toolbar disables a button whose group is empty, so this decides whether
  // Video is offered at all.
  const { audio, video, other } = plugin._partitionByKind([
    { index: 0, name: "a.flac" },
    { index: 1, name: "b.flac" },
  ]);
  assert.deepEqual(audio, [0, 1]);
  assert.deepEqual(video, []);
  assert.deepEqual(other, []);
});



// --- the contents filter -----------------------------------------------------

test("the filter matches anywhere in the path, case-insensitively", () => {
  const m = plugin._matchesFilter;
  assert.equal(m("01 - Some Song.FLAC", "flac"), true);
  assert.equal(m("Extras/Making Of.mkv", "EXTRAS"), true);
  // The full path, not just the basename — "extras" has to find a whole folder,
  // which on a release full of scans and samples is what you select or skip in
  // one go.
  assert.equal(m("extras/bonus.mkv", "extras"), true);
  assert.equal(m("01 - Song.flac", "mkv"), false);
});

test("windows separators match the same way", () => {
  // Built from a char code so no editor or shell can quietly turn the backslash
  // into an escape — `"extras\bonus.mkv"` is a BACKSPACE, and the test that
  // contained it passed for a reason unrelated to path separators.
  const BACKSLASH = String.fromCharCode(92);
  assert.equal(plugin._matchesFilter("extras" + BACKSLASH + "bonus.mkv", "extras/"), true);
  assert.equal(plugin._matchesFilter("extras" + BACKSLASH + "bonus.mkv", "extras"), true);
});

test("every space-separated term must match", () => {
  // So "live flac" narrows rather than widening, which is what a filter box is
  // for — an OR would return more results the more you typed.
  const m = plugin._matchesFilter;
  assert.equal(m("Live At Wembley.flac", "live flac"), true);
  assert.equal(m("Studio Take.flac", "live flac"), false);
  assert.equal(m("Live At Wembley.mkv", "live flac"), false);
});

test("an empty or whitespace filter shows everything", () => {
  const m = plugin._matchesFilter;
  assert.equal(m("anything.flac", ""), true);
  assert.equal(m("anything.flac", "   "), true);
  assert.equal(m("anything.flac", null), true);
  assert.equal(m("anything.flac", undefined), true);
});

test("filterFiles keeps the matches and never mutates the input", () => {
  const files = [
    { index: 0, name: "01.flac" },
    { index: 1, name: "extras/clip.mkv" },
    { index: 2, name: "02.flac" },
  ];
  const kept = plugin._filterFiles(files, "flac");
  assert.deepEqual(kept.map((f) => f.index), [0, 2]);
  assert.equal(files.length, 3);
  // An empty filter returns a copy, not the caller's array.
  const all = plugin._filterFiles(files, "");
  assert.deepEqual(all.map((f) => f.index), [0, 1, 2]);
  assert.notEqual(all, files);
});

// --- folders in the row title ------------------------------------------------

test("a file's folder becomes part of its row title", () => {
  // parseFileTrack strips the path, so the row used to show leaves only: two
  // "01"s from CD1 and CD2 were the same row twice, and a folder of scans was
  // indistinguishable from tracks at the torrent's root.
  assert.equal(plugin._fileFolder("CD1/01 - Song.flac"), "CD1");
  assert.equal(plugin._fileFolder("extras/scans/front.jpg"), "extras / scans");
  assert.equal(plugin._fileFolder("01 - Song.flac"), "");
  assert.equal(plugin._fileFolder(""), "");
  assert.equal(plugin._fileFolder(null), "");
});

test("either separator works — the path comes from the .torrent, not this machine", () => {
  const B = String.fromCharCode(92);
  assert.equal(plugin._fileFolder("extras" + B + "bonus.mkv"), "extras");
  assert.equal(plugin._baseName("extras" + B + "bonus.mkv"), "bonus.mkv");
});

test("empty path segments don't become empty crumbs", () => {
  // A leading slash or a doubled one would otherwise render as " / extras".
  assert.equal(plugin._fileFolder("/extras/a.flac"), "extras");
  assert.equal(plugin._fileFolder("a//b/c.flac"), "a / b");
});

test("baseName keeps a file that has no folder", () => {
  assert.equal(plugin._baseName("cover.jpg"), "cover.jpg");
  assert.equal(plugin._baseName(""), "");
});

// --- the torrent's own wrapper folder ----------------------------------------

test("the folder every file shares is not repeated on every row", () => {
  // Almost every torrent wraps its contents in one directory named after the
  // release. The hero title above the list already says it, so repeating it on
  // each row is a column of the same words that pushes the distinguishing part
  // off the end.
  const files = [
    { name: "Artist - Album [FLAC]/CD1/01.flac" },
    { name: "Artist - Album [FLAC]/CD2/01.flac" },
    { name: "Artist - Album [FLAC]/folder.jpg" },
  ];
  const common = plugin._commonFolder(files);
  assert.deepEqual(common, ["Artist - Album [FLAC]"]);
  assert.equal(plugin._fileFolder(files[0].name, common), "CD1");
  assert.equal(plugin._fileFolder(files[2].name, common), "");
});

test("everything under one folder strips down to bare filenames", () => {
  // Nothing distinguishes the rows by folder, so the crumb is pure noise.
  const files = [
    { name: "Release/Album/01.flac" },
    { name: "Release/Album/02.flac" },
  ];
  assert.deepEqual(plugin._commonFolder(files), ["Release", "Album"]);
  assert.equal(plugin._fileFolder(files[0].name, plugin._commonFolder(files)), "");
});

test("a file at the root means nothing is stripped from the others", () => {
  // There is no shared wrapper, so removing a segment from the nested files
  // would be inventing one.
  const files = [
    { name: "readme.nfo" },
    { name: "CD1/01.flac" },
  ];
  assert.deepEqual(plugin._commonFolder(files), []);
  assert.equal(plugin._fileFolder("CD1/01.flac", []), "CD1");
});

test("a single wrapped file still loses its wrapper", () => {
  const files = [{ name: "Some Release/track.flac" }];
  assert.deepEqual(plugin._commonFolder(files), ["Some Release"]);
  assert.equal(plugin._fileFolder(files[0].name, plugin._commonFolder(files)), "");
});

test("commonFolder copes with an empty or absent list", () => {
  assert.deepEqual(plugin._commonFolder([]), []);
  assert.deepEqual(plugin._commonFolder(undefined), []);
});

test("a folder that merely starts the same is not a shared folder", () => {
  // Segment-wise, not string-prefix: "CD1" and "CD10" share no folder.
  const files = [{ name: "CD1/a.flac" }, { name: "CD10/b.flac" }];
  assert.deepEqual(plugin._commonFolder(files), []);
});

// What a file row offers. The junk that comes with every release — cover art,
// .nfo, a scans folder — is not playable, and offering Play / Add to queue on
// it queued nothing and then reported "nothing there that's finished
// downloading" about a file the same row showed as complete.
test("a finished media file offers Play and Add to queue", () => {
  assert.deepEqual(plugin._fileRowActions("audio", true, false), {
    actions: ["qbt:play-file", "qbt:enqueue-file"],
    action: "qbt:play-file",
  });
  assert.deepEqual(plugin._fileRowActions("video", true, false).actions, [
    "qbt:play-file",
    "qbt:enqueue-file",
  ]);
});

test("a finished NON-media file offers nothing at all", () => {
  // Not Play or Add to queue (there is nothing to play), and not Download or
  // Skip either — the bytes are already here, and "skip" would only stop
  // seeding a file the user has.
  assert.deepEqual(plugin._fileRowActions(null, true, false), { actions: [], action: null });
  // Including one that was deselected and downloaded anyway.
  assert.deepEqual(plugin._fileRowActions(null, true, true), { actions: [], action: null });
});

test("a downloaded file plays even if it was later deselected", () => {
  // Downloaded wins over deselected in both the status ("Downloaded") and the
  // actions: the bytes are on disk, so a media file plays whatever its
  // priority. Deselecting a file you already have doesn't un-download it.
  assert.deepEqual(plugin._fileRowActions("audio", true, true), {
    actions: ["qbt:play-file", "qbt:enqueue-file"],
    action: "qbt:play-file",
  });
  assert.deepEqual(plugin._fileRowActions("video", true, true).actions, ["qbt:play-file", "qbt:enqueue-file"]);
});

test("an unfinished file offers the choice it is not already in", () => {
  // This applies to junk as much as to media: skipping a 4 GB video extra is a
  // main reason to open the list at all.
  assert.deepEqual(plugin._fileRowActions("audio", false, false), {
    actions: ["qbt:file-skip"],
    action: "qbt:file-skip",
  });
  assert.deepEqual(plugin._fileRowActions("audio", false, true), {
    actions: ["qbt:file-download"],
    action: "qbt:file-download",
  });
  assert.deepEqual(plugin._fileRowActions(null, false, true), {
    actions: ["qbt:file-download"],
    action: "qbt:file-download",
  });
});

// The toolbar acts on a whole selection, so a mixed one can still reach a play
// with nothing playable in it. The refusal has to say which of the two reasons
// applies rather than claiming a finished file is unfinished.
test("unplayableReason blames the format when nothing selected is media", () => {
  assert.equal(
    plugin._unplayableReason([{ name: "cover.jpg", progress: 1 }]),
    "That isn't an audio or video file",
  );
  assert.equal(
    plugin._unplayableReason([{ name: "cover.jpg", progress: 1 }, { name: "info.nfo", progress: 1 }]),
    "None of those are audio or video files",
  );
});

test("unplayableReason blames the download when media is still coming", () => {
  assert.equal(
    plugin._unplayableReason([{ name: "01.flac", progress: 0.4 }]),
    "That file hasn't finished downloading yet",
  );
  // A mixed selection with any media in it is about the download, not the
  // format — the media file is the one the user was trying to play.
  assert.equal(
    plugin._unplayableReason([{ name: "cover.jpg", progress: 1 }, { name: "01.flac", progress: 0.4 }]),
    "Nothing there that's finished downloading",
  );
});

test("unplayableReason copes with an empty selection", () => {
  assert.equal(plugin._unplayableReason([]), "Nothing selected");
  assert.equal(plugin._unplayableReason(undefined), "Nothing selected");
});
