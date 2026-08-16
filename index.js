// viboplr-qbittorrent — control a qBittorrent WebUI from Viboplr.
//
// Design notes:
//  - Auth is an API KEY, and only an API key. qBittorrent 5.2 added them and
//    they remove every moving part a session has: no login round trip, no
//    cookie whose name changes between versions (it did, in 5.2), no expiry,
//    and nothing the failed-login IP ban can lock out. The key rides on every
//    request as an Authorization: Bearer header.
//  - There is deliberately NO username/password path. Supporting both meant
//    two auth flows, two failure vocabularies and a session layer that existed
//    only for the weaker one.
//  - A qBittorrent with "Bypass authentication for clients on localhost" needs
//    no key at all: an empty key simply sends no header, and that works.
//  - Endpoint names moved in qBittorrent 5.0 (WebAPI 2.11): /torrents/pause ->
//    /torrents/stop and /resume -> /start. The version is probed once per
//    session rather than guessed or discovered by trying both.
//  - Everything this plugin ADDS is tagged with a category, and bulk actions are
//    scoped to it by default. A "Pause all" that reaches a user's unrelated
//    seedbox torrents would be unforgivable, so the blast radius is a setting,
//    not an assumption.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var VIEW_ID = "qbittorrent";
var SETTINGS_ID = "qbittorrent-settings";
var STORAGE_KEY = "settings";

// Every request carries a timeout. The host imposes none by default, so an
// unreachable server (a sleeping NAS, a wrong port) would otherwise hang the
// promise until the OS gives up — and a poll loop would stack those forever.
var REQUEST_TIMEOUT_MS = 15000;

var MIN_POLL_MS = 2000;
var MAX_POLL_MS = 60000;

// The host version that first exposed HTTP response headers to plugins. Below
// it, reading qBittorrent's session cookie is impossible and the plugin can only
// work against a WebUI with localhost auth bypass turned on. manifest.json's
// minAppVersion blocks a gallery install on an older host, but a side-loaded or
// dev copy can still land on one — so it is checked at runtime and SAID, rather
// than surfacing later as a baffling "session rejected".
var MIN_HOST_VERSION = "1.0.27";
// The host release that classifies a non-http stream candidate properly instead
// of assuming every candidate is a network stream. Below it, reporting a
// `file://` candidate breaks playback outright — see the stream resolver.
//
// Everything else this plugin gained alongside it degrades on its own: an older
// host ignores `openOnClick`, `plain`, `buttons`, `selectionPresets` and a row's
// `actions` subset, which costs polish and not function. Only this one needs a
// gate, so only this one has one.
var HOST_FILE_CANDIDATE = "1.0.28";

// The qBittorrent this plugin requires. API keys arrived in 5.2 and this is the
// build the plugin is developed against — below it the only sign-in it has does
// not exist, so this is a requirement rather than a preference.
var MIN_QBT_VERSION = "5.2.3";

// Where to get it. Offered as a button wherever the plugin says the version is
// the problem, because "update qBittorrent" is not an instruction anyone can act
// on without leaving to go and find the download.
var QBT_DOWNLOAD_URL = "https://www.qbittorrent.org/download";

// qBittorrent reports "no estimate" as this sentinel rather than null.
var ETA_INFINITY = 8640000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var api = null;

// Settings (persisted).
var baseUrl = "";
// Optional. qBittorrent 5.2+ accepts an API key instead of a login; when set it
// replaces the username/password entirely.
var apiKey = "";
// Settings saved before this plugin dropped username/password auth.
var hadLegacyCredentials = false;
var category = "viboplr";
var restrictToCategory = true;
var insecure = false;
var pollMs = 5000;
// Remote → local prefix rewrite, for a qBittorrent on another machine whose
// download directory is mounted here under a different root.
var pathMapFrom = "";
var pathMapTo = "";
// Collection id to save new torrents into ("" = leave it to qBittorrent).
var destCollectionId = "";
// Rescan the owning collection when a download finishes.
var autoImport = true;
// Add torrents paused so their contents can be chosen before anything downloads.
var chooseFilesFirst = false;

// Draft settings — what the settings panel's inputs currently hold. Kept apart
// from the live values so a half-typed password never reaches storage and never
// takes down a working session mid-keystroke.
var draft = null;

// Session.
var apiVersion = null; // WebAPI version, e.g. "2.11.2"
var qbtVersion = null; // qBittorrent's own version, e.g. "v5.0.4"
var hostTooOld = false; // this Viboplr predates MIN_HOST_VERSION

// Data.
var torrents = {};
// Kept because /sync/maindata sends it as a delta that mergeMaindata has to
// carry forward — nothing renders it since the list's stats row was removed.
var serverState = {};
var rid = 0;
var connected = false;
var lastError = null;
var busy = null; // hash currently mid-action, for button disabling
var pendingDelete = null; // hashes awaiting delete confirmation

// Files (per torrent, fetched on demand when a row is expanded).
var filesByHash = {};
var expandedHash = null;
var filesLoading = null;
// Torrents added paused and waiting for the user to pick files, and the ones
// temporarily started only to fetch their metadata. Session-only: an interrupted
// selection should not outlive a restart as a mysteriously paused torrent.
var pendingSelection = {};
var metadataFetching = {};
// Added only to look inside. Same paused hold, different framing: nothing has
// been decided, so discarding is the expected outcome, not the exception.
var peekedTorrents = {};
// Peeked torrents that are now RUNNING with every file deselected, so that
// including a file starts it downloading on the spot rather than after a second
// "Start download" press. See armPeek().
var armedPeek = {};
// Which tab the contents panel is showing. Global rather than per torrent: it is
// a lens on the panel, not a property of the torrent, and carrying it across
// means opening the next torrent shows what you were last looking at.
var detailTab = "files";
// Seconds spent waiting on each torrent's metadata. A magnet can take a minute,
// and a counter that climbs is the one honest answer to "is this still working?"
// — the same reason the host's download modal always shows elapsed time.
var metadataElapsed = {};
// True from pressing Add/View contents until the torrent has been matched to a
// row. Before that there is no row to put a message on, so the view carries one.
var preparingAdd = false;
var preparingElapsed = 0;

// Search.
var searchQuery = "";
var searchResults = [];
var searchRunning = false;
var searchError = null;
var searchPlugins = null; // null = not asked yet, [] = none installed
var searchJobId = null;
var searchGen = 0; // guards a late poll against a newer search
var searchStopped = false; // the user cut it short, so "no results" isn't a verdict

// Local collections, and which torrents we have already seen finish.
var localCollections = [];
var knownComplete = {};
var completionsSeeded = false;
var categoryEnsured = false;
// The category in force before the user last changed it. Kept so the torrents
// left behind under the old name can be found and offered a move — otherwise
// renaming the category makes every previous download vanish from the list with
// no explanation and no way back except turning the filter off.
var previousCategory = "";

// UI.
var activeTab = "torrents";
var pollTimer = null;
var stopped = false;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Accepts what people actually paste: a bare host:port, a full URL, or a WebUI
// link complete with its "#/downloads" route. The path is KEPT (minus a
// trailing slash) because a reverse-proxied qBittorrent legitimately lives at a
// subpath like /qbt — only the hash/query, which are client-side routing, go.
function normalizeBaseUrl(raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/[?#].*$/, "");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

// Numeric-segment version compare. Returns -1, 0 or 1.
function compareVersions(a, b) {
  var pa = String(a || "0").split(".");
  var pb = String(b || "0").split(".");
  var len = Math.max(pa.length, pb.length);
  for (var i = 0; i < len; i++) {
    var na = parseInt(pa[i], 10);
    var nb = parseInt(pb[i], 10);
    if (isNaN(na)) na = 0;
    if (isNaN(nb)) nb = 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// WebAPI 2.11 (qBittorrent 5.0) renamed pause/resume to stop/start. The old
// names lingered as deprecated aliases for one release and then went away, so
// the new names are used wherever they exist rather than only where the old
// ones are gone.
function supportsStartStop(version) {
  if (!version) return false;
  return compareVersions(version, "2.11") >= 0;
}

// A JSON number that may have arrived as a numeric string. `null`/`""`/absent
// and anything unparseable fall back, but "0" and "0.42" are honoured — the
// whole point is that a real zero must not be mistaken for a missing field.
function numOr(v, fallback) {
  if (v === null || v === undefined || v === "") return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

function formatBytes(n) {
  // Explicit null check first: Number(null) is 0, so an absent size (a torrent
  // still fetching its metadata) would otherwise render as a confident "0 B".
  if (n === null || n === undefined || n === "") return "—";
  var v = Number(n);
  if (!isFinite(v) || v < 0) return "—";
  if (v < 1024) return v + " B";
  var units = ["KB", "MB", "GB", "TB"];
  var out = v / 1024;
  for (var i = 0; i < units.length; i++) {
    if (out < 1024 || i === units.length - 1) {
      return (out < 10 ? out.toFixed(1) : Math.round(out)) + " " + units[i];
    }
    out = out / 1024;
  }
  return "—";
}

function formatSpeed(n) {
  var v = Number(n);
  if (!isFinite(v) || v <= 0) return "—";
  return formatBytes(v) + "/s";
}

function formatEta(secs) {
  // Same trap as formatBytes: a missing ETA is "unknown", not "arriving now".
  if (secs === null || secs === undefined || secs === "") return "∞";
  var v = Number(secs);
  if (!isFinite(v) || v < 0 || v >= ETA_INFINITY) return "∞";
  if (v < 60) return Math.round(v) + "s";
  if (v < 3600) return Math.floor(v / 60) + "m";
  if (v < 86400) return Math.floor(v / 3600) + "h " + Math.floor((v % 3600) / 60) + "m";
  return Math.floor(v / 86400) + "d " + Math.floor((v % 86400) / 3600) + "h";
}

// qBittorrent's raw state strings are an implementation detail (and changed
// names in 5.0: pausedDL -> stoppedDL). Both spellings map to one label so the
// view reads the same on either version.
function torrentStateLabel(state) {
  switch (state) {
    case "downloading":
    case "forcedDL":
      return "Downloading";
    case "metaDL":
    case "forcedMetaDL":
      return "Fetching metadata";
    case "stalledDL":
      return "Stalled";
    case "uploading":
    case "forcedUP":
    case "stalledUP":
      return "Seeding";
    case "pausedDL":
    case "stoppedDL":
      return "Paused";
    case "pausedUP":
    case "stoppedUP":
      return "Complete";
    case "queuedDL":
    case "queuedUP":
      return "Queued";
    case "checkingDL":
    case "checkingUP":
    case "checkingResumeData":
      return "Checking";
    case "moving":
      return "Moving";
    case "allocating":
      return "Allocating";
    case "error":
    case "missingFiles":
      return "Error";
    default:
      return state ? String(state) : "Unknown";
  }
}

function isComplete(t) {
  if (!t) return false;
  if (Number(t.progress) >= 1) return true;
  return /^(uploading|forcedUP|stalledUP|pausedUP|stoppedUP|queuedUP|checkingUP)$/.test(String(t.state || ""));
}

function isPaused(t) {
  return /^(paused|stopped)/.test(String((t && t.state) || ""));
}

// Every file in this torrent is set to "don't download".
//
// This is the state "View contents" deliberately parks a torrent in, and it is
// also reachable by deselecting everything by hand — so the test is on the
// FILES, not on the flag that got us there. Unknown files answer false, which
// leaves every caller behaving exactly as it did before this existed.
function nothingSelected(t) {
  var files = t && filesByHash[t.hash];
  if (!files || !files.length) return false;
  for (var i = 0; i < files.length; i++) {
    if (numOr(files[i].priority, 1) !== 0) return false;
  }
  return true;
}

// "Nothing will happen to this torrent until the user decides something" —
// either we are holding it for a decision, or it wants no files at all.
function needsChoice(t) {
  return !!(t && (pendingSelection[t.hash] || nothingSelected(t)));
}

// isComplete() answers what qBittorrent thinks. This answers what the user
// would call finished, and the two differ in one important case: a torrent with
// every file deselected has nothing left to want, so qBittorrent reports it
// 100% complete and starts seeding it. True, and completely misleading — not a
// byte has been downloaded. Anything that announces, imports, counts or colours
// a finished torrent must ask this one instead.
function isFinished(t) {
  if (!t) return false;
  if (pendingSelection[t.hash] || nothingSelected(t)) return false;
  return isComplete(t);
}

function isErrored(t) {
  return /^(error|missingFiles)$/.test(String((t && t.state) || ""));
}

// Merge a /sync/maindata delta into the previous snapshot.
//
// This is the one piece of real logic in the polling loop, and it is delta-based
// on purpose: qBittorrent sends ONLY the fields that changed for a torrent, so a
// naive replace would blank out every field it omitted (a torrent whose speed
// changed would lose its own name). full_update resets the world; torrents_removed
// deletes.
function mergeMaindata(prev, delta) {
  var d = delta || {};
  var prevTorrents = (prev && prev.torrents) || {};
  var next = {};
  var hash;

  if (!d.full_update) {
    for (hash in prevTorrents) {
      if (Object.prototype.hasOwnProperty.call(prevTorrents, hash)) next[hash] = prevTorrents[hash];
    }
  }

  var incoming = d.torrents || {};
  for (hash in incoming) {
    if (!Object.prototype.hasOwnProperty.call(incoming, hash)) continue;
    var merged = {};
    var existing = next[hash] || {};
    var k;
    for (k in existing) {
      if (Object.prototype.hasOwnProperty.call(existing, k)) merged[k] = existing[k];
    }
    for (k in incoming[hash]) {
      if (Object.prototype.hasOwnProperty.call(incoming[hash], k)) merged[k] = incoming[hash][k];
    }
    merged.hash = hash;
    next[hash] = merged;
  }

  var removed = d.torrents_removed || [];
  for (var i = 0; i < removed.length; i++) delete next[removed[i]];

  var server = {};
  var prevServer = (!d.full_update && prev && prev.serverState) || {};
  var sk;
  for (sk in prevServer) {
    if (Object.prototype.hasOwnProperty.call(prevServer, sk)) server[sk] = prevServer[sk];
  }
  var incomingServer = d.server_state || {};
  for (sk in incomingServer) {
    if (Object.prototype.hasOwnProperty.call(incomingServer, sk)) server[sk] = incomingServer[sk];
  }

  return {
    torrents: next,
    serverState: server,
    rid: typeof d.rid === "number" ? d.rid : (prev && prev.rid) || 0
  };
}

// What the "Add" box accepts. qBittorrent fetches an http(s) .torrent itself, so
// a URL is as good as a magnet; anything else is a typo worth rejecting before
// it becomes a confusing server-side error.
function looksLikeTorrentSource(text) {
  var s = String(text == null ? "" : text).trim();
  if (!s) return false;
  if (/^magnet:\?/i.test(s)) return true;
  return /^https?:\/\/\S+$/i.test(s);
}

// A magnet's display name, for showing something meaningful before qBittorrent
// has fetched the metadata.
function magnetDisplayName(uri) {
  var m = /[?&]dn=([^&]+)/i.exec(String(uri || ""));
  if (!m) return "";
  var raw = m[1].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    // A malformed percent-escape is not worth failing an add over.
    return raw;
  }
}

// Map a failure to a KIND, so the UI can name the actual fix instead of showing
// a transport string. Every branch here is a different thing for the user to go
// and do; that is the only reason a kind exists rather than one "error" state.
//
// Order matters: the specific session/auth phrases are this plugin's own error
// text and must be matched before the generic transport patterns, since "the
// session was rejected" contains none of them but a proxy error might.
function classifyConnectionError(message) {
  var m = String(message || "").toLowerCase();
  if (!m) return "unknown";
  if (/rejected the api key/.test(m)) return "apikey";
  if (/needs an api key/.test(m)) return "nokey";
  if (/timed out|timeout/.test(m)) return "timeout";
  // qBittorrent answered, but not as a WebUI would — usually the wrong path
  // (a reverse proxy subpath left off) or something else on that port.
  if (/http 404|http 502|http 503/.test(m)) return "notfound";
  if (/error sending request|connection refused|connection reset|dns|lookup|unreachable|certificate|tls|ssl/.test(m)) {
    return "unreachable";
  }
  return "unknown";
}

// The steps to get a WebUI running. Shown verbatim wherever setup is the answer,
// so the instructions can't drift between the empty view and the settings panel.
function setupSteps() {
  return [
    "In qBittorrent, open Tools → Options → Web UI and tick “Web User Interface (Remote control)”. Note the port (8080 by default).",
    "On that same screen, find API keys and create one. Copy it.",
    "Back here, enter the address (e.g. http://localhost:8080) and paste the key.",
    "Press Save & connect.",
    "API keys need qBittorrent " + MIN_QBT_VERSION + " or newer. On an older build, upgrade qBittorrent first."
  ];
}

// One place that decides what the user is told, everywhere. Returns
// { kind, label, detail, fix, tone } — `tone` picks the banner styling and
// `fix` is always an action, never a restatement of the problem.
function connectionStatus() {
  if (hostTooOld) {
    return {
      kind: "host",
      tone: "error",
      label: "Viboplr " + MIN_HOST_VERSION + " or newer is required",
      detail:
        "qBittorrent authenticates with a session cookie, and this version of Viboplr can't hand HTTP response headers to a plugin, so that cookie can't be read.",
      fix: "Update Viboplr from Settings → General. (A qBittorrent with “Bypass authentication for clients on localhost” switched on will work without it.)"
    };
  }
  // Reachable, but too old to have API keys at all — worth saying before the
  // user starts hunting for a key that their build cannot create.
  if (qbtVersion && compareVersions(String(qbtVersion).replace(/^v/i, ""), MIN_QBT_VERSION) < 0) {
    return {
      kind: "qbt-old",
      tone: "error",
      label: "qBittorrent " + MIN_QBT_VERSION + " or newer is required",
      detail: "This qBittorrent is " + qbtVersion + ". API keys were added in 5.2, and this plugin signs in with nothing else.",
      fix: "Update qBittorrent, then create a key under Tools → Options → Web UI."
    };
  }
  if (!baseUrl) {
    return {
      kind: "unconfigured",
      tone: "warning",
      label: "Not set up yet",
      detail: "No qBittorrent Web UI address has been entered.",
      fix: "Open Settings → qBittorrent and follow the setup steps."
    };
  }
  if (lastError) {
    var kind = classifyConnectionError(lastError);
    if (kind === "unreachable") {
      return {
        kind: kind,
        tone: "error",
        label: "Can't reach qBittorrent at " + baseUrl,
        detail: lastError,
        fix: "Check that qBittorrent is running and its Web UI is enabled (Tools → Options → Web UI), and that the address and port match. For an https WebUI with its own certificate, turn on “Allow self-signed certificates”."
      };
    }
    if (kind === "timeout") {
      return {
        kind: kind,
        tone: "error",
        label: "qBittorrent didn't answer in time",
        detail: "The address was reachable but nothing replied within " + Math.round(REQUEST_TIMEOUT_MS / 1000) + " seconds.",
        fix: "Check the port and any firewall between here and the server."
      };
    }
    if (kind === "nokey") {
      return {
        kind: kind,
        tone: "error",
        label: "qBittorrent wants an API key",
        detail: "The server is reachable but refused the request unauthenticated.",
        fix: "Create a key in qBittorrent under Tools → Options → Web UI and paste it into the API key box."
      };
    }
    if (kind === "apikey") {
      return {
        kind: kind,
        tone: "error",
        label: "qBittorrent rejected the API key",
        detail: "The server is reachable — the key is what it turned down. API keys need qBittorrent 5.2 or newer.",
        fix: "Check the key under qBittorrent's Tools → Options → Web UI — it may have been revoked or regenerated."
      };
    }
    if (kind === "notfound") {
      return {
        kind: kind,
        tone: "error",
        label: "That address answered, but not as a qBittorrent Web UI",
        detail: lastError,
        fix: "Check the address. If qBittorrent sits behind a reverse proxy, include the subpath (e.g. https://example.com/qbt)."
      };
    }
    return {
      kind: "unknown",
      tone: "error",
      label: "qBittorrent returned an error",
      detail: lastError,
      fix: "Check the server, then press Refresh. Settings → qBittorrent has the connection details."
    };
  }
  if (!connected) {
    return { kind: "connecting", tone: "warning", label: "Connecting…", detail: "", fix: "" };
  }
  return { kind: "ok", tone: "success", label: "Connected", detail: "", fix: "" };
}

// --- Files & playback -------------------------------------------------------

var AUDIO_EXT = /\.(mp3|flac|aac|m4a|wav|opus|wma|ogg|oga|aiff?|ape|wv|tta|dsf|dff|mpc|mka|caf)$/i;
var VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv)$/i;

function mediaKindOf(name) {
  var s = String(name || "");
  if (AUDIO_EXT.test(s)) return "audio";
  if (VIDEO_EXT.test(s)) return "video";
  return null;
}

// What a torrent NAME says it holds. A different question from mediaKindOf,
// which reads a file extension: a search result is a RELEASE name, and the only
// evidence in one is the tags people put there — "1080p x265", "[FLAC 24bit]",
// "320kbps". Both halves are boundary-anchored on non-alphanumerics rather than
// \b, so "24k" can't read as the "4K" tag and "Wave" can't read as "WAV".
var VIDEO_TAGS = /(?:^|[^a-z0-9])(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|8k|uhd|hdr|x26[45]|h ?\.?26[45]|hevc|avc|xvid|divx|blu-?ray|bdrip|brrip|bdremux|remux|web-?rip|hdtv|pdtv|dvd-?rip|dvd[59r]|hdrip|camrip|telesync|mkv|avi|webm|mp4|m4v|s\d{1,2}e\d{1,2})(?:[^a-z0-9]|$)/i;
var AUDIO_TAGS = /(?:^|[^a-z0-9])(?:flac|mp3|aac|alac|wav|aiff?|ogg|opus|m4a|m4b|ape|wma|dsd|dsf|dff|mqa|lossless|hi-?res|vinyl|cd-?rip|discography|\d{2,4} ?kbps|(?:16|24) ?-? ?bits?|\d{2,3}(?:\.\d)? ?khz)(?:[^a-z0-9]|$)/i;

// Video wins a tie on purpose. "Live At Wembley 1080p BluRay FLAC" is a video
// file whose audio track happens to be FLAC; calling it audio would promise an
// album and hand over four gigabytes of concert footage.
function classifyTorrentMedia(name) {
  var s = String(name || "");
  if (VIDEO_TAGS.test(s)) return "video";
  if (AUDIO_TAGS.test(s)) return "audio";
  // A single-file torrent is usually named after the file itself, so its
  // extension is the last thing worth asking.
  return mediaKindOf(s);
}

// The row thumbnail. The host draws INITIALS from the row title when a row has
// no image, which for a release name is two arbitrary letters repeated down the
// whole list — it occupies the most eye-catching part of the row and says
// nothing. A glyph for what the torrent actually is goes there instead.
//
// A data-URI SVG is the only thing a plugin can put in an image slot, so the
// colour is baked in rather than following the skin. It is therefore a mid-grey
// that stays legible on both light and dark surfaces, and it sits on the host's
// own themed `--bg-surface` tile. The viewBox is inset by 4 units because the
// host's `object-fit: cover` would otherwise crop the glyph to the tile edges.
var ICON_COLOR = "#8b9096";

// A musical note, a film strip, and a plain sheet for "the name doesn't say".
// Feather geometry, drawn in a 24x24 box and scaled into the tile below.
var MEDIA_GLYPHS = {
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  video:
    '<rect x="2" y="2" width="20" height="20" rx="2.2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  unknown: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>'
};

// Seeder bands. The seeder count is the one number that decides whether a
// torrent downloads at all or sits at 0 B/s forever, so it is ON the tile and
// colour-coded: while scrolling a list you read a colour, you do not read the
// third value of a subtitle sentence. Thresholds are the user's: >100 healthy,
// >10 thin, at or below that effectively dead.
//
// Each band carries its own text colour rather than sharing one, because the
// yellow that reads as yellow needs dark text and the other two need light —
// picking one for all three makes at least one badge unreadable.
var SEED_BANDS = [
  { over: 100, fill: "#1a7f37", text: "#ffffff" },
  { over: 10, fill: "#e3b341", text: "#1a1a1a" },
  { over: -1, fill: "#bf2c37", text: "#ffffff" }
];
// Not a fourth band: "the indexer didn't say" is not a verdict on the swarm,
// and colouring it red would condemn results that may be perfectly healthy.
var SEED_UNKNOWN = { fill: "#6b7075", text: "#ffffff" };

function seedBand(seeds) {
  if (seeds === null || seeds === undefined) return SEED_UNKNOWN;
  for (var i = 0; i < SEED_BANDS.length; i++) {
    if (seeds > SEED_BANDS[i].over) return SEED_BANDS[i];
  }
  return SEED_BANDS[SEED_BANDS.length - 1];
}

// Four characters is all that fits legibly across a 40px tile, so anything past
// 999 is thousands. The exact figure is still in the subtitle for whoever wants
// it — the badge only has to answer "is this worth clicking?".
function formatSeedCount(seeds) {
  if (seeds === null || seeds === undefined) return "?";
  if (seeds < 1000) return String(seeds);
  if (seeds < 10000) return (Math.floor(seeds / 100) / 10).toFixed(1) + "k";
  return Math.round(seeds / 1000) + "k";
}

// Progress bands for the Torrents list. The colour is the torrent's STATE, not
// its percentage: 90% stopped and 90% downloading are the same number and
// completely different situations, and the one thing you scan a list of
// transfers for is which rows are actually moving.
var PROGRESS_BANDS = {
  error: { fill: "#bf2c37", text: "#ffffff" },
  done: { fill: "#1a7f37", text: "#ffffff" },
  moving: { fill: "#1f6feb", text: "#ffffff" },
  waiting: { fill: "#e3b341", text: "#1a1a1a" },
  stopped: { fill: "#6b7075", text: "#ffffff" }
};

function progressBand(t, awaiting) {
  if (isErrored(t)) return PROGRESS_BANDS.error;
  // Above the completion check, not below it: a torrent with nothing selected
  // reports 100% complete, and green would tell the user their download had
  // finished when not a byte of it exists. Grey would file it with the ones
  // they stopped on purpose; this one is waiting on them.
  if (awaiting) return PROGRESS_BANDS.waiting;
  if (isComplete(t)) return PROGRESS_BANDS.done;
  if (isPaused(t)) return PROGRESS_BANDS.stopped;
  if (/^(downloading|forcedDL|metaDL|forcedMetaDL)$/.test(String((t && t.state) || ""))) return PROGRESS_BANDS.moving;
  return PROGRESS_BANDS.waiting; // queued, stalled, checking, moving, allocating
}

function torrentPercent(t) {
  var v = Number((t && t.progress) || 0);
  if (!isFinite(v) || v < 0) v = 0;
  if (v > 1) v = 1;
  // Floor, not round: 99.7% must not read as a finished download.
  return Math.floor(v * 100) + "%";
}

// The tile: the media glyph over a colour-coded badge. A data-URI SVG is the
// only thing a plugin can put in an image slot, so every colour here is baked in
// rather than following the skin — the glyph grey is chosen to stay legible on
// both light and dark surfaces, and the badge is opaque so its own contrast
// holds whatever the host's `--bg-surface` is underneath.
//
// 32x32 units over a 40px tile. The glyph is scaled to 0.79 and sits above y=20;
// the badge owns the bottom 11 units (~14px), enough for bold 8-unit digits —
// four characters' worth, which is what caps both "1.2k" and "100%".
function mediaTileSvg(kind, label, band) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<g transform="translate(6.5 1) scale(0.79)" fill="none" stroke="' +
    ICON_COLOR +
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    (MEDIA_GLYPHS[kind] || MEDIA_GLYPHS.unknown) +
    "</g>" +
    '<rect x="0" y="21" width="32" height="11" fill="' +
    band.fill +
    '"/><text x="16" y="29.3" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700" fill="' +
    band.text +
    '">' +
    label +
    "</text></svg>"
  );
}

// Built on demand but cached: both lists re-render on every poll, and a tile
// depends only on these three values.
var tileCache = {};

function tileIcon(kind, label, band) {
  var key = (kind || "unknown") + ":" + label + ":" + band.fill;
  if (!tileCache[key]) tileCache[key] = "data:image/svg+xml," + encodeURIComponent(mediaTileSvg(kind, label, band));
  return tileCache[key];
}

// Search results: seeder count, banded by health.
function mediaIconFor(kind, seeds) {
  return tileIcon(kind, formatSeedCount(seeds), seedBand(seeds));
}

// Torrents: percentage downloaded, banded by state. A torrent awaiting a choice
// reads 0% whatever qBittorrent says — with nothing selected it reports 100%,
// having downloaded none of it.
function torrentIconFor(t, awaiting) {
  return tileIcon(
    classifyTorrentMedia(t && t.name),
    awaiting ? "0%" : torrentPercent(t),
    progressBand(t, awaiting)
  );
}

// What one file inside a torrent is doing. Four states, and the distinction
// that was missing is the last one: whether a selected file is actually
// DOWNLOADING depends on the torrent, not on the file. A file in a stopped
// torrent is selected and going nowhere, and calling that "Downloading 0%" is
// a claim about the transfer that is simply untrue.
function fileState(f, torrent) {
  if (numOr(f && f.priority, 1) === 0) return "skipped";
  if (numOr(f && f.progress, 0) >= 1) return "done";
  // No torrent to ask (the contents of something already removed) — describe
  // the file, not a transfer we can't vouch for.
  if (!torrent || isPaused(torrent) || isErrored(torrent)) return "waiting";
  return "downloading";
}

function filePercent(f) {
  return Math.floor(numOr(f && f.progress, 0) * 100) + "%";
}

function fileStatusText(f, torrent) {
  switch (fileState(f, torrent)) {
    case "skipped":
      return "Not selected for download";
    case "done":
      return "Downloaded";
    case "waiting":
      return "Selected  ·  " + filePercent(f);
    default:
      return "Downloading  ·  " + filePercent(f);
  }
}

// How long something has been running. Deliberately not formatEta, which
// returns its ∞ sentinel past 100 days — a torrent that has been seeding for
// four months has a real answer and "∞" is not it.
function formatDuration(secs) {
  var v = numOr(secs, 0);
  if (v <= 0) return "—";
  var days = Math.floor(v / 86400);
  var hours = Math.floor((v % 86400) / 3600);
  var mins = Math.floor((v % 3600) / 60);
  if (days) return days + "d " + hours + "h";
  if (hours) return hours + "h " + mins + "m";
  if (mins) return mins + "m";
  return Math.floor(v) + "s";
}

// "12/40 seeds" — connected out of what the tracker says exists. Both halves,
// because either alone misleads: 2 connected is either a routing problem or a
// dead release depending on whether there are 300 out there or 2.
//
// The total is omitted rather than faked when qBittorrent doesn't have it: it
// sends -1 for "the tracker hasn't said", and "12 of -1" is nonsense while
// "12 of 0" claims fewer exist than you are already talking to.
function swarmText(connected, total, one, many) {
  var c = numOr(connected, 0);
  if (c < 0) c = 0;
  var tot = numOr(total, -1);
  // "12/40 seeds" reads as a ratio and stays plural; a bare count agrees with
  // itself, so a lone connection is "1 leecher".
  if (tot >= c) return c + "/" + tot + " " + many;
  return c + " " + (c === 1 ? one : many);
}

// qBittorrent reports -1 when it hasn't worked availability out yet, which must
// not render as a torrent nobody can complete.
function formatAvailability(v) {
  var n = numOr(v, -1);
  if (n < 0) return "—";
  return n.toFixed(2);
}

// How long ago, in the coarsest unit that is still true. An exact timestamp is
// not what anyone asks of a download — "3 days ago" is.
function formatAge(unixSeconds, nowMs) {
  var ts = numOr(unixSeconds, 0);
  if (ts <= 0) return "—";
  var secs = Math.floor(((nowMs || Date.now()) - ts * 1000) / 1000);
  if (secs < 0) secs = 0;
  if (secs < 90) return "just now";
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : hours + " hours ago";
  var days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : days + " days ago";
  var months = Math.round(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : months + " months ago";
  var years = Math.round(months / 12);
  return years === 1 ? "a year ago" : years + " years ago";
}

// Per-torrent file filter text. Keyed by hash to match the host input's own
// `stateKey` memory — a single shared string would show one torrent's filter
// text over another torrent's file list the moment you opened a second one.
var fileFilters = {};

function filterFor(hash) {
  return fileFilters[hash] || "";
}

// Space-separated terms, ALL of which must appear, matched case-insensitively
// against the file's full path. The path and not just the basename, so "extras"
// finds a whole folder — which on a release full of scans and samples is the
// thing you actually want to select or skip in one go.
function matchesFilter(name, query) {
  var q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return true;
  var hay = String(name || "").replace(/\\/g, "/").toLowerCase();
  var terms = q.split(/\s+/);
  for (var i = 0; i < terms.length; i++) {
    if (hay.indexOf(terms[i]) === -1) return false;
  }
  return true;
}

function filterFiles(files, query) {
  var list = files || [];
  if (!String(query == null ? "" : query).trim()) return list.slice();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (matchesFilter(list[i].name, query)) out.push(list[i]);
  }
  return out;
}

// The files the contents panel is currently SHOWING. The single source of truth
// for both the list and the Download toolbar above it — the buttons act on what
// you can see, so a button labelled "Audio (3)" must be reading the same three
// files the list is drawing.
function filesInView(hash) {
  return filterFiles(filesByHash[hash], filterFor(hash));
}

// Files grouped by what they are, for the Audio / Video selection buttons.
// Returns index arrays, which is what /torrents/filePrio takes.
function partitionByKind(files) {
  var out = { audio: [], video: [], other: [], all: [] };
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!f || typeof f.index !== "number") continue;
    out.all.push(f.index);
    var kind = mediaKindOf(f.name);
    if (kind === "audio") out.audio.push(f.index);
    else if (kind === "video") out.video.push(f.index);
    else out.other.push(f.index);
  }
  return out;
}

// How much of a torrent the user has actually asked for. The counterpart to the
// file list's per-row state, summarised for the toolbar above it.
function selectionSummary(files) {
  var list = files || [];
  var picked = 0;
  var bytes = 0;
  for (var i = 0; i < list.length; i++) {
    if (numOr(list[i].priority, 1) === 0) continue;
    picked++;
    bytes += numOr(list[i].size, 0);
  }
  return { picked: picked, total: list.length, bytes: bytes };
}

// Files inside a torrent. The badge answers the question the contents list
// exists for — is this file coming, and how much of it is here — so a file the
// user deselected reads "skip" in grey rather than sitting at a percentage that
// will never move.
function fileIconFor(f, torrent) {
  var kind = mediaKindOf(f && f.name) || "unknown";
  switch (fileState(f, torrent)) {
    case "skipped":
      return tileIcon(kind, "skip", PROGRESS_BANDS.stopped);
    case "done":
      return tileIcon(kind, "100%", PROGRESS_BANDS.done);
    case "waiting":
      return tileIcon(kind, filePercent(f), PROGRESS_BANDS.waiting);
    default:
      return tileIcon(kind, filePercent(f), PROGRESS_BANDS.moving);
  }
}

// qBittorrent reports paths in ITS OWN filesystem's style, which is not
// necessarily this machine's — a Windows client talking to a Linux seedbox is
// the normal case. So the separator is inferred from the path itself, never
// from the platform the plugin happens to run on.
function isWindowsPath(p) {
  var s = String(p || "");
  return /^[A-Za-z]:[\\/]/.test(s) || (s.indexOf("\\") >= 0 && s.indexOf("/") < 0);
}

// Join a torrent's save path with a file's torrent-relative name.
//
// Always emits forward slashes: the host does `"file://".length` slicing and
// hands the rest to mpv / convertFileSrc, both of which take forward slashes on
// Windows too. A backslash would survive into the URL and break there.
function joinRemotePath(savePath, name) {
  var base = String(savePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  var rel = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!base) return rel;
  if (!rel) return base;
  return base + "/" + rel;
}

// Rewrite a remote path into the local one, for a qBittorrent running on another
// machine whose download directory is mounted here under a different root
// (/downloads on the seedbox, Z:/torrents here). Prefix substitution only —
// exactly what the user can reason about and type into two boxes.
//
// Case-insensitive when the remote side looks like Windows, since its paths are.
// The inverse of applyPathMapping: a path on THIS machine expressed the way
// qBittorrent would write it. Needed when telling a remote qBittorrent where to
// save — sending it our local mount point would put the files nowhere useful.
function remotePathFor(localPath) {
  if (!pathMapFrom || !pathMapTo) return String(localPath || "").replace(/\\/g, "/");
  return applyPathMapping(String(localPath || "").replace(/\\/g, "/"), pathMapTo, pathMapFrom);
}

function applyPathMapping(path, from, to) {
  var p = String(path || "");
  var f = String(from || "").replace(/\\/g, "/").replace(/\/+$/, "");
  var t = String(to || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!f || !t) return p;
  var subject = isWindowsPath(f) ? p.toLowerCase() : p;
  var needle = isWindowsPath(f) ? f.toLowerCase() : f;
  if (subject.indexOf(needle) !== 0) return p;
  return t + p.substring(f.length);
}

// Whether qBittorrent is on this machine, and so whether its paths mean anything
// here. Only used to decide what the UI OFFERS — a wrong guess costs a hidden
// play button, never a broken play — and the path mapping overrides it.
function isLikelyLocalHost(url) {
  // The bracket alternative is load-bearing: an IPv6 literal is written
  // http://[::1]:8080, and a plain [^:/]+ host match stops at the first colon —
  // inside the address, not at the port.
  var m = /^https?:\/\/(\[[^\]]+\]|[^:/]+)/i.exec(String(url || ""));
  if (!m) return false;
  var host = m[1].toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

// Build a track's display metadata from its filename. Nothing in the plugin API
// reads tags off an arbitrary file, so this is genuinely all there is — which is
// why importing into the library (where lofty reads real tags) stays the better
// path and this one is "hear it now".
// A torrent's paths are relative and may use either separator — qBittorrent
// reports whatever the .torrent carries, not this machine's style.
function baseName(name) {
  var rel = String(name || "").replace(/\\/g, "/");
  var parts = rel.split("/");
  return parts[parts.length - 1] || rel;
}

// The folder segments of a file's path, without the filename.
function folderSegments(name) {
  var rel = String(name || "").replace(/\\/g, "/");
  var slash = rel.lastIndexOf("/");
  if (slash < 0) return [];
  var segs = rel.substring(0, slash).split("/");
  var out = [];
  for (var i = 0; i < segs.length; i++) if (segs[i]) out.push(segs[i]);
  return out;
}

// The folders EVERY file shares. Almost every torrent wraps its contents in one
// directory named after the release, so that segment was repeated on every row
// while the hero title above already said it — a column of the same words, and
// the part that actually distinguishes two files pushed off the end.
//
// Computed across all files, not the filtered view: a filter must narrow the
// list, not silently re-title what is left.
function commonFolder(files) {
  var list = files || [];
  if (!list.length) return [];
  var common = null;
  for (var i = 0; i < list.length; i++) {
    var segs = folderSegments(list[i].name);
    if (common === null) {
      common = segs;
      continue;
    }
    var n = 0;
    while (n < common.length && n < segs.length && common[n] === segs[n]) n++;
    common = common.slice(0, n);
    // A file at the root means there is no shared wrapper at all, and nothing
    // may be stripped from the others.
    if (!common.length) return [];
  }
  return common || [];
}

// The folder a file sits in, RELATIVE to `common`, as a readable prefix
// ("CD1", "extras / scans"). Empty for a file that sits directly in it.
function fileFolder(name, common) {
  var segs = folderSegments(name);
  var skip = (common || []).length;
  var out = [];
  for (var i = skip; i < segs.length; i++) out.push(segs[i]);
  return out.join(" / ");
}

function parseFileTrack(name) {
  var base = String(name || "").replace(/\\/g, "/");
  var slash = base.lastIndexOf("/");
  if (slash >= 0) base = base.substring(slash + 1);
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, "");

  var trackNumber = null;
  var m = /^\s*(\d{1,3})\s*[.\-_)]?\s+(.+)$/.exec(base);
  if (m) {
    trackNumber = parseInt(m[1], 10);
    base = m[2];
  }
  base = base.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();

  var artist = null;
  var title = base;
  var dash = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(base);
  if (dash) {
    artist = dash[1].trim();
    title = dash[2].trim();
  }
  return { trackNumber: trackNumber, artist: artist || null, title: title || base };
}

function qbtUri(hash, index) {
  return "qbt://" + hash + "/" + index;
}

// The host hands back everything after "qbt://" verbatim, so the id is parsed
// here rather than assumed to be pre-split.
function parseQbtUri(id) {
  var s = String(id || "");
  var slash = s.lastIndexOf("/");
  if (slash <= 0) return null;
  var hash = s.substring(0, slash);
  var index = parseInt(s.substring(slash + 1), 10);
  if (!hash || isNaN(index) || index < 0) return null;
  return { hash: hash, index: index };
}

// A magnet's info hash, when it is written as hex (40 chars for v1, 64 for v2).
//
// Base32 magnets exist and are NOT converted here: qBittorrent reports hashes in
// hex, so a base32 value would never match and a wrong hash is worse than none —
// the caller falls back to diffing the torrent list, which always works.
function magnetHash(uri) {
  var m = /xt=urn:bt[im]h:([A-Za-z0-9]+)/i.exec(String(uri || ""));
  if (!m) return null;
  var h = m[1];
  if (!/^[A-Fa-f0-9]{40}$/.test(h) && !/^[A-Fa-f0-9]{64}$/.test(h)) return null;
  return h.toLowerCase();
}

// Loose name comparison for matching an added torrent to what was asked for.
// Indexers and qBittorrent rarely agree on punctuation ("Artist - Album [FLAC]"
// vs "Artist-Album-FLAC"), so everything but letters and digits goes.
function normalizeTorrentName(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Find a torrent by name, but only when the answer is unambiguous.
//
// This is the third way of identifying what was just added, and it catches what
// the other two miss: a torrent already in the list (nothing "new" appeared), and
// a list diff confused by a concurrent poll.
function findTorrentByName(map, name) {
  var target = normalizeTorrentName(name);
  // A short name can prefix-match half the list; refuse rather than guess.
  if (target.length < 8) return null;
  var hits = [];
  for (var hash in map || {}) {
    if (!Object.prototype.hasOwnProperty.call(map, hash)) continue;
    var n = normalizeTorrentName(map[hash] && map[hash].name);
    if (!n) continue;
    if (n === target || n.indexOf(target) === 0 || target.indexOf(n) === 0) hits.push(hash);
  }
  return hits.length === 1 ? hits[0] : null;
}

// Hashes present after an add that weren't there before.
//
// How a newly added torrent is identified at all: /torrents/add answers "Ok."
// and nothing else — no hash, no id.
function newHashes(before, after) {
  var out = [];
  for (var hash in after || {}) {
    if (!Object.prototype.hasOwnProperty.call(after, hash)) continue;
    if (!before || !before[hash]) out.push(hash);
  }
  return out;
}

// Does qBittorrent know what's inside this torrent yet? A magnet arrives as a
// hash and nothing else; the file list only exists once metadata has been
// fetched from the swarm.
function hasMetadata(t) {
  if (!t) return false;
  if (/^(metaDL|forcedMetaDL)$/.test(String(t.state || ""))) return false;
  return Number(t.size || 0) > 0 || Number(t.total_size || 0) > 0;
}

// Only fully-downloaded media is offered. A partially-downloaded file would open
// and then hit EOF partway through, which reads as a corrupt file rather than as
// an incomplete download — worse than not offering it.
function playableFiles(files) {
  var out = [];
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!mediaKindOf(f.name)) continue;
    if (Number(f.progress) < 1) continue;
    out.push(f);
  }
  out.sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return out;
}

// Hashes of every torrent carrying a given category.
//
// Reads the FULL torrent map, not the filtered view — the whole point is to find
// the ones the current filter is hiding.
function hashesInCategory(torrentMap, cat) {
  var wanted = String(cat == null ? "" : cat);
  if (!wanted) return [];
  var out = [];
  for (var hash in torrentMap || {}) {
    if (!Object.prototype.hasOwnProperty.call(torrentMap, hash)) continue;
    var t = torrentMap[hash];
    if (t && String(t.category || "") === wanted) out.push(hash);
  }
  return out;
}

// --- Search -----------------------------------------------------------------

// What to type into a torrent search for a thing the user right-clicked.
//
// Artist first, because indexers name releases that way ("Artist - Album
// [FLAC]"). An album is the useful unit — searching one track's title finds
// single-track rips and misses the release it came from — so a track target
// searches its ALBUM when it has one.
function searchQueryForTarget(target) {
  var t = target || {};
  var parts = [];
  if (t.kind === "artist") {
    parts.push(t.artistName || t.title);
  } else if (t.kind === "album") {
    parts.push(t.artistName, t.albumTitle || t.title);
  } else {
    parts.push(t.artistName, t.albumTitle || t.title);
  }
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = String(parts[i] == null ? "" : parts[i]).trim();
    if (p) out.push(p);
  }
  return out.join(" ").replace(/\s{2,}/g, " ").trim();
}

// The indexer's hostname, for showing where a result came from.
function siteLabel(url) {
  var m = /^https?:\/\/(?:www\.)?([^/:]+)/i.exec(String(url || ""));
  return m ? m[1] : "";
}

// A qBittorrent search plugin reports its OWN failures as if they were results:
// a row whose fileName is the error text, with -1 for size and swarm and its
// help page as the link. Rendering those as torrents invites the user to
// "download" a configuration error.
function realSearchResults() {
  var out = [];
  for (var i = 0; i < searchResults.length; i++) {
    if (!isPluginNotice(searchResults[i])) out.push(searchResults[i]);
  }
  return out;
}

function isPluginNotice(r) {
  if (!r) return true;
  return Number(r.fileSize) < 0 && Number(r.nbSeeders) < 0 && Number(r.nbLeechers) < 0;
}

// Seeders first — for a torrent it is the difference between a download and a
// dead entry, and every indexer's own default sort. Ties break on size so the
// order is stable rather than dependent on which indexer answered first.
function sortSearchResults(results) {
  var list = (results || []).slice();
  list.sort(function (a, b) {
    var sa = Number((a && a.nbSeeders) || 0);
    var sb = Number((b && b.nbSeeders) || 0);
    if (sb !== sa) return sb - sa;
    return Number((b && b.fileSize) || 0) - Number((a && a.fileSize) || 0);
  });
  return list;
}

// Indexers send -1 for "didn't report", and plenty omit the field entirely.
// Either way it is unknown, not zero — "0 seeders" is a verdict on the torrent
// and would send the user past a perfectly live result.
function swarmCount(n) {
  if (n === null || n === undefined || n === "") return null;
  var v = Number(n);
  if (!isFinite(v) || v < 0) return null;
  return v;
}

// The swarm line. Size is NOT here — it has its own trailing column, because
// size is the number you compare down a list of results, and a column does that
// where a mid-sentence value doesn't. Seeders lead: for a torrent they are the
// difference between a download and a dead entry. Leechers follow, always, even
// at zero, so the fields sit in the same place on every row.
function searchResultSubtitle(r) {
  var bits = [];
  var seeds = swarmCount(r && r.nbSeeders);
  var leech = swarmCount(r && r.nbLeechers);
  bits.push(seeds === null ? "swarm unknown" : seeds + " seeders");
  if (leech !== null) bits.push(leech + " leechers");
  var site = siteLabel(r && r.siteUrl);
  if (site) bits.push(site);
  return bits.join("  ·  ");
}

// One row of the results list. The name is what the user is reading the list
// for, so it is the row title and gets the full width; size takes the trailing
// column; the swarm and the indexer ride the subtitle underneath.
function searchResultRow(r) {
  return {
    id: searchResultId(r),
    title: (r && r.fileName) || "(untitled)",
    subtitle: searchResultSubtitle(r),
    duration: formatBytes(r && r.fileSize),
    // Audio / video / unknown read off the release name, over a colour-coded
    // seeder badge — see mediaIconFor.
    imageUrl: mediaIconFor(classifyTorrentMedia(r && r.fileName), swarmCount(r && r.nbSeeders)),
    // Double-click and Enter download, matching the primary overlay button.
    // A row whose plain interactions did nothing at all is what this list was
    // reported as broken for the first time round.
    action: "qbt:search-add"
  };
}

// --- Library import ---------------------------------------------------------

// Which local collection a downloaded path belongs to, or null.
//
// Longest prefix wins: nested collections are legal (a "Music" folder and a
// "Music/Live bootlegs" folder), and the shallower one would otherwise always
// claim files that belong to the deeper, more specific one.
//
// Prefix matching is on path SEGMENTS, not raw characters — "/music" must not
// swallow "/musicals". Case-insensitive when the collection path looks like
// Windows, since its filesystem is.
function collectionForPath(filePath, collections) {
  var path = String(filePath || "").replace(/\\/g, "/");
  if (!path) return null;
  var best = null;
  var bestLen = -1;
  var list = collections || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var root = String((c && c.path) || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root) continue;
    var win = isWindowsPath(root);
    var subject = win ? path.toLowerCase() : path;
    var needle = win ? root.toLowerCase() : root;
    if (subject.indexOf(needle) !== 0) continue;
    var nextChar = subject.charAt(needle.length);
    if (nextChar !== "" && nextChar !== "/") continue;
    if (needle.length > bestLen) {
      bestLen = needle.length;
      best = c;
    }
  }
  return best;
}

// Hashes that finished since the previous snapshot.
//
// `known` is the set of hashes already seen complete. On the FIRST poll of a
// session everything complete is new to us but nothing actually just happened,
// so the caller seeds `known` without announcing — otherwise every restart would
// fire a notification per finished torrent and re-scan the library.
function detectCompletions(known, torrentList) {
  var out = [];
  var list = torrentList || [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t || !t.hash) continue;
    if (!isComplete(t)) continue;
    if (known[t.hash]) continue;
    out.push(t);
  }
  return out;
}

function encodeForm(fields) {
  var parts = [];
  for (var k in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    var v = fields[k];
    if (v === null || v === undefined) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return parts.join("&");
}

function errText(e) {
  if (!e) return "Unknown error";
  return String(e.message || e);
}

function clampPoll(ms) {
  var v = parseInt(ms, 10);
  if (isNaN(v)) return 5000;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, v));
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function apiUrl(path) {
  return baseUrl + "/api/v2" + path;
}

function rawRequest(path, opts) {
  var o = opts || {};
  var headers = {};
  // An API key is sent on every request and needs no session at all — that is the
  // point of it. qBittorrent FORBIDS it on auth/* endpoints, so nothing here may
  // ever pair a key with a login.
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  var body;
  if (o.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = encodeForm(o.form);
  }
  return api.network.fetch(apiUrl(path), {
    method: o.method || "GET",
    headers: headers,
    body: body,
    insecure: insecure,
    timeoutMs: o.timeoutMs || REQUEST_TIMEOUT_MS
  });
}

// Every request carries the API key; there is no login and no session. Anyone
// running qBittorrent with "Bypass authentication for clients on localhost"
// needs no key at all, so an empty key sends no header and lets that work.
function authed(path, opts) {
  return Promise.resolve()
    .then(function () {
      if (!baseUrl) throw new Error("No qBittorrent server configured");
      return rawRequest(path, opts);
    })
    .then(function (resp) {
      if (resp.status !== 403 && resp.status !== 401) return resp;
      // There is nothing to retry: the same key would be sent again. Which of
      // the two answers applies depends on whether a key was sent at all.
      throw new Error(
        apiKey
          ? "qBittorrent rejected the API key"
          : "qBittorrent needs an API key — this plugin no longer signs in with a username and password"
      );
    });
}

function expectOk(resp, what) {
  if (resp.status >= 200 && resp.status < 300) return resp;
  throw new Error(what + " failed (HTTP " + resp.status + ")");
}

// ---------------------------------------------------------------------------
// qBittorrent operations
// ---------------------------------------------------------------------------

// Reads BOTH versions once per session: the WebAPI version decides which
// endpoint names to use, and qBittorrent's own version is what the user
// recognises when checking the status panel against what they installed.
function probeVersion() {
  if (apiVersion) return Promise.resolve(apiVersion);
  return authed("/app/webapiVersion")
    .then(function (resp) {
      return resp.text();
    })
    .then(function (text) {
      apiVersion = String(text || "").trim() || null;
      return authed("/app/version");
    })
    .then(function (resp) {
      return resp.text();
    })
    .then(function (text) {
      qbtVersion = String(text || "").trim() || null;
      return apiVersion;
    })
    .catch(function (e) {
      // Not fatal: without a version we fall back to the pre-5.0 endpoint names,
      // which is the safer guess for an unknown server.
      console.error("qBittorrent: could not read the version:", e);
      return null;
    });
}

function startEndpoint() {
  return supportsStartStop(apiVersion) ? "/torrents/start" : "/torrents/resume";
}

function stopEndpoint() {
  return supportsStartStop(apiVersion) ? "/torrents/stop" : "/torrents/pause";
}

function refresh() {
  // A host that can't read the login cookie will fail every single poll, so
  // don't spend requests proving it — the status panel already explains it.
  if (!baseUrl || hostTooOld) return Promise.resolve();
  return probeVersion()
    .then(function () {
      return authed("/sync/maindata?rid=" + rid);
    })
    .then(function (resp) {
      expectOk(resp, "Reading torrents");
      return resp.json();
    })
    .then(function (delta) {
      var merged = mergeMaindata({ torrents: torrents, serverState: serverState, rid: rid }, delta);
      torrents = merged.torrents;
      serverState = merged.serverState;
      rid = merged.rid;
      connected = true;
      lastError = null;
      // Isolated from the poll's own error handling on purpose: a failed
      // notification or rescan must not be reported as "can't reach
      // qBittorrent", which is what sharing the catch below would do.
      // Same isolation: a background file count or file-list refresh that fails
      // must not be reported as "can't reach qBittorrent".
      ensureFileCounts();
      refreshOpenFiles();
      return handleCompletions(visibleTorrents()).catch(function (e) {
        console.error("qBittorrent: handling completions failed:", e);
      });
    })
    .catch(function (e) {
      connected = false;
      lastError = errText(e);
      // Drop the delta cursor: a stale rid would have the server answer with a
      // partial update against a snapshot we no longer trust. Zero costs one
      // full_update and is always correct.
      rid = 0;
      console.error("qBittorrent: refresh failed:", e);
    })
    .then(function () {
      render();
      updateBadge();
    });
}

function visibleTorrents() {
  var list = [];
  for (var hash in torrents) {
    if (!Object.prototype.hasOwnProperty.call(torrents, hash)) continue;
    var t = torrents[hash];
    if (restrictToCategory && category && String(t.category || "") !== category) continue;
    list.push(t);
  }
  list.sort(function (a, b) {
    var ra = statusRank(a, needsChoice(a));
    var rb = statusRank(b, needsChoice(b));
    if (ra !== rb) return ra - rb;
    return Number(b.added_on || 0) - Number(a.added_on || 0);
  });
  return list;
}

// Ordering for the one list that replaced the Downloading/Completed/All tabs.
// With no tabs to pick a subset, the ordering IS the triage: a torrent waiting
// on the user's decision first (it is the only row that stops making progress
// until it is touched), then failures, then whatever is actually moving, with
// finished torrents last — which is where the old Completed tab now lives.
// Recency breaks ties, as it did before.
function statusRank(t, awaiting) {
  if (awaiting) return 0;
  if (isErrored(t)) return 1;
  if (isComplete(t)) return 5;
  if (/^(downloading|forcedDL|metaDL|forcedMetaDL)$/.test(String((t && t.state) || ""))) return 2;
  if (isPaused(t)) return 4;
  return 3; // queued, stalled, checking, moving, allocating
}

// qBittorrent does NOT create a category on demand — adding with an unknown one
// leaves the torrent uncategorised, which the category-filtered list then hides.
// The torrent downloads fine and appears to have vanished. So make sure the
// category exists before relying on it.
//
// Once per session: creating an existing category answers 409, which is a
// success for our purposes, so failure and success both settle the flag.
function ensureCategory() {
  if (!category || categoryEnsured) return Promise.resolve();
  var dest = collectionById(destCollectionId);
  var form = { category: category };
  if (dest && dest.path) form.savePath = remotePathFor(dest.path);
  return authed("/torrents/createCategory", { method: "POST", form: form })
    .then(function () {
      categoryEnsured = true;
    })
    .catch(function (e) {
      // Already exists (409) is the common case and is fine; anything else just
      // means the add falls back to being uncategorised, which is recoverable.
      console.error("qBittorrent: could not ensure the category exists:", e);
      categoryEnsured = true;
    });
}

// " (14s)" once the wait is long enough to wonder about. Below that the counter
// is noise — a number that appears immediately reads as a problem.
function elapsedSuffix(hash) {
  var secs = Math.round((metadataElapsed[hash] || 0) / 1000);
  return secs >= 5 ? " (" + secs + "s)" : "";
}

function shallowHashSet(map) {
  var out = {};
  for (var hash in map || {}) {
    if (Object.prototype.hasOwnProperty.call(map, hash)) out[hash] = true;
  }
  return out;
}

// After adding paused: find the torrent, get its file list in front of the user,
// and leave it stopped until they say go.
//
// The awkward part is metadata. A .torrent carries its file list, so it is
// available at once. A MAGNET is just a hash — the file list has to be fetched
// from the swarm, and qBittorrent won't do that for a torrent that is stopped.
// So a magnet is started briefly, purely to fetch metadata, and stopped again
// the moment it has it. No file data is downloaded during metaDL.
// 25s, because the wait is not just qBittorrent registering a torrent: given an
// http(s) link it answers "Ok." on ACCEPTING the URL and then goes and fetches
// the .torrent from the tracker, which can be slow. Eight seconds cut that off
// while it was still working.
var ATTACH_ATTEMPTS = 25;
var ATTACH_POLL_MS = 1000;

// Which torrent did that add produce? Three ways, in descending confidence.
// Used by the paused-selection flow, which needs the hash before it can do
// anything else with the torrent.
function matchAddedTorrent(knownBefore, expectedHash, nameHint) {
  if (expectedHash && torrents[expectedHash]) return expectedHash;
  var fresh = newHashes(knownBefore, torrents);
  // Exactly one new torrent is the only case that can be attributed with
  // confidence; with several (a batch, or someone else adding at the same
  // moment) the flow is skipped rather than guessing wrong and acting on a
  // stranger's download.
  if (fresh.length === 1) return fresh[0];
  // Last resort: the name. Catches a torrent that was ALREADY in the list (so
  // nothing is "new") and a diff muddled by a concurrent poll.
  if (nameHint) return findTorrentByName(torrents, nameHint);
  return null;
}

// The same matching, retried while qBittorrent gets around to registering it.
function waitForAddedTorrent(knownBefore, expectedHash, nameHint, attempt) {
  var tries = attempt || 0;
  var hash = matchAddedTorrent(knownBefore, expectedHash, nameHint);
  if (hash) return Promise.resolve(hash);
  if (tries >= ATTACH_ATTEMPTS) return Promise.resolve(null);
  return delay(ATTACH_POLL_MS)
    .then(refresh)
    .then(function () {
      return waitForAddedTorrent(knownBefore, expectedHash, nameHint, tries + 1);
    });
}

function beginSelection(knownBefore, expectedHash, attempt, peek, nameHint) {
  var tries = attempt || 0;
  preparingElapsed = tries;
  var hash = matchAddedTorrent(knownBefore, expectedHash, nameHint);

  if (!hash) {
    // qBittorrent accepts the add and registers the torrent a moment later, so
    // the first look routinely finds nothing. Without this retry the torrent
    // arrived paused with no banner and no explanation — which is exactly what
    // "I clicked download and nothing happened" looks like.
    if (tries < ATTACH_ATTEMPTS) {
      return delay(ATTACH_POLL_MS)
        .then(refresh)
        .then(function () {
          return beginSelection(knownBefore, expectedHash, tries + 1, peek, nameHint);
        });
    }
    preparingAdd = false;
    api.log(
      "warn",
      "add not matched after " + tries + "s — expectedHash=" + (expectedHash || "none") +
        " nameHint=" + (nameHint || "none") + " torrents=" + Object.keys(torrents).length,
      "qbittorrent"
    );
    // The honest reading: for an http(s) link, "Ok." meant qBittorrent accepted
    // the URL, not that it got a torrent from it. A private tracker that needs a
    // login, or a link that is really a web page, fails silently at that point —
    // so telling the user to "find it in the list" sent them looking for
    // something that may not exist.
    api.ui.showNotification(
      expectedHash
        ? "qBittorrent never registered that torrent. It may still be finding peers — check the list in a moment."
        : "qBittorrent accepted the link but no torrent appeared. That usually means it couldn't download the .torrent file — private trackers need a login. Try the magnet link instead if the result has one."
    );
    render();
    return Promise.resolve();
  }

  preparingAdd = false;
  pendingSelection[hash] = true;
  // A peeked torrent is one the user has not committed to, so the row says
  // "Remove" rather than only offering Start.
  if (peek) peekedTorrents[hash] = true;
  expandedHash = hash;
  activeTab = "torrents";

  // Added, paused, and filtered out of the very list that carries the Start
  // button: without this the torrent is unreachable from the UI that is
  // supposed to be waiting for a decision.
  var t = torrents[hash];
  if (restrictToCategory && category && String((t && t.category) || "") !== category) {
    api.ui.showNotification(
      "Added, but qBittorrent didn't put it in “" + category + "” — turn off “Only manage my own category” to see it"
    );
  }

  render();
  return waitForMetadata(hash, 0);
}

var METADATA_POLL_MS = 1500;
var METADATA_MAX_MS = 90000;

function waitForMetadata(hash, elapsed) {
  metadataElapsed[hash] = elapsed;
  return refresh().then(function () {
    var t = torrents[hash];
    if (!t || !pendingSelection[hash]) return null; // removed, or the user moved on
    if (hasMetadata(t)) {
      // It may have been started to fetch metadata — put it back to stopped so
      // nothing downloads before the user has chosen.
      var wasFetching = metadataFetching[hash];
      delete metadataFetching[hash];
      delete metadataElapsed[hash];
      var settle = wasFetching && !isPaused(t)
        ? actOn(stopEndpoint(), [hash], "Pausing for file selection")
        : Promise.resolve();
      return settle
        .then(function () {
          return fetchFiles(hash);
        })
        .then(function () {
          // A peek is only a look, so it does not sit there paused waiting for a
          // Start press: it is left running with nothing selected, and the first
          // file the user includes starts arriving immediately. A torrent held
          // by "Choose files before downloading" is a download the user has
          // already committed to, so that one keeps its explicit Start.
          return peekedTorrents[hash] ? armPeek(hash) : false;
        })
        .then(function (armed) {
          api.ui.showNotification(
            armed
              ? "Nothing is downloading — pick the files you want and they'll start straight away"
              : "Ready — choose which files to download, then press Start"
          );
          render();
        });
    }
    if (elapsed >= METADATA_MAX_MS) {
      // Give up waiting rather than holding a paused torrent forever: the user
      // can still start it by hand and select files afterwards.
      delete metadataFetching[hash];
      delete metadataElapsed[hash];
      api.ui.showNotification("Couldn't get this torrent's file list — start it and choose files as it runs");
      render();
      return null;
    }
    // A stopped magnet will never fetch metadata on its own; start it just for
    // that. During metaDL no file data is transferred.
    if (isPaused(t) && !metadataFetching[hash]) {
      metadataFetching[hash] = true;
      return actOn(startEndpoint(), [hash], "Fetching the file list").then(function () {
        return delay(METADATA_POLL_MS);
      }).then(function () {
        return waitForMetadata(hash, elapsed + METADATA_POLL_MS);
      });
    }
    return delay(METADATA_POLL_MS).then(function () {
      return waitForMetadata(hash, elapsed + METADATA_POLL_MS);
    });
  });
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// `opts.peek` forces the paused-and-choose flow for this one add, whatever the
// setting says. It backs "View contents": qBittorrent has no way to read a
// torrent's file list WITHOUT adding it — metadata comes from the swarm or the
// .torrent itself — so looking inside means adding it paused and offering an
// easy way back out.
function addTorrent(source, opts) {
  var uri = String(source || "").trim();
  var peek = !!(opts && opts.peek);
  var holdForSelection = peek || chooseFilesFirst;
  // What the thing is called, for matching it once qBittorrent has it. The
  // search result knows; a magnet carries it as dn.
  var nameHint = (opts && opts.name) || magnetDisplayName(source) || "";
  // The search plugin that produced this result. Indexers routinely return a
  // DESCRIPTION PAGE as the download link, and only their own plugin knows how
  // to turn that into a .torrent — qBittorrent does the resolving, but only if
  // told which plugin to use. Without it, it fetches the HTML, fails to bdecode
  // it, and discards it, having already answered "Ok." to the add.
  var downloader = (opts && opts.downloader) || "";
  if (!looksLikeTorrentSource(uri)) {
    api.ui.showNotification("That doesn't look like a magnet link or a .torrent URL");
    return Promise.resolve();
  }
  var form = {
    urls: uri,
    // Sequential + first/last piece priority are what make a partially
    // downloaded file playable at all, which is the point of adding it here
    // rather than in qBittorrent's own UI.
    sequentialDownload: "true",
    firstLastPiecePrio: "true"
  };
  if (holdForSelection) {
    // Both spellings: 5.0 renamed paused -> stopped, and qBittorrent ignores a
    // form field it doesn't know, so this needs no version branch.
    form.paused = "true";
    form.stopped = "true";
  }
  if (holdForSelection) {
    preparingAdd = true;
    preparingElapsed = 0;
    render();
  }
  var knownBefore = holdForSelection ? shallowHashSet(torrents) : null;
  // The plain add verifies its own outcome, so it needs the same snapshot.
  var plainBefore = holdForSelection ? null : shallowHashSet(torrents);
  var expectedHash = holdForSelection ? magnetHash(uri) : null;
  if (category) form.category = category;
  if (downloader) form.downloader = downloader;
  // Saving into a collection folder is what makes the finished download reach
  // the library at all — without it the files land somewhere the app never
  // scans. The path sent is the one qBittorrent understands, so a mapping is
  // applied in reverse.
  var dest = collectionById(destCollectionId);
  if (dest && dest.path) form.savepath = remotePathFor(dest.path);

  return ensureCategory()
    .then(function () {
      return authed("/torrents/add", { method: "POST", form: form });
    })
    .then(function (resp) {
      expectOk(resp, "Adding the torrent");
      return resp.text();
    })
    .then(function (body) {
      // qBittorrent answers a REFUSED add with HTTP 200 and the body "Fails." —
      // the status code alone says nothing. Checking only the status is how this
      // reported "Added" for torrents it never took.
      if (/^fails\.?$/i.test(String(body || "").trim())) {
        throw new Error(
          "qBittorrent refused it. The link may have expired, the save folder may not be writable, or it may already be in the list."
        );
      }
      var name = magnetDisplayName(uri);
      api.ui.showNotification(
        peek
          ? (name ? "Fetching what is inside " + name + "…" : "Fetching the file list — nothing is downloading yet")
          : holdForSelection
            ? (name ? "Added " + name + " — paused so you can choose files" : "Added, paused so you can choose files")
            : (name ? "Added " + name : "Added to qBittorrent")
      );
      // Show where it went. Adding from the Search tab otherwise leaves the user
      // looking at search results with no sign anything happened.
      activeTab = "torrents";
      render();
      return refresh().then(function () {
        if (holdForSelection) return beginSelection(knownBefore, expectedHash, 0, peek, nameHint);
        // "Ok." only means qBittorrent ACCEPTED the request. For a URL it then
        // fetches and parses in the background, and a page that isn't a torrent
        // is discarded silently — so the plugin has to check that something
        // actually turned up rather than reporting success on an acknowledgement.
        return waitForAddedTorrent(plainBefore, expectedHash, nameHint, 0).then(function (hash) {
          if (hash) return null;
          api.log("warn", "add produced no torrent: " + uri, "qbittorrent");
          api.ui.showNotification(
            "qBittorrent accepted the link but no torrent appeared — it may not be a real .torrent file. " +
              "Check qBittorrent's log (View → Log) for the reason."
          );
          return null;
        });
      });
    })
    .catch(function (e) {
      preparingAdd = false;
      render();
      console.error("qBittorrent: add failed:", e);
      api.ui.showNotification("Couldn't add that torrent: " + errText(e));
    });
}

function actOn(path, hashes, label) {
  var list = [].concat(hashes || []);
  if (!list.length) return Promise.resolve();
  busy = list.length === 1 ? list[0] : "*";
  render();
  return authed(path, { method: "POST", form: { hashes: list.join("|") } })
    .then(function (resp) {
      expectOk(resp, label);
    })
    .catch(function (e) {
      console.error("qBittorrent: " + label + " failed:", e);
      api.ui.showNotification(label + " failed: " + errText(e));
    })
    .then(function () {
      busy = null;
      return refresh();
    });
}

// --- Search -----------------------------------------------------------------

var SEARCH_POLL_MS = 1200;
var SEARCH_MAX_MS = 45000;
var SEARCH_LIMIT = 60;

// The search runs on qBittorrent's own installed search plugins. With none, the
// API answers every query with nothing — so the empty state has to say that
// rather than showing "no results", which reads as "this album doesn't exist".
function loadSearchPlugins() {
  return authed("/search/plugins")
    .then(function (resp) {
      expectOk(resp, "Reading search plugins");
      return resp.json();
    })
    .then(function (list) {
      var enabled = [];
      for (var i = 0; i < (list || []).length; i++) {
        if (list[i] && list[i].enabled) enabled.push(list[i]);
      }
      searchPlugins = enabled;
      return enabled;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not list search plugins:", e);
      searchPlugins = [];
      return [];
    });
}

// A finished job holds resources on the server until it's told otherwise, and
// qBittorrent caps how many can exist at once — so every exit path disposes of
// it, including the ones where we stopped caring about the answer.
function disposeSearch(id) {
  if (id == null) return Promise.resolve();
  return authed("/search/stop", { method: "POST", form: { id: id } })
    .catch(function () {
      // Already stopped is the normal case here; deleting is what matters.
      return null;
    })
    .then(function () {
      return authed("/search/delete", { method: "POST", form: { id: id } });
    })
    .catch(function (e) {
      console.error("qBittorrent: could not dispose of search job " + id + ":", e);
    });
}

function runSearch(query) {
  var q = String(query || "").trim();
  if (!q) return Promise.resolve();

  searchGen++;
  var gen = searchGen;
  var previousJob = searchJobId;

  searchQuery = q;
  searchRunning = true;
  searchError = null;
  searchResults = [];
  searchJobId = null;
  searchStopped = false;
  activeTab = "search";
  render();

  // Drop the previous job before starting another; a user retyping a query
  // would otherwise leak one server-side job per attempt.
  return disposeSearch(previousJob)
    .then(function () {
      return searchPlugins === null ? loadSearchPlugins() : searchPlugins;
    })
    .then(function (plugins) {
      if (!plugins.length) {
        throw new Error("no-plugins");
      }
      return authed("/search/start", {
        method: "POST",
        form: { pattern: q, plugins: "enabled", category: "all" }
      });
    })
    .then(function (resp) {
      expectOk(resp, "Starting the search");
      return resp.json();
    })
    .then(function (job) {
      if (gen !== searchGen) {
        // A newer search started while this one was getting going.
        return disposeSearch(job && job.id);
      }
      searchJobId = job && job.id;
      return pollSearch(searchJobId, gen, 0);
    })
    .catch(function (e) {
      if (gen !== searchGen) return null;
      searchRunning = false;
      searchError = String(e && e.message) === "no-plugins" ? "no-plugins" : errText(e);
      if (searchError !== "no-plugins") console.error("qBittorrent: search failed:", e);
      render();
      return null;
    });
}

function pollSearch(id, gen, elapsed) {
  if (gen !== searchGen) return Promise.resolve();
  return authed("/search/results?id=" + encodeURIComponent(id) + "&limit=" + SEARCH_LIMIT)
    .then(function (resp) {
      expectOk(resp, "Reading search results");
      return resp.json();
    })
    .then(function (data) {
      if (gen !== searchGen) return null;
      searchResults = sortSearchResults((data && data.results) || []);
      var done = String((data && data.status) || "") !== "Running" || elapsed >= SEARCH_MAX_MS;
      if (done) {
        searchRunning = false;
        render();
        var finishedId = searchJobId;
        searchJobId = null;
        return disposeSearch(finishedId);
      }
      // Results stream in, so render each pass rather than making the user wait
      // for the slowest indexer before seeing anything.
      render();
      return new Promise(function (resolve) {
        setTimeout(resolve, SEARCH_POLL_MS);
      }).then(function () {
        return pollSearch(id, gen, elapsed + SEARCH_POLL_MS);
      });
    })
    .catch(function (e) {
      if (gen !== searchGen) return null;
      console.error("qBittorrent: reading search results failed:", e);
      searchRunning = false;
      searchError = errText(e);
      render();
      return disposeSearch(id);
    });
}

// Stop a running search, keeping whatever came back.
//
// Bumping the generation is what actually stops it: the poll loop is a chain of
// timeouts, and the next one to land sees a newer generation and drops out. The
// server-side job is disposed of here rather than left to that dropped poll,
// which by then is deliberately doing nothing.
function stopSearch() {
  if (!searchRunning) return Promise.resolve();
  searchGen++;
  searchRunning = false;
  searchStopped = true;
  var id = searchJobId;
  searchJobId = null;
  render();
  return disposeSearch(id);
}

// A stable identity for a search result.
//
// NOT its position: results stream in and are re-sorted by seeders on every
// poll, so an index captured when the row was drawn can point at a different
// result — or past the end — by the time it is clicked. That made clicking
// during a live search either silently do nothing or add the wrong torrent.
function searchResultId(r) {
  if (!r) return "";
  return String(r.fileUrl || r.descrLink || r.fileName || "");
}

function findSearchResult(id) {
  for (var i = 0; i < searchResults.length; i++) {
    if (searchResultId(searchResults[i]) === String(id)) return searchResults[i];
  }
  return null;
}

function addSearchResult(id, opts) {
  var r = findSearchResult(id);
  if (!r) {
    // The list moved under the click (a poll landed) or the search was rerun.
    api.ui.showNotification("That result is no longer in the list — search again");
    return;
  }
  if (!r.fileUrl) {
    // Some indexers return a description page and no download link. Silently
    // doing nothing was indistinguishable from the plugin being broken.
    if (r.descrLink && typeof api.network.openUrl === "function") {
      api.ui.showNotification("That result has no download link — opening its page instead");
      api.network.openUrl(r.descrLink).catch(function (e) {
        console.error("qBittorrent: could not open the result's page:", e);
      });
    } else {
      api.ui.showNotification("That result has no download link");
    }
    return;
  }
  addTorrent(r.fileUrl, { peek: !!(opts && opts.peek), name: r.fileName, downloader: r.engineName });
}

// --- Library import ---------------------------------------------------------

function loadCollections() {
  if (!api.collections || typeof api.collections.getLocalCollections !== "function") {
    return Promise.resolve([]);
  }
  return api.collections
    .getLocalCollections()
    .then(function (list) {
      localCollections = list || [];
      return localCollections;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not read local collections:", e);
      return [];
    });
}

function collectionById(id) {
  for (var i = 0; i < localCollections.length; i++) {
    if (String(localCollections[i].id) === String(id)) return localCollections[i];
  }
  return null;
}

// Where a torrent's content sits on THIS machine, or null when that can't be
// known (a remote qBittorrent with no path mapping).
function localContentPath(t) {
  if (!t) return null;
  if (!filesAreReachable()) return null;
  var raw = t.content_path || t.save_path || "";
  if (!raw) return null;
  return applyPathMapping(String(raw).replace(/\\/g, "/"), pathMapFrom, pathMapTo);
}

function collectionForTorrent(t) {
  var path = localContentPath(t);
  if (!path) return null;
  return collectionForPath(path, localCollections);
}

// Rescan the collections a set of finished torrents landed in.
//
// Deduped by collection: three albums finishing together must not queue three
// scans of the same folder. The host guards a concurrent rescan of one
// collection anyway, but relying on that would mean the *second* scan is simply
// dropped — the point here is that one scan covers all three.
function importFinished(finishedTorrents) {
  if (!autoImport) return Promise.resolve();
  if (!api.collections || typeof api.collections.resync !== "function") return Promise.resolve();

  var byId = {};
  for (var i = 0; i < finishedTorrents.length; i++) {
    var c = collectionForTorrent(finishedTorrents[i]);
    if (c) byId[c.id] = c;
  }
  var ids = Object.keys(byId);
  if (!ids.length) return Promise.resolve();

  var chain = Promise.resolve();
  ids.forEach(function (id) {
    chain = chain.then(function () {
      return api.collections
        .resync(Number(id))
        .then(function () {
          api.ui.showNotification("Scanning “" + byId[id].name + "” for the new files");
        })
        .catch(function (e) {
          console.error("qBittorrent: could not rescan collection " + id + ":", e);
        });
    });
  });
  return chain;
}

// Announce and import anything that finished since the last poll.
function handleCompletions(list) {
  // A torrent with nothing selected has finished downloading nothing at all, so
  // announcing it and rescanning the library for it would be pure noise — and
  // it is a state this plugin puts torrents in deliberately (see armPeek).
  // Filtered here rather than inside detectCompletions so that stays a pure
  // function of its two arguments.
  var real = [];
  for (var k = 0; k < list.length; k++) if (isFinished(list[k])) real.push(list[k]);
  var finished = detectCompletions(knownComplete, real);
  for (var i = 0; i < finished.length; i++) knownComplete[finished[i].hash] = true;

  // First poll of the session: everything already complete is new to US but
  // nothing just happened. Seed silently, or a restart would notify (and
  // rescan) once per finished torrent.
  if (!completionsSeeded) {
    completionsSeeded = true;
    return Promise.resolve();
  }
  if (!finished.length) return Promise.resolve();

  for (var j = 0; j < finished.length; j++) {
    api.ui.showNotification("Finished downloading: " + (finished[j].name || "torrent"));
  }
  return importFinished(finished);
}

// --- Files ------------------------------------------------------------------

function fetchFiles(hash) {
  filesLoading = hash;
  render();
  return authed("/torrents/files?hash=" + encodeURIComponent(hash))
    .then(function (resp) {
      expectOk(resp, "Reading the torrent's files");
      return resp.json();
    })
    .then(function (list) {
      filesByHash[hash] = parseFileList(list);
      return filesByHash[hash];
    })
    .catch(function (e) {
      console.error("qBittorrent: could not list files:", e);
      api.ui.showNotification("Couldn't list that torrent's files: " + errText(e));
      return [];
    })
    .then(function (files) {
      filesLoading = null;
      render();
      return files;
    });
}

// `index` is only present from WebAPI 2.8.2 on; before that a file's position in
// this array IS its index, which is what the file-priority and
// download-selection endpoints take. Falling back to the position keeps playback
// working on older servers instead of building qbt://…/NaN.
//
// Coerced with Number(), NOT gated on `typeof === "number"`. A field that
// arrives as the string "0" — which happens through proxies and on older builds
// — failed that check and fell through to the default, so a file the user had
// deselected came back marked for download and the row said "Downloading 0%"
// about a file that would never move. Where a default is needed, it is the SAFE
// direction that has to win, and for `index` there is no safe default at all: a
// wrong index sends /torrents/filePrio at the wrong file.
function parseFileList(list) {
  var files = [];
  for (var i = 0; i < (list || []).length; i++) {
    var f = list[i] || {};
    files.push({
      index: numOr(f.index, i),
      name: f.name,
      size: numOr(f.size, 0),
      progress: numOr(f.progress, 0),
      // 0 means "don't download this one". Everything else is a download
      // priority (1 normal, 6 high, 7 maximum) — the plugin only ever sets 0
      // or 1, but it must not flatten a priority the user set in qBittorrent
      // itself, so the raw value is kept.
      priority: numOr(f.priority, 1)
    });
  }
  return files;
}

// Per-file progress does NOT arrive with the poll: /sync/maindata describes
// TORRENTS, and the file list is a separate endpoint that was only ever read on
// open and after a priority change. So while the contents panel was open every
// file's progress was frozen at whatever it was when you opened it — a file you
// downloaded while watching sat at "Downloading 0%" for ever, Play refused it
// because the cached progress never reached 1, and its row never got a `path`,
// which killed drag-to-queue and the context menu with it.
//
// One request per poll, and only for the torrent whose contents are open.
var quietFilesInFlight = {};

function refreshOpenFiles() {
  var hash = expandedHash;
  if (!connected || !hash || !torrents[hash]) return;
  // Never while the visible fetch is running: that one owns `filesLoading` and
  // the spinner, and two writers would race over the same cache entry.
  if (filesLoading === hash || quietFilesInFlight[hash]) return;
  quietFilesInFlight[hash] = true;
  authed("/torrents/files?hash=" + encodeURIComponent(hash))
    .then(function (resp) {
      expectOk(resp, "Reading the torrent's files");
      return resp.json();
    })
    .then(function (list) {
      var next = parseFileList(list);
      // Only re-render when something actually moved. The panel redraws on
      // every poll anyway, but rebuilding the row list — and its tiles — for an
      // unchanged list is work for nothing.
      if (fileListSignature(next) !== fileListSignature(filesByHash[hash])) {
        filesByHash[hash] = next;
        render();
      }
    })
    .catch(function (e) {
      // Quiet: the panel keeps the list it has. A background refresh nobody
      // asked for must not raise a notification over a working view.
      console.error("qBittorrent: could not refresh the open torrent's files:", e);
    })
    .then(function () {
      delete quietFilesInFlight[hash];
    });
}

function fileListSignature(files) {
  var list = files || [];
  var parts = [];
  for (var i = 0; i < list.length; i++) {
    parts.push(list[i].index + ":" + list[i].progress + ":" + list[i].priority);
  }
  return parts.join("|");
}

// Include or exclude files from the download (qBittorrent's per-file priority;
// 0 = don't download).
//
// Only ever sets 0 or 1: this is a two-state control, and writing a high/maximum
// priority the user had set in qBittorrent back down to normal would quietly
// undo their own tuning.
// The bare priority POST. Separate from setFilePriority because arming a peek
// needs to set priorities without narrating it ("14 files won't be downloaded"
// is not news when the user asked to look inside), and needs the failure to
// propagate so it can fall back rather than claim a state it didn't reach.
function postFilePriority(hash, indices, priority) {
  if (!indices.length) return Promise.resolve();
  return authed("/torrents/filePrio", {
    method: "POST",
    form: { hash: hash, id: indices.join("|"), priority: priority }
  }).then(function (resp) {
    expectOk(resp, priority === 0 ? "Skipping those files" : "Including those files");
  });
}

// "View contents" leaves the torrent RUNNING with every file deselected, so the
// moment the user includes a file it starts arriving — no second Start press,
// which was a step that did nothing except stand between the user and the thing
// they had just chosen.
//
// Order matters and is the whole safety of it: deselect first, start second.
// Starting a torrent whose files are still at their default priority downloads
// the entire release, which is exactly what "View contents" must never do.
function armPeek(hash) {
  var files = filesByHash[hash] || [];
  if (!files.length) return Promise.resolve(false);
  var all = [];
  for (var i = 0; i < files.length; i++) all.push(files[i].index);
  return postFilePriority(hash, all, 0)
    .then(function () {
      return fetchFiles(hash);
    })
    .then(function () {
      // Verify rather than assume: qBittorrent silently keeps a completed
      // file's priority, and starting a torrent that still wants something
      // would download it behind the user's back.
      if (!nothingSelected(torrents[hash])) throw new Error("qBittorrent kept some files selected");
      return actOn(startEndpoint(), [hash], "Getting ready");
    })
    .then(function () {
      armedPeek[hash] = true;
      return true;
    })
    .catch(function (e) {
      // Fall back to the old hold: stopped, everything selected, waiting for an
      // explicit Start. Strictly worse, but honest — and the banner for that
      // state still tells the user what to do.
      console.error("qBittorrent: could not arm the peeked torrent:", e);
      delete armedPeek[hash];
      return false;
    });
}

// Releasing the arm: the user has chosen something, so this is now an ordinary
// download. The start is deliberate belt-and-braces — a torrent that wanted
// nothing may have been stopped by qBittorrent's own on-completion rules, and
// then including a file would have selected it without downloading it.
function releasePeek(hash) {
  if (!armedPeek[hash]) return Promise.resolve();
  delete armedPeek[hash];
  delete pendingSelection[hash];
  delete peekedTorrents[hash];
  return actOn(startEndpoint(), [hash], "Starting the download");
}

function setFilePriority(hash, indices, priority) {
  if (!indices.length) return Promise.resolve();
  busy = hash;
  render();
  return authed("/torrents/filePrio", {
    method: "POST",
    form: { hash: hash, id: indices.join("|"), priority: priority }
  })
    .then(function (resp) {
      expectOk(resp, priority === 0 ? "Skipping those files" : "Including those files");
      api.ui.showNotification(
        priority === 0
          ? indices.length === 1 ? "That file won't be downloaded" : indices.length + " files won't be downloaded"
          : indices.length === 1 ? "That file will be downloaded" : indices.length + " files will be downloaded"
      );
    })
    .catch(function (e) {
      console.error("qBittorrent: could not change file priority:", e);
      api.ui.showNotification(
        // The usual cause is a magnet whose metadata hasn't arrived: there is no
        // file list to prioritise yet, and qBittorrent answers 409.
        /409/.test(errText(e))
          ? "qBittorrent doesn't have this torrent's file list yet — try again in a moment"
          : "Couldn't change that: " + errText(e)
      );
    })
    .then(function () {
      busy = null;
      // Re-read rather than patching locally: qBittorrent may adjust what it
      // actually applied (a completed file, a conflicting priority), and the
      // list must show what IT decided, not what we asked for.
      return fetchFiles(hash);
    })
    .then(function () {
      // Including a file in an armed peek is the decision the whole hold was
      // waiting for, so it ends here rather than at a separate button. Skipping
      // a file is not a decision to download anything, so it does not.
      return priority === 0 ? null : releasePeek(hash);
    })
    .then(function () {
      return refresh();
    });
}

function ensureFiles(hash) {
  if (filesByHash[hash]) return Promise.resolve(filesByHash[hash]);
  return fetchFiles(hash);
}

// The torrents list endpoint does NOT report how many files a torrent holds, so
// the count is fetched once per torrent and cached for the session — a file list
// cannot change once qBittorrent has the metadata.
//
// Deliberately NOT fetchFiles(): that one drives the contents panel's spinner
// and reports its failures out loud, both of which would be wrong for a
// background count nobody asked for. Bounded per cycle so a category with fifty
// torrents doesn't open fifty sockets on the first poll.
var fileCountByHash = {};
var countInFlight = {};
var COUNT_FETCH_PER_CYCLE = 4;

function fileCountOf(t) {
  if (!t) return null;
  var files = filesByHash[t.hash];
  if (files) return files.length;
  var n = fileCountByHash[t.hash];
  // -1 is the "asked and it failed" marker, which is unknown as far as the row
  // is concerned but must not be asked again.
  return typeof n === "number" && n >= 0 ? n : null;
}

function ensureFileCounts() {
  if (!connected) return;
  var list = visibleTorrents();
  var started = 0;
  for (var i = 0; i < list.length && started < COUNT_FETCH_PER_CYCLE; i++) {
    var t = list[i];
    // Tested on `undefined` rather than on fileCountOf(), so a failed fetch is
    // not retried on every poll for the rest of the session — that would be a
    // request loop against a torrent qBittorrent has already refused to
    // describe, for a field the row can simply omit.
    if (filesByHash[t.hash] || fileCountByHash[t.hash] !== undefined || countInFlight[t.hash]) continue;
    // A magnet still asking the swarm what is in it has no file list to count.
    if (!hasMetadata(t)) continue;
    countInFlight[t.hash] = true;
    started++;
    fetchFileCount(t.hash);
  }
}

function fetchFileCount(hash) {
  return authed("/torrents/files?hash=" + encodeURIComponent(hash))
    .then(function (resp) {
      expectOk(resp, "Counting the torrent's files");
      return resp.json();
    })
    .then(function (list) {
      var n = (list || []).length;
      // A torrent with no files does not exist — an empty answer means
      // qBittorrent isn't ready to describe it, so record the "don't ask again"
      // marker rather than a count of 0. Printing "0 files" on a row would be
      // stating a fact that cannot be true.
      fileCountByHash[hash] = n > 0 ? n : -1;
      render();
    })
    .catch(function (e) {
      // Quiet on purpose — see above. The row simply omits the count.
      console.error("qBittorrent: could not count a torrent's files:", e);
      fileCountByHash[hash] = -1;
    })
    .then(function () {
      delete countInFlight[hash];
    });
}

// Absolute path of one file on THIS machine, or null when it can't be known.
function localPathFor(torrent, file) {
  if (!torrent || !file) return null;
  var save = torrent.save_path || torrent.download_path || "";
  if (!save) return null;
  return applyPathMapping(joinRemotePath(save, file.name), pathMapFrom, pathMapTo);
}

// Are this torrent's files reachable from here at all? Either qBittorrent is on
// this machine, or the user has told us where its download directory is mounted.
function filesAreReachable() {
  if (pathMapFrom && pathMapTo) return true;
  return isLikelyLocalHost(baseUrl);
}

function trackForFile(torrent, file) {
  var parsed = parseFileTrack(file.name);
  return {
    path: qbtUri(torrent.hash, file.index),
    title: parsed.title,
    artist_name: parsed.artist,
    album_title: torrent.name || null,
    track_number: parsed.trackNumber
  };
}

// The selectable row list sends `selectedIds` (an array, one entry for an
// overlay button, several when acting on a selection) plus `itemId`. Take both.
// The raw row ids, for lists whose ids aren't numbers (search results are keyed
// by URL).
function rowIds(data) {
  var out = [];
  var ids = data && data.selectedIds;
  if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] != null && ids[i] !== "") out.push(String(ids[i]));
    }
  }
  if (!out.length && data && data.itemId != null && data.itemId !== "") out.push(String(data.itemId));
  return out;
}

function rowIndices(data) {
  var out = [];
  var ids = data && data.selectedIds;
  if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) {
      var n = parseInt(ids[i], 10);
      if (!isNaN(n)) out.push(n);
    }
  }
  if (!out.length && data && data.itemId != null) {
    var single = parseInt(data.itemId, 10);
    if (!isNaN(single)) out.push(single);
  }
  return out;
}

function tracksForIndices(hash, indices) {
  var torrent = torrents[hash];
  if (!torrent) return [];
  var files = filesByHash[hash] || [];
  var byIndex = {};
  for (var i = 0; i < files.length; i++) byIndex[files[i].index] = files[i];
  var tracks = [];
  for (var j = 0; j < indices.length; j++) {
    var f = byIndex[indices[j]];
    // Skip anything unfinished: same rule as the Play button, since a partial
    // file stops partway and reads as corrupt.
    if (f && Number(f.progress) >= 1 && mediaKindOf(f.name)) tracks.push(trackForFile(torrent, f));
  }
  return tracks;
}

function enqueueFiles(hash, indices) {
  return ensureFiles(hash).then(function () {
    var tracks = tracksForIndices(hash, indices);
    if (!tracks.length) {
      api.ui.showNotification("Nothing there that's finished downloading");
      return;
    }
    // Append: the end of the queue is where "add to queue" means, and the host
    // has no dedicated enqueue call.
    var position = 0;
    if (typeof api.playback.getQueue === "function") {
      var q = api.playback.getQueue();
      position = (q && q.tracks && q.tracks.length) || 0;
    }
    api.playback.insertTracks(tracks, position);
    api.ui.showNotification(tracks.length === 1 ? "Added to the queue" : "Added " + tracks.length + " to the queue");
  });
}

function playFiles(hash, startIndex) {
  var torrent = torrents[hash];
  if (!torrent) return Promise.resolve();
  return ensureFiles(hash).then(function (files) {
    var playable = playableFiles(files);
    if (!playable.length) {
      api.ui.showNotification("Nothing finished downloading in this torrent yet");
      return;
    }
    var tracks = [];
    var start = 0;
    for (var i = 0; i < playable.length; i++) {
      if (startIndex != null && playable[i].index === startIndex) start = i;
      tracks.push(trackForFile(torrent, playable[i]));
    }
    api.playback.playTracks(tracks, start, { name: torrent.name || "Torrent" });
  });
}

function deleteTorrents(hashes, deleteFiles) {
  var list = [].concat(hashes || []);
  if (!list.length) return Promise.resolve();
  busy = list.length === 1 ? list[0] : "*";
  render();
  return authed("/torrents/delete", {
    method: "POST",
    form: { hashes: list.join("|"), deleteFiles: deleteFiles ? "true" : "false" }
  })
    .then(function (resp) {
      expectOk(resp, "Removing the torrent");
      // Drop them locally rather than waiting a poll cycle — the row vanishing
      // IS the feedback for a destructive action.
      for (var i = 0; i < list.length; i++) {
        delete torrents[list[i]];
        delete pendingSelection[list[i]];
        delete peekedTorrents[list[i]];
        delete filesByHash[list[i]];
        delete fileCountByHash[list[i]];
        delete armedPeek[list[i]];
        delete fileFilters[list[i]];
        // The contents panel is showing a torrent that no longer exists.
        if (expandedHash === list[i]) expandedHash = null;
      }
    })
    .catch(function (e) {
      console.error("qBittorrent: delete failed:", e);
      api.ui.showNotification(
        list.length === 1 ? "Couldn't remove that torrent: " + errText(e) : "Couldn't remove those torrents: " + errText(e)
      );
    })
    .then(function () {
      busy = null;
      pendingDelete = null;
      return refresh();
    });
}

// ---------------------------------------------------------------------------
// Rendering — torrents view
// ---------------------------------------------------------------------------

function statusLine() {
  var s = connectionStatus();
  if (s.kind !== "ok") return s.label;
  var label = "Connected";
  if (qbtVersion) label += " to qBittorrent " + qbtVersion;
  if (restrictToCategory && category) label += " · category “" + category + "”";
  return label;
}

// The banner the Torrents view carries whenever something needs doing. Says what
// is wrong AND what to do about it — a bare error string sends the user looking
// for a settings page it never names.
function statusBanner() {
  var s = connectionStatus();
  if (s.kind === "ok" || s.kind === "connecting") return null;
  var text = s.label;
  if (s.detail) text += " — " + s.detail;
  if (s.fix) text += "  " + s.fix;
  return {
    type: "text",
    className: "ds-banner ds-banner--" + (s.tone === "warning" ? "warning" : "error"),
    content: text
  };
}

function setupGuideNode() {
  var steps = setupSteps();
  var children = [];
  for (var i = 0; i < steps.length; i++) {
    children.push({ type: "text", content: i + 1 + ". " + steps[i] });
  }
  return { type: "section", title: "Setting up qBittorrent", children: children };
}

// What the row says this torrent is doing. qBittorrent's own state string is
// wrong twice over for a torrent nobody has chosen files for: it reads
// "Seeding" or "Complete" because nothing is wanted so nothing is missing, and
// for a held one it reads "Paused" when the pause is ours, not the user's.
function torrentStatusText(t, pending) {
  if (nothingSelected(t)) return "Choose files to start";
  if (pending) return "Waiting for you";
  return torrentStateLabel(t && t.state);
}

// One row per torrent, in the same shape the Search tab uses — for the same
// reason. Sections gave every torrent a title bar, a paragraph, a progress bar
// and up to six full-width buttons, so three transfers filled the screen and
// nothing could be compared against anything else.
//
// The tile carries the percentage (colour-coded by state), the trailing column
// carries the size, and the subtitle leads with the status and the file count.
function torrentRow(t) {
  var pending = needsChoice(t);
  var bits = [torrentStatusText(t, pending)];

  var count = fileCountOf(t);
  if (count !== null) bits.push(count + (count === 1 ? " file" : " files"));

  // Size sits next to the file count, because the two answer one question
  // together — "how much is this?" — and reading them apart meant crossing the
  // whole row. It is `total_size`, the torrent's real weight; `size` is only
  // what is currently selected and reads 0 B on a torrent nobody has picked
  // files for.
  bits.push(formatBytes(t.total_size || t.size));

  // A torrent nobody has chosen files for has no speed and no ETA worth
  // printing — "↓ — · ETA ∞" is four characters of noise on the one row that
  // needs its instruction read.
  if (!pending) {
    if (isFinished(t)) {
      bits.push("↑ " + formatSpeed(t.upspeed));
      bits.push("ratio " + (Number(t.ratio) || 0).toFixed(2));
    } else {
      bits.push("↓ " + formatSpeed(t.dlspeed));
      bits.push("ETA " + formatEta(t.eta));
    }
  }
  // Both swarms, both halves. This is what decides whether a torrent will ever
  // finish, so it earns the width even though it makes the line long.
  bits.push(swarmText(t.num_seeds, t.num_complete, "seed", "seeds"));
  bits.push(swarmText(t.num_leechs, t.num_incomplete, "leecher", "leechers"));

  return {
    id: t.hash,
    title: t.name || magnetDisplayName(t.magnet_uri) || t.hash,
    subtitle: bits.join("  ·  "),
    // No trailing column. Size used to live there, which is where a *search*
    // result still keeps it — there you are comparing sizes down a list of
    // candidate releases, so a column earns its place. Here you are reading one
    // torrent at a time, and the column only pulled the figure away from the
    // file count it belongs with.
    imageUrl: torrentIconFor(t, pending),
    // Double-click and Enter open the contents. For a container that is what
    // "open it" means — Play is the first overlay button, and playing a torrent
    // you have not looked inside is the rarer intent of the two.
    action: "qbt:show-files"
  };
}

// The facts the Info tab prints, as label/value pairs. Pure and exported, so
// the set can be asserted without rendering: it is the one place a field is
// silently dropped by a typo in a property name.
function torrentInfoLines(t) {
  if (!t) return [];
  var done = isFinished(t);
  var pending = needsChoice(t);
  var out = [{ heading: "Transfer" }];

  out.push({ label: "Status", value: torrentStatusText(t, pending) });
  out.push({ label: "Progress", value: pending ? "0%" : torrentPercent(t) });
  out.push({ label: "Size", value: formatBytes(t.total_size || t.size) });
  out.push({ label: "Downloaded", value: formatBytes(t.downloaded) });
  out.push({ label: "Uploaded", value: formatBytes(t.uploaded) });
  // Speeds and a time-left only while something is ACTUALLY moving. Gating on
  // "not finished" was not enough: a stopped torrent is neither finished nor
  // transferring, so it printed "Download speed: —" and "Time left: ∞", which
  // reads as a fault rather than as a torrent the user paused.
  var halted = isPaused(t) || isErrored(t) || pending;
  if (!done && !halted) {
    out.push({ label: "Download speed", value: formatSpeed(t.dlspeed) });
    out.push({ label: "Time left", value: formatEta(t.eta) });
  }
  // Upload keeps going while seeding, so it survives `done` — but not a stop.
  if (!halted) out.push({ label: "Upload speed", value: formatSpeed(t.upspeed) });
  out.push({ label: "Ratio", value: numOr(t.ratio, 0).toFixed(2) });
  out.push({ label: "Active for", value: formatDuration(t.time_active) });
  out.push({ label: "Added", value: formatAge(t.added_on) });
  if (numOr(t.completion_on, 0) > 0) out.push({ label: "Completed", value: formatAge(t.completion_on) });

  // The swarm decides whether a torrent will ever finish, so it gets its own
  // block rather than being folded in among the byte counters.
  out.push({ heading: "Swarm" });
  out.push({ label: "Seeds", value: swarmDetail(t.num_seeds, t.num_complete) });
  out.push({ label: "Leechers", value: swarmDetail(t.num_leechs, t.num_incomplete) });
  out.push({ label: "Availability", value: formatAvailability(t.availability) });
  out.push({ label: "Trackers", value: numOr(t.trackers_count, 0) });
  out.push({ label: "Last full copy seen", value: formatAge(t.seen_complete) });
  out.push({ label: "Last activity", value: formatAge(t.last_activity) });

  out.push({ heading: "Files and location" });
  var count = fileCountOf(t);
  if (count !== null) {
    var picked = selectionSummary(filesByHash[t.hash]);
    out.push({
      label: "Files",
      value: picked.total
        ? picked.picked + " of " + picked.total + " selected  ·  " + formatBytes(picked.bytes)
        : count + (count === 1 ? " file" : " files")
    });
  }
  if (t.save_path) out.push({ label: "Saving to", value: String(t.save_path) });
  if (t.category) out.push({ label: "Category", value: String(t.category) });
  out.push({ label: "Hash", value: String(t.hash || "") });
  return out;
}

// "12 connected of 40 in the swarm" — spelled out here rather than the row's
// compact "12/40", because this tab has the width and is where someone comes to
// find out what the numbers mean.
function swarmDetail(connected, total) {
  var c = numOr(connected, 0);
  if (c < 0) c = 0;
  var tot = numOr(total, -1);
  if (tot < c) return c + " connected  ·  swarm size unknown";
  return c + " connected  ·  " + tot + " in the swarm";
}

// The contents panel: what is inside one torrent, and which of it is coming.
// It REPLACES the list rather than expanding a row, because the file list is a
// list of its own — nesting one inside a row of another is what the old
// expand-in-place section did, and it left the file rows indented under a
// heading with no way to tell where the torrent ended.
//
// Structure: a plain hero (title + Back), the two controls a torrent has, then
// two tabs — the files you came to choose from, and the numbers you occasionally
// want. The hero is the host's own `detail-header` in `plain` mode: a torrent
// has no artwork, so the full hero was a 320px scrimmed panel wrapped around a
// placeholder disc, but its Back button is the one every detail page in the app
// uses and that is worth keeping.
function torrentDetailNodes(hash) {
  var t = torrents[hash];
  var children = [];
  if (!t) {
    // Removed here or in qBittorrent while its contents were open. Say so
    // rather than rendering an empty panel with no explanation.
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content: "That torrent is no longer in qBittorrent."
    });
    children.push({ type: "button", label: "← Back to torrents", action: "qbt:close-files", variant: "secondary" });
    return children;
  }

  var done = isFinished(t);
  var paused = isPaused(t);
  var armed = !!armedPeek[t.hash];
  // An armed peek is RUNNING and waiting on a file choice, so it is not the
  // paused "press Start download" hold — different banner, different buttons.
  var awaiting = !!pendingSelection[t.hash] && !armed;
  var peeked = !!peekedTorrents[t.hash];
  var rowBusy = busy === t.hash || busy === "*";
  var reachable = filesAreReachable();
  var pending = needsChoice(t);
  var files = filesByHash[t.hash];
  var picked = selectionSummary(files);
  var filter = filterFor(hash);
  var shown = filesInView(hash);

  var metaBits = [];
  if (files) {
    metaBits.push(picked.picked === picked.total
      ? picked.total + (picked.total === 1 ? " file" : " files")
      : picked.picked + " of " + picked.total + " files");
  }
  metaBits.push(formatBytes(t.total_size || t.size));

  children.push({
    type: "detail-header",
    // No artwork, no background, no motion look, no FX picker — a torrent has
    // no image of its own, and the title is what identifies it.
    plain: true,
    title: t.name || magnetDisplayName(t.magnet_uri) || hash,
    subtitle: torrentStatusText(t, pending) + (pending ? "" : "  ·  " + torrentPercent(t)),
    meta: metaBits.join("  ·  "),
    backAction: "qbt:close-files",
    // In the hero, where every other detail page puts Play and Enqueue. These
    // are the two verbs a torrent has, so they replace that pair rather than
    // sitting in a second bar underneath it. A hero button fires with no
    // payload, which is fine here: an action with no target while a contents
    // panel is open can only mean that torrent (see hashesOf).
    buttons: [
      {
        id: paused ? "qbt:start" : "qbt:stop",
        label: paused ? "Start" : "Stop",
        variant: paused ? "primary" : "secondary",
        disabled: rowBusy
      },
      { id: "qbt:delete-ask", label: "Remove…", variant: "danger", disabled: rowBusy }
    ]
  });

  // 0% while nothing is selected: qBittorrent reports 100% for a torrent that
  // wants no files, and a full bar over an empty download is the single most
  // misleading thing this panel could draw.
  var pct = pending ? 0 : Math.round(Math.min(1, Math.max(0, numOr(t.progress, 0))) * 1000) / 10;
  children.push({ type: "progress-bar", value: pct, max: 100, label: pct.toFixed(1) + "%" });

  if (isErrored(t)) {
    children.push({ type: "text", content: "This torrent is in an error state in qBittorrent.", className: "error" });
  }

  children.push({
    type: "tabs",
    activeTab: detailTab,
    action: "qbt:detail-tab",
    tabs: [
      // Files first and first-by-default: choosing what downloads is what this
      // panel is for. The numbers are a reference you occasionally check.
      { id: "files", label: "Files", count: files ? files.length : undefined },
      { id: "info", label: "Info" }
    ]
  });

  if (detailTab === "info") {
    // `plugin-heading` and `plugin-kv` are generic host classes (see
    // PluginViewRenderer.css), not qBittorrent's. A heading has to LOOK like a
    // heading, and a label/value pair needs two columns — one "Label: value"
    // text node has nothing for the values to line up against.
    var lines = torrentInfoLines(t);
    for (var li = 0; li < lines.length; li++) {
      if (lines[li].heading) {
        children.push({ type: "text", className: "plugin-heading", content: lines[li].heading });
      } else {
        children.push({
          type: "layout",
          direction: "horizontal",
          className: "plugin-kv",
          children: [
            { type: "text", className: "plugin-kv-key", content: lines[li].label },
            { type: "text", className: "plugin-kv-value", content: String(lines[li].value) }
          ]
        });
      }
    }
    return children;
  }

  // --- the Files tab --------------------------------------------------------

  if (armed) {
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content:
        "Nothing is downloading. Every file below is set to skip — include the ones you want and they start straight away."
    });
    // No "Start download": there is nothing to start until a file is chosen,
    // and the choosing is what starts it. Discard is still first-class — the
    // expected outcome of a look is often to walk away.
    if (peeked) {
      children.push({
        type: "button",
        label: "Discard this torrent",
        action: "qbt:discard-peek",
        variant: "secondary",
        disabled: rowBusy,
        data: { hash: t.hash }
      });
    }
  }

  if (awaiting) {
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      // Phase by phase, and never ahead of itself: claiming "this is what's
      // inside" above an empty box while the swarm is still being asked was the
      // worst version of this.
      content: metadataFetching[t.hash]
        ? "Asking the swarm what's in this torrent" + elapsedSuffix(t.hash) +
          " — nothing is downloading. A magnet can take a minute."
        : !filesByHash[t.hash]
          ? "Reading the file list…"
          : peeked
            ? "Nothing has downloaded. This is what's inside — press Start download to keep it, or Discard to drop it."
            : "Paused. Choose which files you want below, then press Start download."
    });
    var holdButtons = [
      {
        type: "button",
        // A torrent held for selection leads with the one thing to do next, and
        // its Start button says what it starts — "Start" alone reads as
        // "resume", which is not what is being decided here.
        label: metadataFetching[t.hash] || !filesByHash[t.hash] ? "Waiting for the file list…" : "Start download",
        action: "qbt:start-selected",
        variant: "accent",
        // Nothing to choose from yet, so nothing to confirm yet.
        disabled: rowBusy || !!metadataFetching[t.hash] || !filesByHash[t.hash],
        data: { hash: t.hash }
      }
    ];
    if (peeked) {
      holdButtons.push({
        type: "button",
        label: "Discard",
        action: "qbt:discard-peek",
        variant: "secondary",
        disabled: rowBusy,
        data: { hash: t.hash }
      });
    }
    children.push({ type: "layout", direction: "horizontal", children: holdButtons });
  }

  if (!reachable) {
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content:
        "qBittorrent looks like it's on another machine, so these files aren't on this one. " +
        "If its download folder is mounted here, set the path mapping in Settings → qBittorrent and they'll play."
    });
  }

  if (files && files.length) {
    // Live filter: no button label, so the host fires it on every keystroke.
    // `stateKey` keeps one text per torrent, which is why the plugin's own
    // filter state is keyed by hash too — otherwise the box and the list would
    // disagree the moment you opened a second torrent.
    children.push({
      type: "search-input",
      placeholder: "Filter files — try “flac”, “live”, or a folder name",
      action: "qbt:file-filter",
      value: filter,
      stateKey: "qbt-files:" + hash
    });

    // Nothing matched: say so and offer the way out, or the empty list reads as
    // "this torrent has no files".
    if (filter && !shown.length) {
      children.push({ type: "text", className: "muted", content: "Nothing matches “" + filter + "”." });
      children.push({
        type: "button",
        label: "Clear the filter",
        action: "qbt:file-filter-clear",
        variant: "secondary",
        data: { hash: hash }
      });
    }
  }

  var rows = fileRowsNode(t.hash);
  if (rows) children.push(rows);
  return children;
}

// Two outcomes only, and the cancel side must be the harmless one: the host
// fires `cancelAction` on Escape as well as on the button, so anything
// destructive there would be triggered by the universal "get me out of this"
// key. Removing keeps the files — deleting them from disk is not offered here,
// because the safe default is the one that a mis-click can't cost you data.
function deleteConfirmNode(hashes) {
  var list = [].concat(hashes || []);
  // One torrent is named; several are counted. A confirm that pasted twelve
  // release names into a dialog is one nobody reads.
  var t = torrents[list[0]];
  var what =
    list.length === 1
      ? "“" + ((t && t.name) || list[0]) + "”"
      : list.length + " torrents";
  return {
    type: "confirm",
    title: list.length === 1 ? "Remove torrent" : "Remove torrents",
    message:
      "Remove " + what + " from qBittorrent?\n\n" +
      "The downloaded files stay on disk — this only stops the transfer and drops " +
      (list.length === 1 ? "it" : "them") + " from the list.",
    confirmLabel: "Remove",
    cancelLabel: "Cancel",
    confirmVariant: "danger",
    confirmAction: "qbt:delete-confirm",
    cancelAction: "qbt:delete-cancel"
  };
}

function render() {
  if (!api) return;

  if (pendingDelete && pendingDelete.length) {
    api.ui.setViewData(VIEW_ID, deleteConfirmNode(pendingDelete));
    return;
  }

  var children = [];
  var banner = statusBanner();
  if (banner) children.push(banner);

  // Nothing configured (or a host that can't do the auth): the view's whole job
  // is to get the user set up, so it shows the steps rather than an empty list.
  //
  // It still has to be able to show the SETTINGS. This branch returns before the
  // tab strip and the settings branch further down are ever reached, so without
  // the check below "Open settings" set activeTab and then redrew this very
  // screen — a button whose only effect was to render itself again.
  if (!baseUrl || hostTooOld) {
    if (activeTab === "settings") {
      var setupSettings = settingsTabNodes();
      for (var ui = 0; ui < setupSettings.length; ui++) children.push(setupSettings[ui]);
      // There is no tab strip on this screen, so this is the only way back to
      // the steps that explain what the fields want.
      children.push({
        type: "button",
        label: "← Back to the setup steps",
        action: "qbt:close-settings",
        variant: "secondary"
      });
      api.ui.setViewData(
        VIEW_ID,
        { type: "layout", direction: "vertical", children: children },
        { scrollKey: "settings" }
      );
      return;
    }
    children.push(setupGuideNode());
    children.push({ type: "button", label: "Open settings", action: "qbt:open-settings", variant: "accent" });
    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children });
    return;
  }

  // One list, not three. Downloading/Completed/All were three views of the same
  // rows differing only by a filter the row itself already states, and the split
  // actively hurt: a torrent that finished moved tabs, so it vanished from the
  // list the user was watching it in. Status now sorts the single list instead.
  var list = visibleTorrents();

  children.push({
    type: "tabs",
    activeTab: activeTab,
    action: "qbt:tab",
    tabs: [
      { id: "torrents", label: "Torrents", count: list.length },
      { id: "search", label: "Search" },
      { id: "settings", label: "Settings" }
    ]
  });

  // Reachable from the sidebar in one click. There is no plugin API for opening
  // the host Settings page at a given panel, and sending the user off to find it
  // is the wrong answer when this view is where they already are.
  if (activeTab === "settings") {
    var settingsNodes = settingsTabNodes();
    for (var qi = 0; qi < settingsNodes.length; qi++) children.push(settingsNodes[qi]);
    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children }, { scrollKey: "settings" });
    return;
  }

  if (activeTab === "search") {
    var searchNodes = searchTabNodes();
    for (var si = 0; si < searchNodes.length; si++) children.push(searchNodes[si]);
    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children }, { scrollKey: "search" });
    return;
  }

  // One torrent's contents replaces the list entirely. The add box, the server
  // stats and the start-all/stop-all toolbar all belong to the list, and leaving
  // them above a single torrent's file rows made it ambiguous which of the two
  // "Stop all" would act on.
  if (expandedHash) {
    var detailNodes = torrentDetailNodes(expandedHash);
    for (var di = 0; di < detailNodes.length; di++) children.push(detailNodes[di]);
    api.ui.setViewData(
      VIEW_ID,
      { type: "layout", direction: "vertical", children: children },
      { scrollKey: "torrent:" + expandedHash }
    );
    return;
  }

  children.push({
    type: "search-input",
    placeholder: "Paste a magnet link or .torrent URL",
    action: "qbt:add",
    buttonLabel: "Add",
    pasteButton: true
  });

  // The window between "add accepted" and "torrent found in the list". It can
  // run several seconds, and until now it showed nothing at all — the toast that
  // announced the add had already dismissed itself.
  if (preparingAdd) {
    children.push({
      type: "loading",
      // Past ten seconds the likely reason is that qBittorrent is off fetching the
      // .torrent from a tracker, which is worth saying rather than leaving a
      // spinner to imply the app has hung.
      message: preparingElapsed >= 10
        ? "Still waiting for qBittorrent to pick it up (" + preparingElapsed + "s) — it may be fetching the .torrent from the tracker."
        : "Adding to qBittorrent — waiting for it to appear…"
    });
  }

  // Torrents stranded under a previous category name. Offered, not done
  // automatically: re-tagging someone's torrents is a write to their
  // qBittorrent, and the rename may well have been for a second profile that
  // should NOT inherit the first one's downloads.
  var stranded = restrictToCategory ? hashesInCategory(torrents, previousCategory) : [];
  if (stranded.length) {
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content:
        stranded.length +
        (stranded.length === 1 ? " torrent is" : " torrents are") +
        " still tagged “" + previousCategory + "”, so they're hidden by the “" + category + "” filter."
    });
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        {
          type: "button",
          label: "Move " + (stranded.length === 1 ? "it" : "them") + " to “" + category + "”",
          action: "qbt:move-category",
          variant: "accent"
        },
        { type: "button", label: "Leave them", action: "qbt:forget-category", variant: "secondary" }
      ]
    });
  }

  children.push({
    type: "toolbar",
    buttons: [
      { label: "Start all", action: "qbt:start-all", variant: "secondary", disabled: !connected },
      { label: "Stop all", action: "qbt:stop-all", variant: "secondary", disabled: !connected },
      { label: "Refresh", action: "qbt:refresh", variant: "secondary" }
    ],
    status: statusLine(),
    statusVariant: lastError ? "error" : connected ? "success" : "default"
  });

  if (!list.length) {
    children.push({
      type: "text",
      content: connected
        ? restrictToCategory && category
          ? "No torrents in the “" + category + "” category yet. Paste a magnet link above, or turn off “Only manage my own category” in settings to see everything."
          : "No torrents yet. Paste a magnet link or .torrent URL above."
        : "Not connected to qBittorrent."
    });
  } else {
    var rows = [];
    for (var i = 0; i < list.length; i++) rows.push(torrentRow(list[i]));
    children.push({
      type: "track-row-list",
      selectable: true,
      // A torrent is a container, so clicking one opens it. Cmd/Ctrl and Shift
      // clicks still build the selection the toolbar acts on.
      openOnClick: true,
      items: rows,
      // Play first: it takes the primary overlay slot, and it is the only one of
      // the four that is about the music rather than about the transfer.
      //
      // No Contents button: the row already opens on a plain click and on
      // double-click, so a button for it was a third route to the same place,
      // taking tray width from the actions that have no other route.
      //
      // There is no separate Pause: qBittorrent has Start and Stop and nothing
      // between them — WebAPI 2.11 renamed pause/resume to stop/start precisely
      // because they were one pair, and offering two buttons that post to the
      // same endpoint would be a lie about what the client can do.
      actions: [
        { id: "qbt:play-torrent", label: "Play", icon: "▶" },
        { id: "qbt:start", label: "Start", icon: "⏵" },
        { id: "qbt:stop", label: "Stop", icon: "⏸" },
        { id: "qbt:delete-ask", label: "Remove", icon: "🗑" }
      ]
    });
  }

  api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children }, { scrollKey: activeTab });
}

function updateBadge() {
  if (!api || typeof api.ui.setBadge !== "function") return;
  if (!baseUrl) {
    api.ui.setBadge(VIEW_ID, null);
    return;
  }
  if (lastError) {
    api.ui.setBadge(VIEW_ID, { type: "dot", variant: "error", tooltip: lastError });
    return;
  }
  var active = 0;
  var list = visibleTorrents();
  for (var i = 0; i < list.length; i++) {
    if (!isComplete(list[i]) && !isPaused(list[i])) active++;
  }
  api.ui.setBadge(VIEW_ID, active ? { type: "count", value: active, variant: "accent" } : null);
}

// ---------------------------------------------------------------------------
// Rendering — settings panel
// ---------------------------------------------------------------------------

function currentDraft() {
  if (!draft) {
    draft = {
      baseUrl: baseUrl,
      apiKey: apiKey,
      category: category,
      restrictToCategory: restrictToCategory,
      insecure: insecure,
      pollMs: pollMs,
      pathMapFrom: pathMapFrom,
      pathMapTo: pathMapTo,
      destCollectionId: destCollectionId,
      autoImport: autoImport,
      chooseFilesFirst: chooseFilesFirst
    };
  }
  return draft;
}

function destinationOptions() {
  var destOptions = [{ value: "", label: "qBittorrent's own default folder" }];
  for (var ci = 0; ci < localCollections.length; ci++) {
    var col = localCollections[ci];
    if (!col.path) continue;
    destOptions.push({ value: String(col.id), label: col.name + " — " + col.path });
  }
  return destOptions;
}

function statusSectionChildren(status) {
  var statusChildren = [
    {
      type: "stats-grid",
      items: [
        { label: "Status", value: status.label },
        { label: "qBittorrent", value: qbtVersion || "—" },
        { label: "WebAPI", value: apiVersion || "—" },
        { label: "Viboplr", value: (api.appVersion || "?") + (hostTooOld ? " (too old)" : "") },
        { label: "Sign-in", value: apiKey ? "API key" : "None (localhost bypass)" }
      ]
    }
  ];
  if (status.detail) statusChildren.push({ type: "text", content: status.detail, className: "muted" });
  if (status.fix) {
    statusChildren.push({
      type: "text",
      content: status.fix,
      className: "ds-banner ds-banner--" + (status.tone === "warning" ? "warning" : "error")
    });
  }
  // The steps stay on screen until it actually works. They are the answer to
  // every not-connected state, and hiding them behind a link would put the one
  // thing the user needs one click further away than the error that sent them
  // here.
  if (status.kind !== "ok") {
    var steps = setupSteps();
    for (var i = 0; i < steps.length; i++) {
      statusChildren.push({ type: "text", content: i + 1 + ". " + steps[i] });
    }
    // The one step nobody can complete from inside the app. Prominent when the
    // version IS the problem, available anyway while setting up — someone
    // reading these steps may not have qBittorrent at all yet.
    statusChildren.push({
      type: "button",
      label: status.kind === "qbt-old" ? "Download qBittorrent " + MIN_QBT_VERSION + " or newer" : "Get qBittorrent",
      action: "qbt:open-download",
      variant: status.kind === "qbt-old" ? "accent" : "secondary"
    });
  }
  // Config carried over from when this plugin used a username and password.
  // Said once, plainly, rather than letting the upgrade look like a breakage.
  if (hadLegacyCredentials) {
    statusChildren.unshift({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content:
        "This plugin now signs in with an API key only — your saved username and password are no longer used. " +
        "Create a key in qBittorrent (Tools → Options → Web UI) and paste it below."
    });
  }
  return statusChildren;
}

function renderSettings() {
  if (!api) return;
  var d = currentDraft();
  var destOptions = destinationOptions();
  var status = connectionStatus();
  var statusChildren = statusSectionChildren(status);

  api.ui.setViewData(SETTINGS_ID, settingsTree(d, destOptions, status, statusChildren));
}

function settingsTree(d, destOptions, status, statusChildren) {
  return {
    type: "layout",
    direction: "vertical",
    children: [
      {
        type: "section",
        title: "Status",
        children: statusChildren
      },
      {
        type: "section",
        title: "Connection",
        children: [
          {
            type: "settings-row",
            label: "WebUI address",
            description: "Where qBittorrent's Web interface is, e.g. http://localhost:8080. A reverse-proxy subpath works too.",
            control: { type: "text-input", placeholder: "http://localhost:8080", action: "qbt:set-url", value: d.baseUrl }
          },
          {
            type: "settings-row",
            label: "API key",
            description:
              "In qBittorrent: Tools → Options → Web UI → API keys → create one, then paste it here. " +
              "Leave empty only if you use “Bypass authentication for clients on localhost”. " +
              "Stored in Viboplr's plugin database in plain text — revoke it in qBittorrent if you ever need to.",
            control: { type: "text-input", action: "qbt:set-apikey", password: true, value: d.apiKey }
          },
          {
            type: "settings-row",
            label: "Allow self-signed certificates",
            description: "Only for an https WebUI using its own certificate.",
            control: { type: "toggle", label: "", action: "qbt:set-insecure", checked: !!d.insecure }
          },
          {
            type: "toolbar",
            buttons: [
              { label: "Save & connect", action: "qbt:save", variant: "accent" },
              { label: "Test connection", action: "qbt:test", variant: "secondary" }
            ],
            status: statusLine(),
            statusVariant: lastError ? "error" : connected ? "success" : "default"
          }
        ]
      },
      {
        type: "section",
        title: "Behaviour",
        children: [
          {
            type: "settings-row",
            label: "Category",
            description:
              "Torrents added from Viboplr are tagged with this in qBittorrent. Give each Viboplr profile its own name " +
              "(“viboplr-alex”, “viboplr-work”) and one qBittorrent can serve all of them without the profiles seeing each " +
              "other's downloads. Leave it empty to tag nothing.",
            control: { type: "text-input", placeholder: "viboplr", action: "qbt:set-category", value: d.category }
          },
          {
            type: "settings-row",
            label: "Only manage my own category",
            description: "On (recommended): the Torrents view and its Start all / Stop all buttons only ever touch torrents in the category above. Off: everything in qBittorrent is listed and bulk actions reach all of it.",
            control: { type: "toggle", label: "", action: "qbt:set-restrict", checked: !!d.restrictToCategory }
          },
          {
            type: "settings-row",
            label: "Save downloads to",
            description: destOptions.length > 1
              ? "Torrents added from Viboplr are saved here. Choosing a collection is what lets finished downloads reach your library."
              : "Add a local music folder under Collections first, then you can save downloads straight into it.",
            control: {
              type: "select",
              label: "",
              action: "qbt:set-dest",
              value: String(d.destCollectionId || ""),
              options: destOptions
            }
          },
          {
            type: "settings-row",
            label: "Choose files before downloading",
            description:
              "Adds torrents paused, fetches their file list, and waits for you to pick what to download before any data moves. " +
              "For a magnet this means a brief start to fetch the file list — no files are transferred during that.",
            control: { type: "toggle", label: "", action: "qbt:set-choose-first", checked: !!d.chooseFilesFirst }
          },
          {
            type: "settings-row",
            label: "Add finished downloads to my library",
            description: "When a download finishes inside one of your collections, rescan it so the tracks appear. Files outside every collection are left alone.",
            control: { type: "toggle", label: "", action: "qbt:set-auto-import", checked: !!d.autoImport }
          },
          {
            type: "settings-row",
            label: "Their download folder",
            description: "Only needed when qBittorrent runs on another machine. The path IT saves to, e.g. /downloads.",
            control: { type: "text-input", placeholder: "/downloads", action: "qbt:set-map-from", value: d.pathMapFrom }
          },
          {
            type: "settings-row",
            label: "…is mounted here as",
            description: "Where that same folder appears on this machine, e.g. Z:/torrents. Set both and playing files from a remote qBittorrent works.",
            control: { type: "text-input", placeholder: "Z:/torrents", action: "qbt:set-map-to", value: d.pathMapTo }
          },
          {
            type: "settings-row",
            label: "Refresh interval",
            description: "How often to ask qBittorrent for progress, in seconds (2–60).",
            control: { type: "text-input", placeholder: "5", action: "qbt:set-poll", value: String(Math.round(d.pollMs / 1000)) }
          }
        ]
      }
    ]
  };
}

// The same settings, rendered inside the Torrents view. There is no way for a
// plugin to open the host's Settings page at its own panel, and making the user
// go and find it is a poor answer when the view is where they already are —
// especially before anything is configured, when the view has nothing else to
// show. One builder feeds both surfaces so they cannot drift.
function settingsTabNodes() {
  var d = currentDraft();
  var status = connectionStatus();
  var destOptions = destinationOptions();
  var statusChildren = statusSectionChildren(status);
  var tree = settingsTree(d, destOptions, status, statusChildren);
  return tree.children;
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  return api.storage
    .get(STORAGE_KEY)
    .then(function (saved) {
      var s = saved || {};
      baseUrl = normalizeBaseUrl(s.baseUrl || "");
      apiKey = s.apiKey || "";
      // Config written before the plugin became API-key-only. Surfaced once so the
      // upgrade is explained rather than just failing.
      hadLegacyCredentials = !apiKey && !!(s.username || s.password);
      category = s.category === undefined ? "viboplr" : s.category;
      restrictToCategory = s.restrictToCategory !== false;
      insecure = !!s.insecure;
      pollMs = clampPoll(s.pollMs);
      pathMapFrom = s.pathMapFrom || "";
      pathMapTo = s.pathMapTo || "";
      destCollectionId = s.destCollectionId == null ? "" : String(s.destCollectionId);
      autoImport = s.autoImport !== false;
      chooseFilesFirst = !!s.chooseFilesFirst;
      previousCategory = s.previousCategory || "";
      draft = null;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not read settings:", e);
    });
}

// Write the LIVE settings to storage. Separate from saveSettings so state that
// changes outside the settings panel (clearing a stale category after moving its
// torrents) is persisted by the same payload rather than a second, drifting one.
function persistSettings() {
  return api.storage
    .set(STORAGE_KEY, {
      baseUrl: baseUrl,
      apiKey: apiKey,
      category: category,
      restrictToCategory: restrictToCategory,
      insecure: insecure,
      pollMs: pollMs,
      pathMapFrom: pathMapFrom,
      pathMapTo: pathMapTo,
      destCollectionId: destCollectionId,
      autoImport: autoImport,
      chooseFilesFirst: chooseFilesFirst,
      previousCategory: previousCategory
    })
    .catch(function (e) {
      console.error("qBittorrent: could not save settings:", e);
      api.ui.showNotification("Couldn't save those settings: " + errText(e));
    });
}

function saveSettings() {
  var d = currentDraft();
  var outgoingCategory = category;
  baseUrl = normalizeBaseUrl(d.baseUrl);
  apiKey = (d.apiKey || "").trim();
  category = (d.category || "").trim();
  // Renaming leaves the old torrents tagged with the old name; remember it so
  // they can be found and moved rather than silently disappearing.
  if (outgoingCategory && outgoingCategory !== category) previousCategory = outgoingCategory;
  if (previousCategory === category) previousCategory = "";
  restrictToCategory = !!d.restrictToCategory;
  insecure = !!d.insecure;
  pollMs = clampPoll(d.pollMs);
  pathMapFrom = (d.pathMapFrom || "").trim();
  pathMapTo = (d.pathMapTo || "").trim();
  destCollectionId = d.destCollectionId == null ? "" : String(d.destCollectionId);
  autoImport = !!d.autoImport;
  chooseFilesFirst = !!d.chooseFilesFirst;

  // Any of these can invalidate the session (a new host, new credentials, a
  // different TLS stance), so drop it rather than discovering that on the next
  // 403.
  apiVersion = null;
  qbtVersion = null;
  rid = 0;
  torrents = {};
  filesByHash = {};
  expandedHash = null;
  categoryEnsured = false;
  connected = false;
  lastError = null;

  return persistSettings()
    .then(function () {
      draft = null;
      renderSettings();
      startPolling();
      return refresh();
    })
    .then(function () {
      renderSettings();
    });
}

function testConnection() {
  var d = currentDraft();
  var probeUrl = normalizeBaseUrl(d.baseUrl);
  if (!probeUrl) {
    api.ui.showNotification("Enter the WebUI address first");
    return Promise.resolve();
  }
  // Test what is typed, not what is saved — otherwise the button answers a
  // question the user isn't asking. The poll loop is paused for the duration:
  // it shares these globals, and a tick landing mid-test would run against
  // half-applied credentials and report a failure that isn't real.
  stopPolling();
  var prev = {
    baseUrl: baseUrl,
    apiKey: apiKey,
    insecure: insecure,
  };
  baseUrl = probeUrl;
  apiKey = (d.apiKey || "").trim();
  insecure = !!d.insecure;

  // An API key has no login to test — sending one to auth/* is forbidden — so
  // the request itself is the test.
  return (apiKey ? Promise.resolve(null) : login())
    .then(function () {
      return authed("/app/version");
    })
    .then(function (resp) {
      expectOk(resp, "Reading the version");
      return resp.text();
    })
    .then(function (version) {
      api.ui.showNotification("Connected to qBittorrent " + String(version || "").trim());
      lastError = null;
    })
    .catch(function (e) {
      console.error("qBittorrent: connection test failed:", e);
      lastError = errText(e);
      api.ui.showNotification("Couldn't connect: " + errText(e));
    })
    .then(function () {
      // Restore whatever was actually saved; the test must not leave a session
      // built from unsaved credentials behind.
      baseUrl = prev.baseUrl;
      apiKey = prev.apiKey;
      insecure = prev.insecure;
      renderSettings();
      startPolling();
    });
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

// There is no "view opened" signal in the plugin API, so this runs on a fixed
// cadence while the plugin is enabled and a server is configured. A maindata
// delta with nothing to report is a few hundred bytes, and the interval is a
// setting, so the cost stays proportional.
function startPolling() {
  stopPolling();
  if (!baseUrl || stopped || hostTooOld) return;
  var tick = function () {
    if (stopped) return;
    refresh()
      .catch(function (e) {
        console.error("qBittorrent: poll failed:", e);
      })
      .then(function () {
        if (stopped) return;
        pollTimer = setTimeout(tick, pollMs);
      });
  };
  tick();
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function hashOf(data) {
  var list = hashesOf(data);
  return list.length ? list[0] : null;
}

// Torrent actions now arrive from two shapes: the contents panel's buttons send
// `{ hash }`, and the row list sends `{ selectedIds, itemId }` — the overlay
// button with one id, the toolbar with the whole selection. Every handler goes
// through this so a multi-row selection works everywhere a single row does.
function hashesOf(data) {
  if (data && data.hash) return [String(data.hash)];
  // The detail hero's overflow menu fires its actions with NO data — the host
  // has no per-item context to attach. While a torrent's contents are open,
  // an action with no target can only mean that torrent.
  if (expandedHash && !(data && (data.selectedIds || data.itemId))) return [expandedHash];
  var ids = rowIds(data);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    // Row ids are hashes here, but the same handlers are reachable from the
    // file list, whose ids are indices. Anything that isn't a known torrent is
    // dropped rather than posted to qBittorrent.
    if (torrents[ids[i]]) out.push(ids[i]);
  }
  return out;
}

// Resolve qbt://<hash>/<index> to the file on disk. The host slices off exactly
// "file://" and hands the rest to mpv, so the path goes back RAW — no percent
// encoding, forward slashes on every platform.
function registerStreamResolver() {
  if (!api.playback || typeof api.playback.onResolveStreamByUri !== "function") return;
  api.playback.onResolveStreamByUri("qbt", function (id) {
    var ref = parseQbtUri(id);
    if (!ref) return Promise.resolve(null);
    var torrent = torrents[ref.hash];
    // A torrent the poll hasn't seen yet (a queue restored at startup, before
    // the first refresh) still has to resolve, so fetch it rather than giving up.
    var ensureTorrent = torrent ? Promise.resolve(torrent) : refresh().then(function () { return torrents[ref.hash]; });
    return ensureTorrent.then(function (t) {
      if (!t) throw new Error("That torrent is no longer in qBittorrent");
      return ensureFiles(ref.hash).then(function (files) {
        var file = null;
        for (var i = 0; i < files.length; i++) {
          if (files[i].index === ref.index) { file = files[i]; break; }
        }
        if (!file) throw new Error("That file is no longer in the torrent");
        var path = localPathFor(t, file);
        if (!path) throw new Error("qBittorrent didn't report where it saved this torrent");
        var url = "file://" + path;
        // The object form, purely to carry `sourceUrl`. A bare URL string has
        // nowhere to put it, and without it the now-playing source panel falls
        // back to the track's own URI — so a file sitting on this disk is
        // described as "qbt://<hash>/3", with no path shown and no Open folder.
        //
        // Version-gated, and this one is NOT cosmetic. Until HOST_FILE_CANDIDATE
        // the host assumed every candidate was a network stream: it handed the
        // media element the URL verbatim and told mpv it was http. A `file://`
        // there is unloadable in the webview, so the object form silently breaks
        // playback on an older host. The bare string takes the generic
        // classifier path, which has always handled file:// correctly.
        if (compareVersions(api.appVersion || "0", HOST_FILE_CANDIDATE) >= 0) {
          return { candidates: [{ url: url, kind: "muxed" }], sourceUrl: url };
        }
        return url;
      });
    });
  });
}

function searchTabNodes() {
  var children = [
    {
      type: "search-input",
      placeholder: "Search torrents — try “artist album”",
      action: "qbt:search",
      buttonLabel: "Search",
      value: searchQuery
    }
  ];

  if (searchError === "no-plugins") {
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content:
        "qBittorrent has no search plugins enabled, so it has nowhere to search. " +
        "Add one in qBittorrent under View → Search Engine → Search plugins, then try again."
    });
    return children;
  }
  if (searchError) {
    children.push({ type: "text", className: "ds-banner ds-banner--error", content: searchError });
    return children;
  }

  if (searchRunning) {
    children.push({
      type: "loading",
      message: searchResults.length
        ? "Searching… " + searchResults.length + " so far"
        : "Searching " + (searchPlugins ? searchPlugins.length : 0) + " indexers…"
    });
    // A slow indexer can hold a search open for the full 45s budget, and until
    // now the only way out was to start a different search.
    children.push({ type: "button", label: "Stop searching", action: "qbt:search-stop", variant: "secondary" });
  }

  if (!searchResults.length) {
    if (searchStopped) {
      // Not "nothing found" — the search was cut short, so it never got to say.
      children.push({ type: "text", content: "Search stopped before anything came back." });
    } else if (!searchRunning && searchQuery) {
      children.push({ type: "text", content: "Nothing found for “" + searchQuery + "”." });
    } else if (!searchRunning) {
      children.push({
        type: "text",
        content: "Search the indexers you've enabled in qBittorrent, and download what you find straight to your library folder.",
        className: "muted"
      });
    }
    return children;
  }

  children.push({
    type: "text",
    content: realSearchResults().length + " results" + (searchStopped ? " — stopped early" : ""),
    className: "muted"
  });

  // Plugin error rows first, as warnings rather than fake torrents — an indexer
  // that is misconfigured is worth saying out loud, since otherwise its results
  // are simply missing with no explanation.
  for (var n = 0; n < searchResults.length; n++) {
    if (!isPluginNotice(searchResults[n])) continue;
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content: (searchResults[n].engineName ? searchResults[n].engineName + ": " : "") +
        String(searchResults[n].fileName || "This search plugin reported a problem")
    });
  }

  // A results list, not a stack of cards. One section per result gave every row
  // a title bar, a paragraph and two full-width buttons, so four results filled
  // the screen and nothing could be compared at a glance.
  //
  // It is the host's selectable row list, which is what every other search
  // surface in the app uses: hover overlay buttons, multi-select, keyboard
  // navigation, and a toolbar that applies an action to the whole selection.
  // The reason this was abandoned before — that a plain click only selected and
  // nothing acted on the row — is fixed by giving each row an `action`, so
  // double-click and Enter download it, exactly like a track anywhere else.
  var rows = [];
  for (var i = 0; i < searchResults.length; i++) {
    if (isPluginNotice(searchResults[i])) continue;
    rows.push(searchResultRow(searchResults[i]));
  }
  children.push({
    type: "track-row-list",
    selectable: true,
    items: rows,
    // Download is first, so it takes the primary/accent overlay slot and is what
    // a double-click falls back to. "View contents" adds the torrent paused, so
    // it is a way of looking before committing, not a preview — hence the
    // second, quieter slot.
    actions: [
      { id: "qbt:search-add", label: "Download", icon: "⬇" },
      { id: "qbt:search-view", label: "View contents", icon: "📂" }
    ]
  });
  return children;
}


function fileRowsNode(hash) {
  var torrent = torrents[hash];
  var files = filesByHash[hash];
  if (filesLoading === hash && !files) return { type: "loading", message: "Reading files…" };
  // A torrent held for selection has an open, EMPTY files area until the list
  // arrives — which for a magnet is however long the swarm takes. Returning null
  // there left a banner promising "this is what's inside" above a blank space.
  if (!files && pendingSelection[hash]) {
    return {
      type: "loading",
      message: metadataFetching[hash]
        ? "Asking the swarm what's in this torrent…" + elapsedSuffix(hash)
        : "Reading the file list…"
    };
  }
  if (!files) return null;

  // Every file, not just the playable ones: this is the torrent's CONTENTS, and
  // choosing what to download is the main reason to look at it — you cannot skip
  // a 4 GB video extra that the list filtered out.
  if (!files.length) {
    return { type: "text", content: "qBittorrent hasn't got this torrent's file list yet.", className: "muted" };
  }
  // The user's filter, if any. Row ids are file INDICES, not positions, so
  // filtering cannot make an action land on the wrong file.
  var all = filesInView(hash);
  // From every file, not the filtered ones — a filter narrows the list, it does
  // not re-title what is left.
  var commonRoot = commonFolder(files);
  if (!all.length) {
    return {
      type: "button",
      label: "Clear the filter",
      action: "qbt:file-filter-clear",
      variant: "secondary",
      data: { hash: hash }
    };
  }

  all.sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  var items = [];
  for (var j = 0; j < all.length; j++) {
    var f = all[j];
    var kind = mediaKindOf(f.name);
    // Same numeric coercion as everything else reading these fields — see numOr.
    var done = numOr(f.progress, 0) >= 1;
    var skipped = numOr(f.priority, 1) === 0;
    var parsed = parseFileTrack(f.name);
    // A non-media file keeps its real filename: "cover" and "01" are what the
    // track parser would leave, which is useless when deciding whether to skip
    // something.
    var label = kind ? parsed.title : baseName(f.name);
    // …prefixed by the folder it lives in. parseFileTrack strips the path, so
    // the row was showing leaves only: two "01"s from CD1 and CD2 were the same
    // row twice, and a folder of scans was indistinguishable from tracks at the
    // root. The filter already matches on the full path, so this is also what
    // makes a search for a folder name explain its own results.
    var folder = fileFolder(f.name, commonRoot);
    var title = folder ? folder + " / " + label : label;
    // Selection state in words, before the progress. A row that only said "45%"
    // left "is this file even coming?" unanswered — which is the question this
    // list exists to settle — and a deselected file has no percentage worth
    // printing, because it will never move. The torrent is passed in because
    // "Downloading" is a claim about the transfer, not about the file.
    // Size follows the status on the same line, for the reason it does on a
    // torrent row: the two are read together, and a trailing column put them at
    // opposite ends of the row.
    var subtitle = fileStatusText(f, torrent) + "  ·  " + formatBytes(f.size);
    items.push({
      id: String(f.index),
      // No "⊘"/"◌" prefix on the name any more: the tile carries the state in
      // colour and the subtitle says it in words, and a third copy glued to the
      // front of the filename only made the names harder to read.
      title: title,
      subtitle: subtitle,
      imageUrl: fileIconFor(f, torrent),
      // Each row offers only what it can actually do.
      //
      // A DOWNLOADED file is the only one worth playing or queueing: the bytes
      // are on disk. It gets neither Download (nothing left to fetch) nor Skip
      // (that would only stop seeding a file the user already has, which is not
      // what "skip" means anywhere else in this list).
      //
      // Anything else is a choice about whether to fetch it, and Download and
      // Skip are that choice in two directions — so a row offers the one it is
      // not already in. Play and Add to queue would act on a file that does not
      // exist yet.
      actions: done
        ? ["qbt:play-file", "qbt:enqueue-file"]
        : skipped
          ? ["qbt:file-download"]
          : ["qbt:file-skip"],
      album: torrent ? torrent.name : undefined,
      // Named rather than left to the host fallback (which fires the first
      // visible action), so a double-click can never mean something the row did
      // not put first on purpose.
      action: kind && done ? "qbt:play-file" : skipped ? "qbt:file-download" : "qbt:file-skip",
      // Only a finished, reachable, PLAYABLE file gets a path — that is what
      // makes the host's right-click menu and drag-to-queue work on these rows.
      path: kind && done && filesAreReachable() ? qbtUri(hash, f.index) : null,
      artistName: kind ? parsed.artist : null,
      albumTitle: kind && torrent ? torrent.name : null
    });
  }
  // `selectable` selects the host's library-parity row list: hover Play /
  // Add-to-queue overlay buttons, multi-select, keyboard listbox navigation and
  // drag-to-queue — the same behaviour every other track list in the app has.
  // The FIRST action is the one the host styles as Play (and the one a
  // double-click fires), so its order is load-bearing.
  // The FIRST action is the one the host styles as primary and the one a
  // double-click falls back to, so the order follows what the list is FOR.
  // While nothing is selected — a torrent opened with "View contents" — that is
  // picking files; Play and Add to queue would act on files that do not exist
  // on disk yet. Once something is selected it reverts to a normal track list.
  // "Audio" / "Video" sit with the host list's own All / None, because that is
  // what they are: a preset SELECTS rows. The actions below are what act on a
  // selection — keeping the two apart is why there is no longer a second
  // Download toolbar duplicating the idea.
  var kinds = partitionByKind(all);
  var presets = [
    { id: "audio", label: "Audio", ids: kinds.audio.map(String) },
    { id: "video", label: "Video", ids: kinds.video.map(String) }
  ];

  // Declared once for the whole list so the buttons line up down the column;
  // each row then names the subset that applies to it (see the rows above).
  // Download and Skip are the same decision in two directions, so a row only
  // ever offers the one it is not already in — the other would be a no-op.
  return {
    type: "track-row-list",
    items: items,
    numbered: true,
    selectable: true,
    selectionPresets: presets,
    actions: [
      { id: "qbt:play-file", label: "Play", icon: "▶" },
      { id: "qbt:enqueue-file", label: "Add to queue", icon: "+" },
      { id: "qbt:file-download", label: "Download", icon: "↓" },
      { id: "qbt:file-skip", label: "Skip", icon: "⊘" }
    ]
  };
}

// "Find torrents" on a library item: build the query, open the view, search.
// The view is opened FIRST so the user lands on the running search rather than
// on a page that changes under them when it finishes.
function registerContextMenu() {
  if (!api.contextMenu || typeof api.contextMenu.onAction !== "function") return;
  api.contextMenu.onAction("qbt-find-torrents", function (target) {
    var query = searchQueryForTarget(target);
    if (!query) {
      api.ui.showNotification("Nothing to search for on that item");
      return;
    }
    activeTab = "search";
    if (typeof api.ui.navigateToView === "function") api.ui.navigateToView(VIEW_ID);
    runSearch(query);
  });
}

function registerActions() {
  api.ui.onAction("qbt:tab", function (data) {
    var id = (data && data.tabId) || (data && data.id) || activeTab;
    // The Downloading/Completed/All split is gone. A view restored from a
    // pre-consolidation session can still name one of them; they all mean the
    // single list now, and falling through would leave a blank tab strip.
    if (id === "downloading" || id === "completed" || id === "all") id = "torrents";
    activeTab = id;
    render();
  });

  api.ui.onAction("qbt:add", function (data) {
    addTorrent((data && data.query) || "");
  });

  api.ui.onAction("qbt:open-download", function () {
    if (typeof api.network.openUrl !== "function") {
      api.ui.showNotification("Download qBittorrent from " + QBT_DOWNLOAD_URL);
      return;
    }
    api.network.openUrl(QBT_DOWNLOAD_URL).catch(function (e) {
      console.error("qBittorrent: could not open the download page:", e);
      // The URL is the actual answer, so say it rather than only reporting that
      // the browser didn't open.
      api.ui.showNotification("Couldn't open the browser — the download page is " + QBT_DOWNLOAD_URL);
    });
  });

  api.ui.onAction("qbt:open-settings", function () {
    activeTab = "settings";
    render();
  });

  api.ui.onAction("qbt:close-settings", function () {
    activeTab = "torrents";
    render();
  });

  api.ui.onAction("qbt:refresh", function () {
    refresh();
  });

  api.ui.onAction("qbt:move-category", function () {
    var hashes = hashesInCategory(torrents, previousCategory);
    if (!hashes.length) {
      previousCategory = "";
      render();
      return;
    }
    ensureCategory()
      .then(function () {
        return authed("/torrents/setCategory", {
          method: "POST",
          form: { hashes: hashes.join("|"), category: category }
        });
      })
      .then(function (resp) {
        expectOk(resp, "Moving the torrents");
        previousCategory = "";
        persistSettings();
        api.ui.showNotification("Moved " + hashes.length + " to “" + category + "”");
        return refresh();
      })
      .catch(function (e) {
        console.error("qBittorrent: could not move torrents to the new category:", e);
        api.ui.showNotification("Couldn't move them: " + errText(e));
      });
  });

  api.ui.onAction("qbt:forget-category", function () {
    // The torrents stay where they are; we just stop asking.
    previousCategory = "";
    persistSettings();
    render();
  });

  api.ui.onAction("qbt:search", function (data) {
    runSearch((data && data.query) || "");
  });

  api.ui.onAction("qbt:search-stop", function () {
    stopSearch();
  });

  api.ui.onAction("qbt:search-add", function (data) {
    // Search rows are keyed by URL, not by index — see searchResultId.
    var ids = rowIds(data);
    if (!ids.length) {
      api.ui.showNotification("Couldn't tell which result that was — try again");
      return;
    }
    for (var i = 0; i < ids.length; i++) addSearchResult(ids[i]);
  });

  api.ui.onAction("qbt:search-view", function (data) {
    var ids = rowIds(data);
    if (!ids.length) {
      api.ui.showNotification("Couldn't tell which result that was — try again");
      return;
    }
    // "View contents" ADDS the torrent, paused — that is the only way to learn
    // what is inside one, and nothing transfers until Start download. So it is
    // one at a time even from a multi-row selection: doing it to a whole
    // selection would leave a pile of paused torrents to clean up.
    if (ids.length > 1) {
      api.ui.showNotification("Showing what's inside the first one — contents open one torrent at a time");
    }
    addSearchResult(ids[0], { peek: true });
  });

  api.ui.onAction("qbt:start", function (data) {
    var hashes = hashesOf(data);
    if (!hashes.length) return;
    for (var i = 0; i < hashes.length; i++) {
      // Starting by hand ends the selection hold — the user has decided.
      delete pendingSelection[hashes[i]];
      delete peekedTorrents[hashes[i]];
      delete armedPeek[hashes[i]];
    }
    actOn(startEndpoint(), hashes, hashes.length === 1 ? "Starting the torrent" : "Starting the torrents");
  });

  api.ui.onAction("qbt:discard-peek", function (data) {
    var hash = hashOf(data);
    if (!hash) return;
    delete pendingSelection[hash];
    delete peekedTorrents[hash];
    delete metadataFetching[hash];
    delete armedPeek[hash];
    if (expandedHash === hash) expandedHash = null;
    // deleteFiles is false: a peek downloads no content, and this must never be
    // a route to deleting data the user already had.
    deleteTorrents([hash], false);
  });

  api.ui.onAction("qbt:start-selected", function (data) {
    var hash = hashOf(data);
    if (!hash) return;
    delete pendingSelection[hash];
    delete peekedTorrents[hash];
    var files = filesByHash[hash] || [];
    var kept = 0;
    for (var i = 0; i < files.length; i++) {
      if (numOr(files[i].priority, 1) !== 0) kept++;
    }
    if (files.length && !kept) {
      // Starting with everything skipped downloads nothing and looks broken.
      pendingSelection[hash] = true;
      api.ui.showNotification("Every file is set to skip — include at least one first");
      render();
      return;
    }
    actOn(startEndpoint(), [hash], "Starting the download");
  });

  api.ui.onAction("qbt:stop", function (data) {
    var hashes = hashesOf(data);
    if (hashes.length) {
      actOn(stopEndpoint(), hashes, hashes.length === 1 ? "Stopping the torrent" : "Stopping the torrents");
    }
  });

  api.ui.onAction("qbt:start-all", function () {
    actOn(startEndpoint(), hashesInView(), "Starting the torrents");
  });

  api.ui.onAction("qbt:stop-all", function () {
    actOn(stopEndpoint(), hashesInView(), "Stopping the torrents");
  });

  api.ui.onAction("qbt:show-files", function (data) {
    // One at a time: the contents panel replaces the list, so a multi-row
    // selection opens the first of them rather than nothing at all.
    var hash = hashOf(data);
    if (!hash) return;
    expandedHash = hash;
    render();
    ensureFiles(hash);
  });

  api.ui.onAction("qbt:detail-tab", function (data) {
    detailTab = (data && (data.tabId || data.id)) || detailTab;
    render();
  });

  api.ui.onAction("qbt:close-files", function () {
    expandedHash = null;
    render();
  });

  api.ui.onAction("qbt:import", function (data) {
    var hash = hashOf(data);
    var t = hash && torrents[hash];
    if (!t) return;
    var c = collectionForTorrent(t);
    if (!c) {
      api.ui.showNotification("These files aren't inside one of your collections");
      return;
    }
    if (!api.collections || typeof api.collections.resync !== "function") {
      api.ui.showNotification("Rescanning a collection needs Viboplr " + MIN_HOST_VERSION + " or newer");
      return;
    }
    api.collections
      .resync(Number(c.id))
      .then(function () {
        api.ui.showNotification("Scanning “" + c.name + "” for the new files");
      })
      .catch(function (e) {
        console.error("qBittorrent: rescan failed:", e);
        api.ui.showNotification("Couldn't start the scan: " + errText(e));
      });
  });

  api.ui.onAction("qbt:play-torrent", function (data) {
    var hashes = hashesOf(data);
    if (!hashes.length) return;
    // One at a time: playing replaces the queue, so a multi-row selection would
    // otherwise silently discard all but one of the torrents the user picked.
    if (hashes.length > 1) api.ui.showNotification("Playing the first of the selected torrents");
    playFiles(hashes[0], null);
  });

  api.ui.onAction("qbt:play-file", function (data) {
    // The row ids are file indices; the expanded torrent is the one they belong
    // to.
    var indices = rowIndices(data);
    if (!indices.length || !expandedHash) return;
    // Exactly what was selected, one row or many — Play on a row plays THAT
    // file. It used to start the whole torrent from that point, on the argument
    // that clicking a track in any other list does that; but this list is a
    // torrent's contents, most of which is usually not music, and "play this
    // one" is the only reading of a button on a single file. Whole-torrent
    // playback is what the file list's All + Play does.
    var tracks = tracksForIndices(expandedHash, indices);
    if (!tracks.length) {
      api.ui.showNotification(
        indices.length === 1
          ? "That file hasn't finished downloading yet"
          : "Nothing there that's finished downloading"
      );
      return;
    }
    var t = torrents[expandedHash];
    api.playback.playTracks(tracks, 0, { name: (t && t.name) || "Torrent" });
  });

  api.ui.onAction("qbt:file-download", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 1);
  });

  api.ui.onAction("qbt:file-skip", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 0);
  });

  api.ui.onAction("qbt:file-filter", function (data) {
    if (!expandedHash) return;
    fileFilters[expandedHash] = String((data && data.query) || "");
    render();
  });

  api.ui.onAction("qbt:file-filter-clear", function (data) {
    var hash = hashOf(data) || expandedHash;
    if (!hash) return;
    delete fileFilters[hash];
    render();
  });

  api.ui.onAction("qbt:enqueue-file", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) enqueueFiles(expandedHash, indices);
  });
  api.ui.onAction("qbt:delete-ask", function (data) {
    pendingDelete = hashesOf(data);
    if (!pendingDelete.length) return;
    render();
  });

  api.ui.onAction("qbt:delete-confirm", function (data) {
    // The confirm node carries no data — the pending list is the only source,
    // so a stale `hash` on the event can't delete something else.
    deleteTorrents(pendingDelete || [], false);
  });

  api.ui.onAction("qbt:delete-cancel", function () {
    pendingDelete = null;
    render();
  });

  // Settings.
  api.ui.onAction("qbt:set-url", function (data) {
    currentDraft().baseUrl = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-apikey", function (data) {
    currentDraft().apiKey = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-category", function (data) {
    currentDraft().category = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-dest", function (data) {
    currentDraft().destCollectionId = (data && data.value) || "";
    renderSettings();
  });
  api.ui.onAction("qbt:set-choose-first", function (data) {
    currentDraft().chooseFilesFirst = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:set-auto-import", function (data) {
    currentDraft().autoImport = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:set-map-from", function (data) {
    currentDraft().pathMapFrom = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-map-to", function (data) {
    currentDraft().pathMapTo = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-poll", function (data) {
    currentDraft().pollMs = clampPoll(Number((data && data.value) || 0) * 1000);
  });
  api.ui.onAction("qbt:set-insecure", function (data) {
    currentDraft().insecure = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:set-restrict", function (data) {
    currentDraft().restrictToCategory = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:save", function () {
    saveSettings();
  });
  api.ui.onAction("qbt:test", function () {
    testConnection();
  });
}

// Bulk actions act on exactly what the user can see — which, with the category
// restriction on, is only this plugin's own torrents.
function hashesInView() {
  var list = visibleTorrents();
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(list[i].hash);
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function activate(hostApi) {
  api = hostApi;
  stopped = false;
  // manifest.json's minAppVersion already blocks a gallery install on an older
  // host, but a side-loaded or dev copy bypasses that — so check and say so
  // plainly, rather than letting it surface as a session error later.
  hostTooOld = compareVersions(api.appVersion || "0", MIN_HOST_VERSION) < 0;
  if (hostTooOld) {
    api.log("warn", "qBittorrent plugin needs Viboplr " + MIN_HOST_VERSION + "+, running " + api.appVersion, "qbittorrent");
  }
  registerActions();
  registerStreamResolver();
  registerContextMenu();
  render();
  renderSettings();

  loadSettings()
    .then(loadCollections)
    .then(function () {
      render();
      renderSettings();
      startPolling();
    })
    .catch(function (e) {
      console.error("qBittorrent: activation failed:", e);
    });
}

function deactivate() {
  stopped = true;
  stopPolling();
  // A search job outlives the plugin on the server, and qBittorrent caps how
  // many can exist — so disabling mid-search must not strand one. Fire and
  // forget: the plugin is going away and cannot wait for the round trip.
  if (searchJobId != null) {
    searchGen++;
    var strandedJob = searchJobId;
    searchJobId = null;
    searchRunning = false;
    disposeSearch(strandedJob).catch(function (e) {
      console.error("qBittorrent: could not dispose of the search job on deactivate:", e);
    });
  }
  // The session dies with the plugin; nothing about it is worth persisting.
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for the test harness.
  _normalizeBaseUrl: normalizeBaseUrl,
  _compareVersions: compareVersions,
  _supportsStartStop: supportsStartStop,
  _formatBytes: formatBytes,
  _formatSpeed: formatSpeed,
  _formatEta: formatEta,
  _torrentStateLabel: torrentStateLabel,
  _isComplete: isComplete,
  _isPaused: isPaused,
  _isErrored: isErrored,
  _statusRank: statusRank,
  _mergeMaindata: mergeMaindata,
  _classifyConnectionError: classifyConnectionError,
  _searchQueryForTarget: searchQueryForTarget,
  _rowIndices: rowIndices,
  _rowIds: rowIds,
  _searchResultId: searchResultId,
  _hashesInCategory: hashesInCategory,
  _siteLabel: siteLabel,
  _sortSearchResults: sortSearchResults,
  _searchResultSubtitle: searchResultSubtitle,
  _searchResultRow: searchResultRow,
  _swarmCount: swarmCount,
  _collectionForPath: collectionForPath,
  _detectCompletions: detectCompletions,
  _mediaKindOf: mediaKindOf,
  _classifyTorrentMedia: classifyTorrentMedia,
  _mediaIconFor: mediaIconFor,
  _mediaTileSvg: mediaTileSvg,
  _seedBand: seedBand,
  _formatSeedCount: formatSeedCount,
  _progressBand: progressBand,
  _torrentPercent: torrentPercent,
  _torrentIconFor: torrentIconFor,
  _fileIconFor: fileIconFor,
  _fileState: fileState,
  _fileStatusText: fileStatusText,
  _numOr: numOr,
  _parseFileList: parseFileList,
  _fileListSignature: fileListSignature,
  _torrentRow: torrentRow,
  _torrentDetailNodes: torrentDetailNodes,
  _torrentInfoLines: torrentInfoLines,
  _swarmDetail: swarmDetail,
  _torrentStatusText: torrentStatusText,
  _armPeek: armPeek,
  _nothingSelected: nothingSelected,
  _isFinished: isFinished,
  _isWindowsPath: isWindowsPath,
  _joinRemotePath: joinRemotePath,
  _applyPathMapping: applyPathMapping,
  _isLikelyLocalHost: isLikelyLocalHost,
  _parseFileTrack: parseFileTrack,
  _fileFolder: fileFolder,
  _commonFolder: commonFolder,
  _folderSegments: folderSegments,
  _baseName: baseName,
  _qbtUri: qbtUri,
  _parseQbtUri: parseQbtUri,
  _playableFiles: playableFiles,
  _partitionByKind: partitionByKind,
  _matchesFilter: matchesFilter,
  _filterFiles: filterFiles,
  _selectionSummary: selectionSummary,
  _formatAge: formatAge,
  _formatDuration: formatDuration,
  _formatAvailability: formatAvailability,
  _swarmText: swarmText,
  _magnetHash: magnetHash,
  _newHashes: newHashes,
  _normalizeTorrentName: normalizeTorrentName,
  _findTorrentByName: findTorrentByName,
  _hasMetadata: hasMetadata,
  _setupSteps: setupSteps,
  _looksLikeTorrentSource: looksLikeTorrentSource,
  _magnetDisplayName: magnetDisplayName,
  _encodeForm: encodeForm,
  _clampPoll: clampPoll
};
