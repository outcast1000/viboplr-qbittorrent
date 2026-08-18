const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// --- the row -----------------------------------------------------------------

test("a torrent row leads with the name and keeps the size on the detail line", () => {
  // The name is what you read the list for. Size sits with the file count
  // rather than in a trailing column — the two answer one question together,
  // and a column pulled them to opposite ends of the row.
  const row = plugin._torrentRow({
    hash: "abc",
    name: "Some Artist - Album (1998) [FLAC]",
    state: "downloading",
    progress: 0.42,
    total_size: 1024 * 1024 * 500,
    dlspeed: 2048,
    eta: 300,
  });
  assert.equal(row.id, "abc");
  assert.equal(row.title, "Some Artist - Album (1998) [FLAC]");
  assert.match(row.subtitle, /^Downloading/);
  assert.match(row.subtitle, /500 MB/);
  assert.equal(row.duration, undefined, "size is still in a trailing column too");
});

test("size is the torrent's real weight, not what happens to be selected", () => {
  // `size` is the WANTED size and reads 0 B while nothing is picked; only
  // `total_size` says what the torrent actually weighs.
  const row = plugin._torrentRow({
    hash: "abc", name: "x", state: "stoppedDL", progress: 0,
    size: 0, total_size: 910 * 1024 * 1024,
  });
  assert.match(row.subtitle, /910 MB/);
});

test("size lands immediately after the file count", () => {
  // They answer "how much is this?" together, so they read together.
  const row = plugin._torrentRow({
    hash: "abc", name: "x", state: "downloading", progress: 0.5,
    total_size: 1024 * 1024 * 500, dlspeed: 1, eta: 60,
  });
  const parts = row.subtitle.split("  ·  ");
  // No file count is known here, so size follows the status directly; with a
  // count present it follows the count. Either way nothing comes between them.
  assert.equal(parts[1], "500 MB");
});

test("a torrent row's status leads the subtitle", () => {
  const rows = {
    downloading: plugin._torrentRow({ hash: "a", name: "x", state: "downloading", progress: 0.5 }),
    seeding: plugin._torrentRow({ hash: "b", name: "x", state: "stalledUP", progress: 1 }),
    paused: plugin._torrentRow({ hash: "c", name: "x", state: "stoppedDL", progress: 0.2 }),
  };
  assert.match(rows.downloading.subtitle, /^Downloading/);
  assert.match(rows.seeding.subtitle, /^Seeding/);
  assert.match(rows.paused.subtitle, /^Paused/);
});

test("a torrent row shows transfer facts that match its direction", () => {
  // A finished torrent has no ETA and no download speed worth printing; an
  // unfinished one has no ratio worth printing.
  const down = plugin._torrentRow({ hash: "a", name: "x", state: "downloading", progress: 0.5, dlspeed: 2048, eta: 300 });
  assert.match(down.subtitle, /ETA 5m/);
  assert.ok(!/ratio/.test(down.subtitle), down.subtitle);
  const done = plugin._torrentRow({ hash: "b", name: "x", state: "stalledUP", progress: 1, ratio: 1.25 });
  assert.match(done.subtitle, /ratio 1\.25/);
  assert.ok(!/ETA/.test(done.subtitle), done.subtitle);
});

test("a magnet with no name yet still names the row", () => {
  // Rendering a bare hash as the title is what an un-named row used to do, and
  // a 40-character hex string tells the user nothing about what they added.
  const row = plugin._torrentRow({
    hash: "abc",
    state: "metaDL",
    progress: 0,
    magnet_uri: "magnet:?xt=urn:btih:abc&dn=Some+Release+Name",
  });
  assert.equal(row.title, "Some Release Name");
});

test("a torrent row opens its contents on double-click", () => {
  // Without a per-row action the host's selectable list only SELECTS on click.
  // For a container, "open it" is the natural double-click — Play is the first
  // overlay button instead.
  assert.equal(plugin._torrentRow({ hash: "a", name: "x", state: "downloading" }).action, "qbt:show-files");
});

// --- the percentage badge ----------------------------------------------------

test("the percentage floors rather than rounds", () => {
  // 99.7% must not read as a finished download.
  assert.equal(plugin._torrentPercent({ progress: 0.997 }), "99%");
  assert.equal(plugin._torrentPercent({ progress: 1 }), "100%");
  assert.equal(plugin._torrentPercent({ progress: 0 }), "0%");
});

test("a missing or absurd progress reads as 0%, not NaN%", () => {
  assert.equal(plugin._torrentPercent({}), "0%");
  assert.equal(plugin._torrentPercent({ progress: -1 }), "0%");
  assert.equal(plugin._torrentPercent({ progress: 4 }), "100%");
  assert.equal(plugin._torrentPercent(null), "0%");
});

test("the percentage is of the whole torrent, not of the selected files", () => {
  // `progress` is progress against the SELECTION, so a release with one small
  // file picked out of it claims to be finished while nearly all of it is
  // missing. completed/total_size is the honest figure, and both fields arrive
  // on every poll — no extra request to draw a 1000-row list.
  const cherryPicked = { progress: 1, completed: 3 * 1024 * 1024, total_size: 700 * 1024 * 1024, size: 3 * 1024 * 1024 };
  assert.equal(plugin._torrentPercent(cherryPicked), "0%");
  assert.equal(plugin._torrentPercent({ progress: 1, completed: 350, total_size: 700 }), "50%");
  // The parked case this replaced a special-case for: nothing selected, so
  // qBittorrent calls it complete and seeds it, having downloaded nothing.
  assert.equal(plugin._torrentPercent({ progress: 1, completed: 0, total_size: 700 }), "0%");
});

test("a cached file list is used in preference, and counts deselected files", () => {
  // The one thing completed/total_size cannot see: a file downloaded and LATER
  // deselected. Its bytes are on disk and drop out of `completed`, so the
  // torrent would appear to have lost half of itself.
  const t = { progress: 1, completed: 0, total_size: 200 };
  const files = [
    { size: 100, progress: 1, priority: 0 },
    { size: 100, progress: 0, priority: 1 },
  ];
  assert.equal(plugin._torrentPercent(t, files), "50%");
  // Priority is ignored entirely — this is a question about bytes.
  assert.equal(plugin._torrentPercent(t, [{ size: 100, progress: 1, priority: 0 }]), "100%");
  // Sizeless entries can't be weighed, so the torrent's own numbers answer.
  assert.equal(plugin._torrentPercent({ progress: 0.5 }, [{ progress: 1 }]), "50%");
});

test("a torrent with no size yet still reports its progress", () => {
  // A magnet still asking the swarm has no total_size to divide by, and
  // falling through to 0% would freeze the badge for the whole wait.
  assert.equal(plugin._torrentPercent({ progress: 0.42 }), "42%");
  assert.equal(plugin._torrentPercent({ progress: 0.42, total_size: 0 }), "42%");
  // A torrent reporting a size but no `completed` field yet, likewise.
  assert.equal(plugin._torrentPercent({ progress: 0.42, total_size: 700 }), "42%");
});

// --- which actions a row offers ----------------------------------------------

test("a row offers Start or Stop, never both", () => {
  // They are one control in two states — qBittorrent has no third — so showing
  // both always left one that would do nothing on every row.
  const stopped = plugin._torrentRowActions({ hash: "a", state: "stoppedDL" });
  const running = plugin._torrentRowActions({ hash: "b", state: "downloading" });
  assert.ok(stopped.indexOf("qbt:start") >= 0 && stopped.indexOf("qbt:stop") < 0, stopped.join());
  assert.ok(running.indexOf("qbt:stop") >= 0 && running.indexOf("qbt:start") < 0, running.join());
  // Seeding is running too, and paused-era state names still read as stopped.
  assert.ok(plugin._torrentRowActions({ hash: "c", state: "stalledUP" }).indexOf("qbt:stop") >= 0);
  assert.ok(plugin._torrentRowActions({ hash: "d", state: "pausedUP" }).indexOf("qbt:start") >= 0);
});

test("Remove is always there, whatever the torrent is doing", () => {
  assert.ok(plugin._torrentRowActions({ hash: "a", state: "error" }).indexOf("qbt:delete-ask") >= 0);
  assert.ok(plugin._torrentRowActions({ hash: "b", state: "metaDL" }).indexOf("qbt:delete-ask") >= 0);
});

test("Play is hidden when nothing in the torrent can be playing yet", () => {
  // Not one byte on disk, so whatever is inside, none of it is playable.
  const empty = { hash: "a", state: "downloading", progress: 0, completed: 0, total_size: 700 };
  assert.ok(plugin._torrentRowActions(empty).indexOf("qbt:play-torrent") < 0);
  // Part-downloaded with no per-file detail: it MIGHT be playable, and hiding
  // Play on a torrent that turns out to be playable is the worse mistake —
  // pressing it on one that isn't explains itself.
  const partial = { hash: "b", state: "downloading", progress: 0.5, completed: 350, total_size: 700 };
  assert.ok(plugin._torrentRowActions(partial).indexOf("qbt:play-torrent") >= 0);
});

test("the badge colour is the number on it: red, yellow, green", () => {
  // A traffic light for "have I got this?" — the one question four characters
  // of badge can answer. The state has better places to live and is in all of
  // them: the row's status text, the sort order, and which of Start / Stop it
  // offers.
  const band = plugin._progressBand;
  assert.equal(band(0).fill, "#bf2c37");
  assert.equal(band(0.5).fill, "#e3b341");
  assert.equal(band(1).fill, "#1a7f37");
});

test("the colour follows the DISPLAYED percentage, never the raw fraction", () => {
  const band = plugin._progressBand;
  // 0.4% floors to "0%", so a badge reading 0% is red — not yellow over a
  // number that says nothing has arrived.
  assert.equal(band(0.004).fill, band(0).fill);
  // 99.7% floors to "99%" and must not wear the finished colour.
  assert.equal(band(0.997).fill, band(0.5).fill);
  // Exactly 100% is the only green.
  assert.notEqual(band(0.999).fill, band(1).fill);
});

test("a nonsense fraction still lands in a band", () => {
  const band = plugin._progressBand;
  assert.equal(band(-1).fill, band(0).fill);
  assert.equal(band(4).fill, band(1).fill);
  assert.equal(band(undefined).fill, band(0).fill);
  assert.equal(band(NaN).fill, band(0).fill);
});

test("each band brings text that can be read on it", () => {
  // The yellow that reads as yellow needs dark text where the other two need
  // light; one shared choice makes at least one badge unreadable.
  const band = plugin._progressBand;
  assert.equal(band(0.5).text, "#1a1a1a");
  assert.equal(band(0).text, "#ffffff");
  assert.equal(band(1).text, "#ffffff");
});

// --- file tiles --------------------------------------------------------------

test("a deselected file reads 'skip', not a percentage that will never move", () => {
  const skip = plugin._fileIconFor({ name: "extra.mkv", priority: 0, progress: 0 });
  assert.match(decodeURIComponent(skip), />skip</);
  // And it is not the colour of a file that IS downloading.
  assert.notEqual(skip, plugin._fileIconFor({ name: "extra.mkv", priority: 1, progress: 0 }));
});

test("a file's tile carries its own progress", () => {
  const running = { state: "downloading" };
  assert.match(decodeURIComponent(plugin._fileIconFor({ name: "a.flac", priority: 1, progress: 1 }, running)), />100%</);
  assert.match(decodeURIComponent(plugin._fileIconFor({ name: "a.flac", priority: 1, progress: 0.45 }, running)), />45%</);
  // Floored, for the same reason a torrent's is.
  assert.match(decodeURIComponent(plugin._fileIconFor({ name: "a.flac", priority: 1, progress: 0.999 }, running)), />99%</);
});

// --- the contents panel ------------------------------------------------------

test("the contents panel survives its torrent being removed underneath it", () => {
  // Removed here or in qBittorrent while the panel was open. Rendering an empty
  // panel with no explanation and no way back is the failure this guards.
  const nodes = plugin._torrentDetailNodes("not-a-real-hash");
  assert.ok(nodes.length >= 2);
  assert.match(nodes[0].content, /no longer in qBittorrent/);
  const back = nodes.find((n) => n.type === "button" && n.action === "qbt:close-files");
  assert.ok(back, "no way back to the list");
});

test("a torrent parked with nothing selected is not coloured as complete", () => {
  // The shape qBittorrent really reports for it: 100% and seeding, because
  // nothing is wanted so nothing is missing. Green here would tell the user
  // their download had finished when not a byte of it exists.
  //
  // This used to need a special case in the band. It doesn't now: the badge is
  // fed torrentFraction, which measures the whole torrent, so a parked one is
  // 0% and red for the same reason it reads "0%" — one number decides both.
  const parked = { hash: "p", state: "stalledUP", progress: 1, completed: 0, total_size: 700 };
  const reallyDone = { hash: "d", state: "stalledUP", progress: 1, completed: 700, total_size: 700 };
  const bandOf = (t) => plugin._progressBand(plugin._torrentFraction(t));
  assert.notEqual(bandOf(parked).fill, bandOf(reallyDone).fill);
  assert.equal(bandOf(parked).fill, bandOf({ hash: "h", progress: 0 }).fill);
});

// --- per-file state ----------------------------------------------------------

test("a deselected file is never described as downloading", () => {
  const running = { state: "downloading" };
  assert.equal(plugin._fileState({ priority: 0, progress: 0 }, running), "skipped");
  assert.equal(plugin._fileStatusText({ priority: 0, progress: 0 }, running), "Not selected for download");
  // Including when it is partly on disk already — deselecting a half-downloaded
  // file stops it, and the remainder is not coming.
  assert.equal(plugin._fileState({ priority: 0, progress: 0.45 }, running), "skipped");
  assert.equal(plugin._fileStatusText({ priority: 0, progress: 0.45 }, running), "Not selected for download");
});

test("a fully-downloaded file reads Downloaded even when deselected", () => {
  // Downloaded wins over deselected: bytes on disk are on disk. Deselecting a
  // file you already have (to stop seeding it) doesn't un-download it, so
  // "Not selected" would hide that it is sitting there, playable.
  const running = { state: "downloading" };
  assert.equal(plugin._fileState({ priority: 0, progress: 1 }, running), "done");
  assert.equal(plugin._fileStatusText({ priority: 0, progress: 1 }, running), "Downloaded");
});

test("a priority that arrives as a string still means deselected", () => {
  // THE bug: `typeof f.priority === "number"` rejected "0" and fell through to
  // the default of 1, so a file the user had deselected came back marked for
  // download and its row read "Downloading 0%" about a file that would never
  // move. Where a default is needed the SAFE direction has to win.
  assert.equal(plugin._fileState({ priority: "0", progress: 0 }, { state: "downloading" }), "skipped");
  assert.equal(plugin._numOr("0", 1), 0);
  assert.equal(plugin._numOr("0.42", 0), 0.42);
  // And a genuinely absent field still falls back rather than becoming NaN.
  assert.equal(plugin._numOr(undefined, 1), 1);
  assert.equal(plugin._numOr(null, 1), 1);
  assert.equal(plugin._numOr("", 1), 1);
  assert.equal(plugin._numOr("nonsense", 1), 1);
});

test("a selected file in a stopped torrent is not 'Downloading'", () => {
  // "Downloading" is a claim about the transfer, not about the file. A stopped
  // torrent transfers nothing, so every one of its files reading
  // "Downloading 0%" was simply untrue.
  const file = { priority: 1, progress: 0 };
  assert.equal(plugin._fileState(file, { state: "stoppedDL" }), "waiting");
  assert.equal(plugin._fileStatusText(file, { state: "stoppedDL" }), "Selected  ·  0%");
  assert.equal(plugin._fileState(file, { state: "pausedDL" }), "waiting");
  assert.equal(plugin._fileState(file, { state: "missingFiles" }), "waiting");
  // Running, and it is the real thing.
  assert.equal(plugin._fileState(file, { state: "downloading" }), "downloading");
  assert.match(plugin._fileStatusText(file, { state: "downloading" }), /^Downloading/);
});

test("with no torrent to ask, a file makes no claim about the transfer", () => {
  assert.equal(plugin._fileState({ priority: 1, progress: 0.3 }, null), "waiting");
});

test("a finished file reads Downloaded whatever the torrent is doing", () => {
  for (const state of ["downloading", "stoppedDL", "stalledUP"]) {
    assert.equal(plugin._fileState({ priority: 1, progress: 1 }, { state }), "done");
  }
});

test("a file's badge is banded by its own percentage, like a torrent's", () => {
  const f = (priority, progress) => ({ name: "a.flac", priority, progress });
  const running = { state: "downloading" };
  const tile = (file, torrent) => decodeURIComponent(plugin._fileIconFor(file, torrent || running));
  // Red at nothing, yellow part-way, green when it is all here.
  assert.match(tile(f(1, 0)), /#bf2c37/);
  assert.match(tile(f(1, 0.4)), /#e3b341/);
  assert.match(tile(f(1, 1)), /#1a7f37/);
  // Whether a part-downloaded file is moving or stopped is in its subtitle, in
  // words. Two files with the same bytes on disk now look the same, which is
  // the point of banding by the number.
  assert.equal(plugin._fileIconFor(f(1, 0.4), { state: "stoppedDL" }), plugin._fileIconFor(f(1, 0.4), running));
});

test("a file nobody asked for reads 'skip', in its own colour", () => {
  // Not a percentage, so it is not in the traffic light: 0% red would read as
  // "this failed" rather than "this was never wanted".
  const skip = decodeURIComponent(plugin._fileIconFor({ name: "extra.mkv", priority: 0, progress: 0 }, { state: "downloading" }));
  assert.match(skip, />skip</);
  assert.match(skip, /#6b7075/);
});

// --- swarm / torrent info formatters -----------------------------------------

test("availability of -1 is unknown, not zero copies", () => {
  // qBittorrent sends -1 before it has worked it out. Rendering that as 0.00
  // would say no reachable peer has the whole torrent, which is a verdict.
  assert.equal(plugin._formatAvailability(-1), "—");
  assert.equal(plugin._formatAvailability(undefined), "—");
  assert.equal(plugin._formatAvailability(0), "0.00");
  assert.equal(plugin._formatAvailability(2.3456), "2.35");
  assert.equal(plugin._formatAvailability("1.5"), "1.50");
});

test("a duration is never the ETA sentinel", () => {
  // formatEta returns ∞ past 100 days; a torrent seeding for four months has a
  // real answer and "∞" is not it.
  assert.equal(plugin._formatDuration(120 * 86400), "120d 0h");
  assert.equal(plugin._formatDuration(90000), "1d 1h");
  assert.equal(plugin._formatDuration(3900), "1h 5m");
  assert.equal(plugin._formatDuration(300), "5m");
  assert.equal(plugin._formatDuration(45), "45s");
  assert.equal(plugin._formatDuration(0), "—");
  assert.equal(plugin._formatDuration(undefined), "—");
});

test("ages read in the coarsest unit that is still true", () => {
  const now = 1_700_000_000_000;
  const ago = (secs) => plugin._formatAge(now / 1000 - secs, now);
  assert.equal(ago(10), "just now");
  assert.equal(ago(600), "10 min ago");
  assert.equal(ago(3600), "an hour ago");
  assert.equal(ago(86400), "yesterday");
  assert.equal(ago(3 * 86400), "3 days ago");
  assert.equal(ago(60 * 86400), "2 months ago");
  assert.equal(ago(400 * 86400), "a year ago");
  // Never asked, never happened.
  assert.equal(plugin._formatAge(0, now), "—");
  assert.equal(plugin._formatAge(undefined, now), "—");
});

// --- swarm on the row --------------------------------------------------------

test("a row shows connected AND total for both swarms", () => {
  // Either figure alone misleads: 2 connected is a routing problem if 300 exist
  // and a dead release if 2 do.
  const row = plugin._torrentRow({
    hash: "a", name: "x", state: "downloading", progress: 0.5,
    num_seeds: 12, num_complete: 40, num_leechs: 3, num_incomplete: 9,
  });
  assert.match(row.subtitle, /12\/40 seeds/);
  assert.match(row.subtitle, /3\/9 leechers/);
});

test("a bare count agrees with itself", () => {
  // "1 leechers" — the plural slipped through until a real render showed it.
  // With a total it stays plural, because "1/9 seeds" reads as a ratio.
  assert.equal(plugin._swarmText(1, -1, "leecher", "leechers"), "1 leecher");
  assert.equal(plugin._swarmText(1, 9, "seed", "seeds"), "1/9 seeds");
  assert.equal(plugin._swarmText(0, -1, "seed", "seeds"), "0 seeds");
});

test("an unreported swarm size is omitted, not faked", () => {
  // qBittorrent sends -1 for "the tracker hasn't said". "12 of -1" is nonsense
  // and "12 of 0" claims fewer exist than you are already connected to.
  const seeds = (c, t) => plugin._swarmText(c, t, "seed", "seeds");
  assert.equal(seeds(12, -1), "12 seeds");
  assert.equal(seeds(12, undefined), "12 seeds");
  assert.equal(seeds(12, 40), "12/40 seeds");
  assert.equal(plugin._swarmText(0, 0, "leecher", "leechers"), "0/0 leechers");
  // Inconsistent data (more connected than exist) drops the total rather than
  // printing something self-contradictory.
  assert.equal(seeds(12, 3), "12 seeds");
  // A missing connected count is zero, not NaN.
  assert.equal(seeds(undefined, 40), "0/40 seeds");
  assert.equal(seeds(-1, 40), "0/40 seeds");
});
