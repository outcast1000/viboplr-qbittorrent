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
// When a play request matches a file a torrent HOLDS but hasn't downloaded,
// quietly start that file downloading (the play itself falls through to the
// next source — torrents can't answer in stream-resolve time).
var autoFetchFound = true;
// Let the download provider go and FIND a torrent (search, examine, fetch)
// when no existing torrent has the track.
var discoveryEnabled = true;
// What happens to a torrent the discovery engine downloaded, once its file is
// delivered: "seed" keeps it (safe for private-tracker ratios, and the rest of
// the album becomes instantly playable), "import" copies the file into the
// library flow and removes the torrent, "remove" drops the torrent but keeps
// the file on disk.
var tier3Disposition = "seed";
// Web indexers: which definitions are switched off (bundled ones stay in the
// plugin, so upgrades can't clobber the user's choice), and any definitions
// the user pasted in settings (validated at paste time).
var webIndexersDisabled = {};
var customIndexers = [];
// The settings paste box for a new indexer definition. Session-only draft.
var webIndexerDraft = "";
// Set by registerActions; used to give custom defs their action handlers both
// at paste time and after loadSettings restores them (registerActions runs
// before settings have loaded, so the restore can't happen inline there).
var registerCustomIndexerActions = null;

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
// The torrents tab's filter box. One string, because there is one list — it is
// matched against torrent NAMES and against the FILE NAMES inside them (via
// fileNamesByHash), so "jóga flac" finds the compilation that never says Björk
// in its release name.
var listFilter = "";

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
  // Downloaded wins over deselected: a file whose bytes are on disk reads
  // "Downloaded" whatever its priority. Deselecting a file you already have
  // (to stop seeding it) doesn't un-download it, so calling it "Not selected"
  // would hide that it's sitting right there, playable.
  if (numOr(f && f.progress, 0) >= 1) return "done";
  if (numOr(f && f.priority, 1) === 0) return "skipped";
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

// Same matcher, over plain name strings — the shape the cross-torrent name
// cache holds, where there is no file object to carry.
function matchingNames(names, query) {
  var list = names || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (matchesFilter(list[i], query)) out.push(list[i]);
  }
  return out;
}

// The torrents-tab filter, over names AND the files inside. Three verdicts per
// torrent, and the third is the one that keeps the view honest: a torrent whose
// name doesn't match and whose file list ISN'T CACHED YET is not a non-match,
// it is unknown — it goes in `unchecked`, and the view says "still checking N"
// instead of letting a cold cache read as "nothing found".
//
// `fileMatches` is empty for a name match on purpose: it feeds the row's
// "matches …" note, which exists to explain a torrent whose OWN name gives no
// clue why it is in the filtered list. A name match explains itself.
function filterTorrentList(list, query, namesByHash) {
  var q = String(query == null ? "" : query).trim();
  var shown = [];
  var unchecked = 0;
  var all = list || [];
  var byHash = namesByHash || {};
  for (var i = 0; i < all.length; i++) {
    var t = all[i];
    if (!q) {
      shown.push({ torrent: t, fileMatches: [] });
      continue;
    }
    var title = t.name || magnetDisplayName(t.magnet_uri) || t.hash;
    if (matchesFilter(title, q)) {
      shown.push({ torrent: t, fileMatches: [] });
      continue;
    }
    var names = byHash[t.hash];
    if (names) {
      var m = matchingNames(names, q);
      if (m.length) shown.push({ torrent: t, fileMatches: m });
    } else if (hasMetadata(t)) {
      // A magnet without metadata has no file list to check — its name (tested
      // above) was the whole truth, so it is not pending anything.
      unchecked++;
    }
  }
  return { shown: shown, unchecked: unchecked };
}

// Why a torrent whose name says nothing is in the filtered list. Just a count:
// the files themselves get real rows in the "Matching files" list below, where
// they are readable — a filename crammed into this subtitle was the first thing
// ellipsis ate, and with several matches it named one and hid the rest.
function fileMatchNote(names) {
  return "matches " + (names.length === 1 ? "1 file" : names.length + " files");
}

// --- Metadata matching (the stream / download resolver) ----------------------
//
// The resolver answers "play/download THIS song" with a file out of a torrent,
// and a false positive plays the WRONG song — strictly worse than declining.
// So the matcher is built for precision: normalized token containment, a hard
// corroboration requirement (a title alone never clears the threshold; artist
// or album evidence must exist somewhere in the path, the torrent name, or the
// file's tags), and a duration veto when both sides know their length.

// Case-folded, diacritics-folded (Jóga == Joga), with release qualifiers
// stripped — "(Remastered 2015)" and "feat. …" say how a file was cut, not
// which song it is. Letters outside Latin (Greek, Cyrillic) are kept as-is:
// NFD only decomposes what has a decomposition.
function normalizeForMatch(s) {
  var out = String(s == null ? "" : s).toLowerCase();
  // Older webviews without String.normalize just skip the fold — the match
  // gets stricter, never wronger.
  if (typeof out.normalize === "function") {
    out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  out = out.replace(
    /[([][^)\]]*(remaster|deluxe|edition|version|mono|stereo|live|demo|bonus|anniversary|reissue|explicit|remix)[^)\]]*[)\]]/g,
    " "
  );
  out = out.replace(/\b(feat|ft|featuring)\.?\s.+$/g, " ");
  out = out.replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]+/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

// Every token of `needle`, as a whole word, somewhere in the normalized `hay`.
// Whole words so "One" doesn't hide inside "Someone".
function containsAllTokens(hayNorm, needle) {
  var n = normalizeForMatch(needle);
  if (!n) return false;
  var hay = " " + hayNorm + " ";
  var toks = n.split(" ");
  for (var i = 0; i < toks.length; i++) {
    if (hay.indexOf(" " + toks[i] + " ") === -1) return false;
  }
  return true;
}

var MATCH_THRESHOLD = 0.7;

// Score one file against the wanted track. `cand` = { fileName, torrentName,
// tags?: {title, artist, album}, durationSecs? }; `want` = { title, artist?,
// album?, durationSecs? }. Returns 0..1; only >= MATCH_THRESHOLD is a match.
function titleMatchScore(cand, want) {
  if (!want || !want.title) return 0;
  var base = normalizeForMatch(baseName((cand && cand.fileName) || ""));
  var path = normalizeForMatch((cand && cand.fileName) || "");
  var torrent = normalizeForMatch((cand && cand.torrentName) || "");
  var tags = (cand && cand.tags) || null;
  var tagTitle = tags ? normalizeForMatch(tags.title) : "";
  var tagArtist = tags ? normalizeForMatch(tags.artist) : "";
  var tagAlbum = tags ? normalizeForMatch(tags.album) : "";

  // Title evidence, best source first: an exact tag title, a contained tag
  // title, the filename.
  var wantTitleNorm = normalizeForMatch(want.title);
  var titleHit =
    tagTitle && tagTitle === wantTitleNorm
      ? 1
      : tagTitle && containsAllTokens(tagTitle, want.title)
        ? 0.9
        : containsAllTokens(base, want.title)
          ? 0.8
          : 0;
  if (!titleHit) return 0;

  // Corroboration: the artist or the album, ANYWHERE around the file.
  var artistEv =
    !!want.artist &&
    (containsAllTokens(path, want.artist) ||
      containsAllTokens(torrent, want.artist) ||
      (!!tagArtist && containsAllTokens(tagArtist, want.artist)));
  var albumEv =
    !!want.album &&
    (containsAllTokens(path, want.album) ||
      containsAllTokens(torrent, want.album) ||
      (!!tagAlbum && containsAllTokens(tagAlbum, want.album)));
  // Title alone caps at half its weight — deliberately below the threshold.
  if (!artistEv && !albumEv) return titleHit * 0.5;

  var score = titleHit * 0.7 + 0.2 + (artistEv && albumEv ? 0.05 : 0);

  // Duration: the one signal that can't be fooled by a name. Both known and
  // 30s apart = a different recording, whatever the words say.
  if (want.durationSecs > 0 && cand.durationSecs > 0) {
    var d = Math.abs(cand.durationSecs - want.durationSecs);
    if (d > 30) return 0;
    if (d <= 5) score += 0.1;
  }
  return Math.min(1, score);
}

// The tier-1/2 entry point: is the wanted track already inside ANY torrent?
// Scans the persistent name cache (namesByHash), scoring only audio/video
// files, and returns the best { hash, name, score } at or above the threshold
// — or null. The caller re-fetches that torrent's parsed file list to get the
// file's REAL index and progress; the position in the name cache is not
// trusted for that.
function findTrackInTorrents(want, torrentsMap, namesByHash) {
  var best = null;
  var byHash = namesByHash || {};
  for (var hash in byHash) {
    if (!Object.prototype.hasOwnProperty.call(byHash, hash)) continue;
    var t = (torrentsMap || {})[hash];
    if (!t) continue; // cache entry for a torrent the server no longer has
    var names = byHash[hash] || [];
    for (var i = 0; i < names.length; i++) {
      if (!mediaKindOf(names[i])) continue;
      var score = titleMatchScore({ fileName: names[i], torrentName: t.name || "" }, want);
      if (score < MATCH_THRESHOLD) continue;
      if (!best || score > best.score) best = { hash: hash, name: names[i], score: score };
    }
  }
  return best;
}

// A late tag read can settle a match for good — or expose it. "contradict"
// means the file SAYS what it is and it isn't the wanted song; "unknown" means
// the tags are silent and the name-based score stands.
function confirmByTags(tags, want) {
  if (!tags || !want) return "unknown";
  var tagTitle = normalizeForMatch(tags.title);
  if (!tagTitle) return "unknown";
  if (containsAllTokens(tagTitle, want.title) || containsAllTokens(normalizeForMatch(want.title), tags.title)) {
    return "confirm";
  }
  return "contradict";
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

// What a file row offers, and which of those a double-click fires.
//
// Each row offers only what it can actually do:
//
// A DOWNLOADED MEDIA file is the only one worth playing or queueing: the bytes
// are on disk and there is something to play. It gets neither Download (nothing
// left to fetch) nor Skip (that would only stop seeding a file the user already
// has, which is not what "skip" means anywhere else in this list).
//
// A downloaded NON-media file — the cover art, the .nfo, the scans folder that
// comes with every release — offers nothing at all. Play and Add to queue were
// being offered on it because the row asked only whether the file had finished:
// pressing them queued nothing and reported "nothing there that's finished
// downloading" about a file plainly listed as complete. Download and Skip are
// just as meaningless on it for the reason above.
//
// Anything unfinished is a choice about whether to fetch it, and Download and
// Skip are that choice in two directions — so a row offers the one it is not
// already in. That applies to media and junk alike: skipping a 4 GB video extra
// is a main reason to open this list.
//
// `action` is what a double-click fires. Named rather than left to the host
// fallback (which fires the first visible action), so it can never mean
// something the row did not put first on purpose — and it is null when the row
// offers nothing, rather than falling through to an action that isn't there.
function fileRowActions(kind, done, skipped, reachable) {
  // Downloaded wins, matching fileState(): a file with bytes on disk reads
  // "Downloaded", so its actions describe a file you HAVE. Priority no longer
  // matters once the bytes exist.
  if (done) {
    if (kind) return { actions: ["qbt:play-file", "qbt:enqueue-file"], action: "qbt:play-file" };
    // Non-media (cover art, .nfo, a PDF booklet): nothing to play, but the file
    // is really here — offer to open it or reveal its folder. Only when it is
    // on this machine; opening a path that isn't mounted here would just fail.
    return reachable
      ? { actions: ["qbt:file-open", "qbt:file-folder"], action: "qbt:file-open" }
      : { actions: [], action: null };
  }
  // Not downloaded: offer the choice it is not already in.
  return skipped
    ? { actions: ["qbt:file-download"], action: "qbt:file-download" }
    : { actions: ["qbt:file-skip"], action: "qbt:file-skip" };
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

// Is the category filter actually in force?
//
// A user may deliberately use no category at all — the setting says "leave it
// empty to tag nothing" — and with no name to match against there is nothing to
// filter by, so the view lists every torrent in qBittorrent whatever the "only
// manage my own category" switch says. That switch narrows the view TO a
// category; it cannot narrow it to no category.
//
// Spelled once because five places ask the question, and the one that spelled
// it for itself is the one that got it wrong: with the box cleared, the
// stranded-torrents banner announced that torrents were "hidden by the “”
// filter" while they sat in the list directly underneath it, and offered a
// button that would have stripped their category in qBittorrent.
function categoryFilterActive(restrict, cat) {
  return !!restrict && !!(cat && String(cat).trim());
}

// What to remember as the PREVIOUS category after a settings save.
//
// Renaming strands torrents under the old name — they vanish from a view that
// now filters on the new one, so the old name is kept to offer moving them.
// CLEARING the box is not a rename: nothing is filtered afterwards, so nothing
// is stranded and there is nothing to offer.
function nextPreviousCategory(outgoing, incoming, remembered) {
  if (!incoming) return "";
  if (outgoing && outgoing !== incoming) return outgoing;
  return remembered === incoming ? "" : remembered;
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
      // Torrents added while a list filter is active join the burst here —
      // and a reconnection resumes one the disconnect stalled.
      pumpNameBurst();
      // Remove leftovers of discovery jobs that never finished (plugin reload
      // or host crash mid-examine strands a paused torrent otherwise).
      sweepResolveOrphans();
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
    if (categoryFilterActive(restrictToCategory, category) && String(t.category || "") !== category) continue;
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
// `maxAttempts` lets a background caller give up sooner than the interactive
// default — a dead indexer link isn't worth 25 seconds of a resolve budget.
function waitForAddedTorrent(knownBefore, expectedHash, nameHint, attempt, maxAttempts) {
  var tries = attempt || 0;
  var cap = maxAttempts || ATTACH_ATTEMPTS;
  var hash = matchAddedTorrent(knownBefore, expectedHash, nameHint);
  if (hash) return Promise.resolve(hash);
  if (tries >= cap) return Promise.resolve(null);
  return delay(ATTACH_POLL_MS)
    .then(refresh)
    .then(function () {
      return waitForAddedTorrent(knownBefore, expectedHash, nameHint, tries + 1, cap);
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
  if (categoryFilterActive(restrictToCategory, category) && String((t && t.category) || "") !== category) {
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

// waitForMetadata for a torrent NO USER is looking at: same start-a-paused-
// magnet-to-fetch-metadata dance (metaDL moves no file data), but quiet — no
// pendingSelection gate, no notifications, no fetchFiles, no armPeek, no
// render. Resolves { ok, gone } so the caller can tell "timed out" from
// "someone removed it".
function waitForMetadataQuiet(hash, opts) {
  var maxMs = (opts && opts.maxMs) || METADATA_MAX_MS;
  var onTick = (opts && opts.onTick) || null;
  var step = function (elapsed, startedByUs) {
    return refresh().then(function () {
      var t = torrents[hash];
      if (!t) return { ok: false, gone: true };
      if (hasMetadata(t)) {
        // Put it back to stopped if we started it — nothing may download
        // before the caller has decided anything.
        var settle = startedByUs && !isPaused(t)
          ? postAction(stopEndpoint(), [hash], "Pausing after the file list arrived")
          : Promise.resolve();
        return settle.then(function () {
          return { ok: true, gone: false };
        });
      }
      if (elapsed >= maxMs) return { ok: false, gone: false };
      if (onTick) onTick(elapsed);
      var mustStart = isPaused(t) && !startedByUs;
      var kick = mustStart
        ? postAction(startEndpoint(), [hash], "Fetching the file list")
        : Promise.resolve();
      return kick
        .then(function () {
          return delay(METADATA_POLL_MS);
        })
        .then(function () {
          return step(elapsed + METADATA_POLL_MS, startedByUs || mustStart);
        });
    });
  };
  return step(0, false);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// The wire half of an add: build the form, POST it, and turn qBittorrent's
// "Fails." into a real error. No notifications, no tab change, no selection
// flow — the interactive addTorrent() and the metadata resolver both sit on
// top of this.
function addTorrentRaw(uri, opts) {
  var form = {
    urls: uri,
    // Sequential + first/last piece priority are what make a partially
    // downloaded file playable at all, which is the point of adding it here
    // rather than in qBittorrent's own UI.
    sequentialDownload: "true",
    firstLastPiecePrio: "true"
  };
  if (opts && opts.paused) {
    // Both spellings: 5.0 renamed paused -> stopped, and qBittorrent ignores a
    // form field it doesn't know, so this needs no version branch.
    form.paused = "true";
    form.stopped = "true";
  }
  if (category) form.category = category;
  if (opts && opts.downloader) form.downloader = opts.downloader;
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
      return null;
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
  if (holdForSelection) {
    preparingAdd = true;
    preparingElapsed = 0;
    render();
  }
  var knownBefore = holdForSelection ? shallowHashSet(torrents) : null;
  // The plain add verifies its own outcome, so it needs the same snapshot.
  var plainBefore = holdForSelection ? null : shallowHashSet(torrents);
  var expectedHash = holdForSelection ? magnetHash(uri) : null;

  return addTorrentRaw(uri, { paused: holdForSelection, downloader: downloader })
    .then(function () {
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

// The quiet wire half of actOn(): POST an action at a set of hashes and
// nothing else — no busy state, no notification, no refresh. Failures
// propagate to the caller. Background flows (the metadata resolver) use this
// so their housekeeping never flashes the list or talks over a working view.
function postAction(path, hashes, label) {
  var list = [].concat(hashes || []);
  if (!list.length) return Promise.resolve();
  return authed(path, { method: "POST", form: { hashes: list.join("|") } }).then(function (resp) {
    expectOk(resp, label);
  });
}

function actOn(path, hashes, label) {
  var list = [].concat(hashes || []);
  if (!list.length) return Promise.resolve();
  busy = list.length === 1 ? list[0] : "*";
  render();
  return postAction(path, list, label)
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

// The Search tab now has TWO sources under one spinner: qBittorrent's own
// search plugins, and the web indexer sweep. Each keeps its latest rows in a
// module var; the visible list is always the merged sort of both, and the
// spinner runs while EITHER is still working.
var lastQbtRows = [];
var webSearchRows = [];
var qbtSearchActive = false;
var webSearchActive = false;

function refreshSearchRunning() {
  searchRunning = qbtSearchActive || webSearchActive;
}

function mergeSearchRows() {
  searchResults = sortSearchResults(lastQbtRows.concat(webSearchRows));
}

function runSearch(query) {
  var q = String(query || "").trim();
  if (!q) return Promise.resolve();

  searchGen++;
  var gen = searchGen;
  var previousJob = searchJobId;

  searchQuery = q;
  searchError = null;
  searchResults = [];
  lastQbtRows = [];
  webSearchRows = [];
  searchJobId = null;
  searchStopped = false;
  activeTab = "search";

  var webDefs = enabledWebDefs();
  qbtSearchActive = true;
  webSearchActive = !!webDefs.length;
  refreshSearchRunning();
  render();

  if (webDefs.length) {
    webSearchAll(webDefs, q, webFetchFn).then(function (rows) {
      if (gen !== searchGen) return;
      webSearchRows = rows;
      webSearchActive = false;
      refreshSearchRunning();
      mergeSearchRows();
      render();
    });
  }

  // Drop the previous job before starting another; a user retyping a query
  // would otherwise leak one server-side job per attempt.
  return disposeSearch(previousJob)
    .then(function () {
      return searchPlugins === null ? loadSearchPlugins() : searchPlugins;
    })
    .then(function (plugins) {
      if (!plugins.length) {
        // With web indexers enabled the search runs on them alone; the
        // "install search plugins" banner only fires when NOTHING can search.
        if (!webDefs.length) throw new Error("no-plugins");
        qbtSearchActive = false;
        refreshSearchRunning();
        render();
        return null;
      }
      return authed("/search/start", {
        method: "POST",
        form: { pattern: q, plugins: "enabled", category: "all" }
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
        });
    })
    .catch(function (e) {
      if (gen !== searchGen) return null;
      qbtSearchActive = false;
      refreshSearchRunning();
      searchError = String(e && e.message) === "no-plugins" ? "no-plugins" : errText(e);
      if (searchError !== "no-plugins") console.error("qBittorrent: search failed:", e);
      render();
      return null;
    });
}

// One page of a search job's results — shared by the Search tab's poll loop
// and the headless collector below.
function readSearchResultsPage(id, limit) {
  return authed("/search/results?id=" + encodeURIComponent(id) + "&limit=" + limit).then(function (resp) {
    expectOk(resp, "Reading search results");
    return resp.json();
  });
}

function pollSearch(id, gen, elapsed) {
  if (gen !== searchGen) return Promise.resolve();
  return readSearchResultsPage(id, SEARCH_LIMIT)
    .then(function (data) {
      if (gen !== searchGen) return null;
      lastQbtRows = (data && data.results) || [];
      mergeSearchRows();
      var done = String((data && data.status) || "") !== "Running" || elapsed >= SEARCH_MAX_MS;
      if (done) {
        qbtSearchActive = false;
        refreshSearchRunning();
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
      qbtSearchActive = false;
      refreshSearchRunning();
      searchError = errText(e);
      render();
      return disposeSearch(id);
    });
}

// A headless search: start a job, poll it to completion, dispose of it, return
// the raw results. It owns its OWN job id and never touches searchGen /
// searchResults / searchRunning — qBittorrent supports concurrent search jobs,
// so the Search tab is unaffected even if the user runs a search mid-collect.
// Throws Error("no-plugins") exactly like runSearch when qBittorrent has no
// search plugins to ask.
var headlessSearchJobId = null; // disposed on deactivate, like the tab's job

function collectSearchResults(pattern, opts) {
  var q = String(pattern || "").trim();
  if (!q) return Promise.resolve([]);
  var maxMs = (opts && opts.maxMs) || SEARCH_MAX_MS;
  var onTick = (opts && opts.onTick) || null;
  var jobId = null;

  // The web indexer sweep runs in parallel with qBittorrent's own search
  // plugins — discovery, the Debug tab and interactive search all consume
  // this function, so websites join every one of those surfaces here.
  var webDefs = enabledWebDefs();
  var webJob = webDefs.length ? webSearchAll(webDefs, q, webFetchFn) : Promise.resolve([]);

  var run = (searchPlugins === null ? loadSearchPlugins() : Promise.resolve(searchPlugins))
    .then(function (plugins) {
      if (!plugins.length) {
        // Web indexers can carry the search alone; "no-plugins" is only true
        // when there is genuinely nowhere to ask.
        if (!webDefs.length) throw new Error("no-plugins");
        return [];
      }
      return authed("/search/start", {
        method: "POST",
        form: { pattern: q, plugins: "enabled", category: "all" }
      })
        .then(function (resp) {
          expectOk(resp, "Starting the search");
          return resp.json();
        })
        .then(function (job) {
          jobId = job && job.id;
          headlessSearchJobId = jobId;
          var step = function (elapsed) {
            return readSearchResultsPage(jobId, SEARCH_LIMIT).then(function (data) {
              var results = (data && data.results) || [];
              if (onTick) onTick(results.length, elapsed);
              if (String((data && data.status) || "") !== "Running" || elapsed >= maxMs) return results;
              return delay(SEARCH_POLL_MS).then(function () {
                return step(elapsed + SEARCH_POLL_MS);
              });
            });
          };
          return step(0);
        });
    });
  // Dispose on BOTH exits — a finished job holds server resources either way.
  var qbtJob = run.then(
    function (results) {
      if (headlessSearchJobId === jobId) headlessSearchJobId = null;
      return disposeSearch(jobId).then(function () {
        return results;
      });
    },
    function (e) {
      if (headlessSearchJobId === jobId) headlessSearchJobId = null;
      return disposeSearch(jobId).then(function () {
        // A broken qBittorrent search must not sink web results that DID
        // arrive — but with no web indexers there is nothing to save.
        if (!webDefs.length) throw e;
        console.error("qBittorrent: search-plugin side of the sweep failed:", e);
        return [];
      });
    }
  );
  return Promise.all([qbtJob, webJob]).then(function (parts) {
    return parts[0].concat(parts[1]);
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
  qbtSearchActive = false;
  webSearchActive = false; // the sweep's completion sees the new gen and drops
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
  // A magnet-follow web result carries its DETAIL page as fileUrl; the magnet
  // is fetched now, for the one row the user actually clicked.
  if (r.webFollow) {
    api.ui.showNotification("Fetching the magnet link from " + siteLabel(r.siteUrl) + "…");
    resolveWebFileUrl(r, webFetchFn)
      .then(function (resolved) {
        return addTorrent(resolved.fileUrl, { peek: !!(opts && opts.peek), name: resolved.fileName, downloader: downloaderFor(resolved) });
      })
      .catch(function (e) {
        console.error("qBittorrent: could not resolve the result's magnet link:", e);
        api.ui.showNotification("Couldn't get that torrent's magnet link: " + errText(e));
      });
    return;
  }
  addTorrent(r.fileUrl, { peek: !!(opts && opts.peek), name: r.fileName, downloader: downloaderFor(r) });
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
      rememberFileNames(hash, filesByHash[hash]);
      // Tags for this torrent's finished media, once, in the background. The
      // user is looking at this file list — reading the tags now is what makes
      // the ROWS say what the files are, not just the queue entries built from
      // them later. Never awaited: the list renders on the filenames and
      // corrects itself when the tags land.
      var torrent = torrents[hash];
      if (torrent) {
        readTagsForFiles(torrent, playableFiles(filesByHash[hash])).then(render);
      }
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
        // The one path that can observe an in-qBittorrent rename — refresh the
        // name cache too, or the list filter keeps searching the old names.
        rememberFileNames(hash, next);
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

// One torrent's parsed file list, quietly: no spinner, no notification, no
// filesByHash write (a background caller must not race the contents panel's
// own cache), failures propagated. Feeds the name cache as a side effect —
// examined torrents warm the cross-torrent search for free.
function fetchFilesQuiet(hash) {
  return authed("/torrents/files?hash=" + encodeURIComponent(hash))
    .then(function (resp) {
      expectOk(resp, "Reading the torrent's files");
      return resp.json();
    })
    .then(function (list) {
      var files = parseFileList(list);
      rememberFileNames(hash, files);
      return files;
    });
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

// File names per torrent, kept so the list filter can search INSIDE torrents.
// The count fetch above was already downloading every torrent's full file list
// and keeping only `.length` — this holds on to the names it was throwing away.
//
// Content-addressed and therefore PERSISTED: a hash IS its file list, so an
// entry can never go stale (an in-qBittorrent rename is the one exception, and
// refreshOpenFiles corrects the open torrent when it happens), and it stays
// valid across sessions and even across servers. With a thousand torrents,
// fetching each list once EVER instead of once per session is the difference
// between an instant search and a minute of filling in.
var fileNamesByHash = {};
var NAMES_STORAGE_KEY = "fileNames";
var namesPersistTimer = null;

function rememberFileNames(hash, files) {
  var list = files || [];
  // An empty list means "qBittorrent isn't ready to describe it", never a fact
  // about the torrent — same reasoning as the count's -1 marker below.
  if (!list.length) return;
  var names = [];
  for (var i = 0; i < list.length; i++) names.push(String(list[i].name || ""));
  fileNamesByHash[hash] = names;
  schedulePersistNames();
}

// Debounced: a burst can land hundreds of lists in under a minute, and writing
// the whole cache to storage after every one of them would be quadratic I/O.
function schedulePersistNames() {
  if (namesPersistTimer) return;
  namesPersistTimer = setTimeout(function () {
    namesPersistTimer = null;
    persistNames();
  }, 2000);
}

function persistNames() {
  // A stray debounce timer can outlive deactivate(); there is nowhere to write.
  if (!api) return Promise.resolve();
  // Prune entries for torrents the server no longer has — but only while
  // connected, when `torrents` is the full picture. `torrents` is unfiltered
  // maindata, so the category filter cannot make this drop live entries.
  if (connected) {
    var kept = {};
    for (var hash in fileNamesByHash) {
      if (!Object.prototype.hasOwnProperty.call(fileNamesByHash, hash)) continue;
      if (torrents[hash]) kept[hash] = fileNamesByHash[hash];
    }
    fileNamesByHash = kept;
  }
  return api.storage.set(NAMES_STORAGE_KEY, { byHash: fileNamesByHash }).catch(function (e) {
    console.error("qBittorrent: could not save the file-name cache:", e);
  });
}

function loadNamesCache() {
  return api.storage
    .get(NAMES_STORAGE_KEY)
    .then(function (saved) {
      var byHash = saved && saved.byHash;
      if (byHash && typeof byHash === "object") fileNamesByHash = byHash;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not read the file-name cache:", e);
    });
}

function fileCountOf(t) {
  if (!t) return null;
  var files = filesByHash[t.hash];
  if (files) return files.length;
  var names = fileNamesByHash[t.hash];
  if (names) return names.length;
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
    if (filesByHash[t.hash] || fileNamesByHash[t.hash] || fileCountByHash[t.hash] !== undefined || countInFlight[t.hash]) continue;
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
      rememberFileNames(hash, list);
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

// The trickle above (4 per ~2s poll) exists to decorate rows nobody asked
// about; it would take 8 minutes to cover a 1000-torrent list. When the user
// has TYPED into the list filter they are asking now, so the missing lists are
// fetched in a self-refilling burst instead — still bounded, because 1000
// sockets at once is a connection-pool stampede against a home server.
var BURST_LIMIT = 6;
var burstInFlight = 0;

function pumpNameBurst() {
  if (!connected || !String(listFilter).trim()) return;
  var list = visibleTorrents();
  for (var i = 0; i < list.length && burstInFlight < BURST_LIMIT; i++) {
    var t = list[i];
    if (filesByHash[t.hash] || fileNamesByHash[t.hash] || countInFlight[t.hash]) continue;
    // Respect the count fetch's "asked and it failed" marker — a burst that
    // retried every refused torrent on each keystroke would be the request
    // loop that marker exists to prevent.
    if (fileCountByHash[t.hash] === -1) continue;
    if (!hasMetadata(t)) continue;
    countInFlight[t.hash] = true;
    burstInFlight++;
    fetchFileCount(t.hash).then(function () {
      burstInFlight--;
      // Clearing the box cancels the burst here: the pump re-checks listFilter
      // before starting anything new, so at most BURST_LIMIT stragglers land.
      pumpNameBurst();
    });
  }
}

// Absolute path of one file on THIS machine, or null when it can't be known.
function localPathFor(torrent, file) {
  if (!torrent || !file) return null;
  var save = torrent.save_path || torrent.download_path || "";
  if (!save) return null;
  return applyPathMapping(joinRemotePath(save, file.name), pathMapFrom, pathMapTo);
}

// The directory an absolute path sits in — everything up to the last separator.
// Both separators, because a path mapping may hand back either style.
function parentDir(path) {
  var s = String(path || "");
  var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return cut > 0 ? s.substring(0, cut) : s;
}

// A local path as a file:// URL the OS opener understands. Windows paths get
// the extra slash (file:///C:/…) and back-slashes normalised; each segment is
// encoded so spaces and # in release names don't truncate the URL.
function fileUrlFor(path) {
  var s = String(path || "").replace(/\\/g, "/");
  // Windows drive path → file:///C:/…; a POSIX path keeps its leading slash,
  // which its empty first segment reproduces after the split, giving file:///…
  var prefix = /^[A-Za-z]:/.test(s) ? "file:///" : "file://";
  var parts = s.split("/");
  for (var i = 0; i < parts.length; i++) {
    // A drive letter (C:) must not have its colon encoded, and an empty
    // segment (the POSIX leading slash) encodes to nothing anyway.
    parts[i] = /^[A-Za-z]:$/.test(parts[i]) ? parts[i] : encodeURIComponent(parts[i]);
  }
  return prefix + parts.join("/");
}

// Open a non-media file, or reveal its folder, from a file row. `data` carries
// the row index; the file's local path comes from the same mapping playback
// uses, so a remote-but-mounted qBittorrent works too.
function openLocalFile(data, folder) {
  if (typeof api.network.openUrl !== "function") {
    api.ui.showNotification("This build can't open files");
    return;
  }
  var indices = rowIndices(data);
  if (!indices.length || !expandedHash) return;
  var torrent = torrents[expandedHash];
  var files = filesByHash[expandedHash] || [];
  var file = null;
  for (var i = 0; i < files.length; i++) {
    if (files[i].index === indices[0]) {
      file = files[i];
      break;
    }
  }
  var path = file && localPathFor(torrent, file);
  if (!path) {
    api.ui.showNotification("qBittorrent didn't report where this file is saved");
    return;
  }
  var target = folder ? parentDir(path) : path;
  api.network.openUrl(fileUrlFor(target)).catch(function (e) {
    console.error("qBittorrent: could not open " + (folder ? "the folder" : "the file") + ":", e);
    api.ui.showNotification("Couldn't open " + (folder ? "the folder" : "the file") + " — it may not be reachable from this machine");
  });
}

// Are this torrent's files reachable from here at all? Either qBittorrent is on
// this machine, or the user has told us where its download directory is mounted.
function filesAreReachable() {
  if (pathMapFrom && pathMapTo) return true;
  return isLikelyLocalHost(baseUrl);
}

// ---------------------------------------------------------------------------
// Embedded tags
//
// A filename is a guess; the file's own tags are the answer. `parseFileTrack`
// can only ever see "03 - Björk - Jóga.flac", so a release named by its track
// numbers alone reached the queue with no artist at all and the raw torrent name
// — "Radiohead - In Rainbows (2007) [FLAC 24-96]" — as its album.
//
// All of it is best-effort. A host too old to read tags, a seedbox whose files
// aren't reachable from here, and an untagged release all fall back to the
// filename parse, which is what this plugin shipped with.
// ---------------------------------------------------------------------------

// Absolute path -> tags object, or null for "asked, and there was nothing".
// Cached for the session because a file's tags cannot change under us — the
// bytes are written once — and the same file is re-queued often.
var tagsByPath = {};

function canReadTags() {
  return !!(api.system && typeof api.system.readAudioTags === "function");
}

function tagsFor(torrent, file) {
  var path = localPathFor(torrent, file);
  return (path && tagsByPath[path]) || null;
}

// Reads already in flight, keyed by path. Opening a torrent's contents starts a
// read for the whole list; pressing Play a second later asks for a subset of the
// same files, and without this both would probe them.
var tagsPending = {};

// Read tags for whichever of `files` we haven't asked about yet. Resolves when
// the cache is filled; the caller then builds tracks off it synchronously.
function readTagsForFiles(torrent, files) {
  // No host support, or the files aren't on this machine to be read.
  if (!canReadTags() || !filesAreReachable() || !torrent) return Promise.resolve();
  var list = files || [];
  var wanted = [];
  var waits = [];
  for (var i = 0; i < list.length; i++) {
    var path = localPathFor(torrent, list[i]);
    if (!path || Object.prototype.hasOwnProperty.call(tagsByPath, path)) continue;
    if (tagsPending[path]) waits.push(tagsPending[path]);
    else wanted.push(path);
  }
  if (wanted.length) {
    // One call for the whole set: the host probes on a worker thread, and a
    // call per file would be a round trip per file for one click.
    var job = api.system.readAudioTags(wanted)
      .then(function (results) {
        for (var j = 0; j < wanted.length; j++) {
          tagsByPath[wanted[j]] = (results && results[j]) || null;
        }
      })
      .catch(function (e) {
        // Never fatal — the filename parse is the fallback. Deliberately NOT
        // cached as a miss: a failure here is the host or the mount, not the
        // file, so the next play should be allowed to try again.
        console.error("qBittorrent: could not read tags for a torrent's files:", e);
      })
      .then(function () {
        for (var k = 0; k < wanted.length; k++) delete tagsPending[wanted[k]];
      });
    for (var m = 0; m < wanted.length; m++) tagsPending[wanted[m]] = job;
    waits.push(job);
  }
  return waits.length ? Promise.all(waits) : Promise.resolve();
}

// Tags win field by field, the filename parse fills the gaps. Per field, not
// all-or-nothing: a release tagged with an artist but no track number should
// still take its number off the "03 - " in front.
function mergeFileTrack(torrent, file, tags) {
  var parsed = parseFileTrack(file.name);
  var t = tags || {};
  return {
    path: qbtUri(torrent.hash, file.index),
    title: firstText([t.title, parsed.title]),
    // album_artist is the second choice, not the first: on a compilation it is
    // "Various Artists" while the per-track artist is the one worth showing.
    artist_name: firstText([t.artist, t.album_artist, parsed.artist]),
    album_title: firstText([t.album, torrent.name]),
    track_number: firstNum([t.track_number, parsed.trackNumber]),
    // Nothing supplied this before. A queue entry with no length shows no seek
    // bar and never scrobbles, and it comes free with the tag read.
    duration_secs: firstNum([t.duration_secs])
  };
}

function firstText(values) {
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNum(values) {
  for (var i = 0; i < values.length; i++) {
    var n = Number(values[i]);
    if (values[i] != null && isFinite(n) && n > 0) return n;
  }
  return null;
}

function trackForFile(torrent, file) {
  return mergeFileTrack(torrent, file, tagsFor(torrent, file));
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

// The files these row indices name, in the order they were given, skipping
// anything unfinished — same rule as the Play button, since a partial file stops
// partway and reads as corrupt.
// The files these row indices name, whatever they are — the raw selection, so a
// refusal can say which of the two reasons applies.
function selectedFiles(hash, indices) {
  var files = filesByHash[hash] || [];
  var byIndex = {};
  for (var i = 0; i < files.length; i++) byIndex[files[i].index] = files[i];
  var out = [];
  for (var j = 0; j < indices.length; j++) {
    var f = byIndex[indices[j]];
    if (f) out.push(f);
  }
  return out;
}

function filesForIndices(hash, indices) {
  var list = selectedFiles(hash, indices);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (Number(f.progress) >= 1 && mediaKindOf(f.name)) out.push(f);
  }
  return out;
}

// Why nothing in this selection can play. Both reasons used to be reported as
// "nothing there that's finished downloading", which is plainly wrong about a
// cover.jpg the same list shows as complete — and the row-level buttons no
// longer offer Play there at all, so anything reaching this came in through the
// toolbar, over a mixed selection.
function unplayableReason(selected) {
  var list = selected || [];
  if (!list.length) return "Nothing selected";
  var anyMedia = false;
  for (var i = 0; i < list.length; i++) {
    if (mediaKindOf(list[i].name)) { anyMedia = true; break; }
  }
  if (!anyMedia) {
    return list.length === 1
      ? "That isn't an audio or video file"
      : "None of those are audio or video files";
  }
  return list.length === 1
    ? "That file hasn't finished downloading yet"
    : "Nothing there that's finished downloading";
}

function tracksForIndices(hash, indices) {
  var torrent = torrents[hash];
  if (!torrent) return [];
  var files = filesForIndices(hash, indices);
  var tracks = [];
  for (var i = 0; i < files.length; i++) tracks.push(trackForFile(torrent, files[i]));
  return tracks;
}

// Fill the tag cache for the files these indices name, then build. Every queue
// path waits for this — the file list's own background read may not have landed
// yet, and metadata has to be settled when the entry is created: an entry that
// re-titled itself later would rewrite a list the user is already reading.
function tracksForIndicesTagged(hash, indices) {
  return readTagsForFiles(torrents[hash], filesForIndices(hash, indices))
    .then(function () { return tracksForIndices(hash, indices); });
}

function enqueueFiles(hash, indices) {
  return ensureFiles(hash).then(function () {
    return tracksForIndicesTagged(hash, indices);
  }).then(function (tracks) {
    if (!tracks.length) {
      api.ui.showNotification(unplayableReason(selectedFiles(hash, indices)));
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
    return readTagsForFiles(torrent, playable).then(function () {
      var tracks = [];
      var start = 0;
      for (var i = 0; i < playable.length; i++) {
        if (startIndex != null && playable[i].index === startIndex) start = i;
        tracks.push(trackForFile(torrent, playable[i]));
      }
      api.playback.playTracks(tracks, start, { name: torrent.name || "Torrent" });
    });
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
  if (categoryFilterActive(restrictToCategory, category)) label += " · category “" + category + "”";
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
function torrentRow(t, fileMatches) {
  var pending = needsChoice(t);
  var bits = [torrentStatusText(t, pending)];

  // Filtered in by its FILES, not its name. The explanation leads the subtitle:
  // with a filter active, "why is this row here" is the question being read,
  // and a note at the end of this long line would be the first thing ellipsis
  // eats.
  if (fileMatches && fileMatches.length) bits.unshift(fileMatchNote(fileMatches));

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

// The "Matching files" list under the filtered torrents: the files the search
// FOUND, as rows of their own. The torrent row can only say "matches 3 files";
// this is where the three are readable — basename as the title, folder and
// torrent underneath, the file's media glyph over the torrent's progress badge
// (per-file progress isn't in the name cache, and the torrent's is the honest
// approximation the badge colour already encodes).
//
// Capped twice. Per torrent, because "flac" matches an entire discography and
// forty rows of one release bury every other result — the "+N more" row stands
// in and opens the torrent like any other. And in total, because the renderer
// will happily draw 5000 rows and nobody will read them; the caller prints the
// remainder so truncation never masquerades as completeness.
var MATCH_ROWS_PER_TORRENT = 5;
var MATCH_ROWS_TOTAL = 100;

function fileMatchItems(entries) {
  var rows = [];
  var shown = 0; // matches with a row of their own (the "+N more" rows aren't)
  var total = 0; // every match found, shown or not
  // True only when the TOTAL cap cut something. The per-torrent cap leaves a
  // "+N more" row behind, so it needs no extra apology.
  var overflow = false;
  var all = entries || [];
  for (var i = 0; i < all.length; i++) {
    var t = all[i].torrent;
    var m = all[i].fileMatches || [];
    if (!m.length) continue;
    total += m.length;
    if (rows.length >= MATCH_ROWS_TOTAL) {
      overflow = true;
      continue;
    }
    var torrentName = t.name || magnetDisplayName(t.magnet_uri) || t.hash;
    var pending = needsChoice(t);
    var cap = Math.min(m.length, MATCH_ROWS_PER_TORRENT);
    for (var j = 0; j < cap; j++) {
      if (rows.length >= MATCH_ROWS_TOTAL) {
        overflow = true;
        break;
      }
      var folder = folderSegments(m[j]).join(" / ");
      rows.push({
        id: "qbtm:" + t.hash + ":" + j,
        title: baseName(m[j]),
        subtitle: (folder ? folder + "  ·  " : "") + "in “" + torrentName + "”",
        imageUrl: tileIcon(mediaKindOf(m[j]) || "unknown", pending ? "0%" : torrentPercent(t), progressBand(t, pending)),
        action: "qbt:open-match"
      });
      shown++;
    }
    if (m.length > cap) {
      if (rows.length < MATCH_ROWS_TOTAL) {
        rows.push({
          id: "qbtm:" + t.hash + ":more",
          title: "+" + (m.length - cap) + " more " + (m.length - cap === 1 ? "match" : "matches"),
          subtitle: "in “" + torrentName + "” — open it to see them all",
          imageUrl: torrentIconFor(t, pending),
          action: "qbt:open-match"
        });
      } else {
        // Matches left with no row at all — not even a "+N more" to stand in.
        overflow = true;
      }
    }
  }
  return { rows: rows, shown: shown, total: total, overflow: overflow };
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
      { id: "debug", label: "Debug" },
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

  if (activeTab === "debug") {
    var debugNodes = debugTabNodes();
    for (var dbi = 0; dbi < debugNodes.length; dbi++) children.push(debugNodes[dbi]);
    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children }, { scrollKey: "debug" });
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
  var stranded = categoryFilterActive(restrictToCategory, category) ? hashesInCategory(torrents, previousCategory) : [];
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

  // Also shown while the box holds text over an emptied list — hiding the
  // input WITH the last row would strand a filter nobody can clear.
  if (list.length || String(listFilter).trim()) {
    // Live filter, like the per-torrent files box: no button label, so the
    // host fires it on every keystroke.
    children.push({
      type: "search-input",
      placeholder: "Filter torrents — names and the files inside them",
      action: "qbt:list-filter",
      value: listFilter,
      stateKey: "qbt-list-filter"
    });
  }

  var filtered = filterTorrentList(list, listFilter, fileNamesByHash);

  // A search over a cold cache: some torrents genuinely cannot answer yet.
  // Said out loud, or "no matches" below would be a verdict the plugin doesn't
  // have — the burst is filling these in and each landing re-renders.
  if (String(listFilter).trim() && filtered.unchecked) {
    children.push({
      type: "text",
      className: "muted",
      content:
        "Searching inside torrents — " +
        filtered.unchecked +
        (filtered.unchecked === 1 ? " torrent" : " torrents") +
        " still to check…"
    });
  }

  if (!list.length) {
    children.push({
      type: "text",
      content: connected
        ? categoryFilterActive(restrictToCategory, category)
          ? "No torrents in the “" + category + "” category yet. Paste a magnet link above, or turn off “Only manage my own category” in settings to see everything."
          : "No torrents yet. Paste a magnet link or .torrent URL above."
        : "Not connected to qBittorrent."
    });
  } else if (!filtered.shown.length) {
    // Only a verdict once everything HAS been checked; before that the
    // "still to check" line above is the honest state of the search.
    if (!filtered.unchecked) {
      children.push({ type: "text", className: "muted", content: "Nothing matches “" + listFilter + "”." });
      children.push({
        type: "button",
        label: "Clear the filter",
        action: "qbt:list-filter-clear",
        variant: "secondary"
      });
    }
  } else {
    var rows = [];
    for (var i = 0; i < filtered.shown.length; i++) {
      rows.push(torrentRow(filtered.shown[i].torrent, filtered.shown[i].fileMatches));
    }
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

  // The files the filter FOUND, as rows of their own under the torrents. The
  // torrent rows above only count their matches; this is where a match is
  // readable, and clicking one opens its torrent narrowed to the matching
  // files. Not selectable: the toolbar above acts on torrents, and a second
  // selection scope under the same toolbar would make "Stop all" ambiguous.
  var matches = fileMatchItems(filtered.shown);
  if (matches.rows.length) {
    children.push({
      type: "text",
      content: "Matching files (" + matches.total + ")",
      className: "muted"
    });
    children.push({ type: "track-row-list", items: matches.rows });
    if (matches.overflow) {
      children.push({
        type: "text",
        className: "muted",
        content:
          "Only the first " + matches.shown + " are listed here — narrow the search, or open a torrent to see its matches."
      });
    }
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
      chooseFilesFirst: chooseFilesFirst,
      autoFetchFound: autoFetchFound,
      discoveryEnabled: discoveryEnabled,
      tier3Disposition: tier3Disposition
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
            // State-aware, because with the box above empty this switch does
            // nothing at all: there is no name to match, so the view lists
            // everything either way. A description that still promised "only
            // ever touch torrents in the category above" described a filter
            // that wasn't running.
            description: d.category
              ? "On (recommended): the Torrents view and its Start all / Stop all buttons only ever touch torrents in the “" + d.category + "” category. Off: everything in qBittorrent is listed and bulk actions reach all of it."
              : "No category set above, so there is nothing to restrict — every torrent in qBittorrent is listed and bulk actions reach all of it. Name a category above to use this.",
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
            label: "Fetch found tracks automatically",
            description:
              "When a track you play matches a file one of your torrents holds but hasn't downloaded, start that file " +
              "downloading. The play itself falls through to the next source — the torrent serves it once it's here.",
            control: { type: "toggle", label: "", action: "qbt:set-auto-fetch", checked: !!d.autoFetchFound }
          },
          {
            type: "settings-row",
            label: "Search torrents for downloads",
            description:
              "When you download a track no existing torrent has, search qBittorrent's search plugins for a torrent that " +
              "does, pick the best-fitting release, and download just that file. Torrents examined and rejected are removed automatically.",
            control: { type: "toggle", label: "", action: "qbt:set-discovery", checked: !!d.discoveryEnabled }
          },
          {
            type: "settings-row",
            label: "After a searched download finishes",
            description:
              "What happens to the torrent that delivered the track. Keeping it seeding is the safe default — it protects " +
              "private-tracker ratios, and the rest of that release becomes instantly playable.",
            control: {
              type: "select",
              label: "",
              action: "qbt:set-disposition",
              value: d.tier3Disposition || "seed",
              options: [
                { value: "seed", label: "Keep it seeding" },
                { value: "import", label: "Import the files, remove the torrent" },
                { value: "remove", label: "Remove the torrent, keep the file" }
              ]
            }
          }
        ]
          .concat(webIndexerSettingsRows())
          .concat([
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
        ])
      }
    ]
  };
}

// The Web indexers block: one toggle per definition (bundled + pasted), with a
// session health note, and the paste box for adding definitions. Rendered as
// data because the def list is data — a pasted def gets its row on the next
// render with no code involved.
function webIndexerSettingsRows() {
  var rows = [];
  var all = WEB_DEFS.concat(customIndexers);
  for (var i = 0; i < all.length; i++) {
    var def = all[i];
    var stat = webIndexerStats[def.id];
    var health = stat
      ? stat.ok + " ok · " + stat.fail + " failed" + (stat.lastError ? " (" + stat.lastError + ")" : "")
      : "not asked yet this session";
    var custom = i >= WEB_DEFS.length;
    rows.push({
      type: "settings-row",
      label: "Search " + def.name,
      description:
        siteLabel(def.siteUrl) + " · searched directly, no qBittorrent search plugin needed · " + health + (custom ? " · added by you" : ""),
      control: { type: "toggle", label: "", action: "qbt:webidx-" + def.id, checked: !webIndexersDisabled[def.id] }
    });
    rows.push({
      type: "settings-row",
      label: "",
      description: custom ? "Show this definition's JSON below, or remove it." : "Show this definition's JSON below (copy it as a starting point for your own).",
      control: {
        type: "layout",
        direction: "horizontal",
        children: [{ type: "button", label: "View JSON", action: "qbt:webview-" + def.id, variant: "secondary" }].concat(
          custom ? [{ type: "button", label: "Remove", action: "qbt:webdel-" + def.id, variant: "secondary" }] : []
        )
      }
    });
  }
  rows.push({
    type: "settings-row",
    label: "Add or import web indexers",
    description:
      "Paste one indexer definition, or a JSON array of them, and press Add — importing several at once works. " +
      "“View JSON” above fills this box with an existing definition to copy or tweak, and “Export all” fills it with every " +
      "indexer as an array. A definition says how to search one site; see the plugin's README for the format.",
    control: { type: "text-input", placeholder: "{ \"id\": \"mysite\", … }  or  [ {…}, {…} ]", action: "qbt:web-draft", value: webIndexerDraft, multiline: true, rows: 6 }
  });
  rows.push({
    type: "settings-row",
    label: "",
    description: "",
    control: {
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "Add / import", action: "qbt:web-add", variant: "accent" },
        { type: "button", label: "Export all", action: "qbt:web-export", variant: "secondary" },
        { type: "button", label: "Clear box", action: "qbt:web-clear", variant: "secondary" }
      ]
    }
  });
  return rows;
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
      autoFetchFound = s.autoFetchFound !== false;
      discoveryEnabled = s.discoveryEnabled !== false;
      tier3Disposition = s.tier3Disposition === "import" || s.tier3Disposition === "remove" ? s.tier3Disposition : "seed";
      webIndexersDisabled = s.webIndexersDisabled || {};
      customIndexers = s.customIndexers || [];
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
      autoFetchFound: autoFetchFound,
      discoveryEnabled: discoveryEnabled,
      tier3Disposition: tier3Disposition,
      webIndexersDisabled: webIndexersDisabled,
      customIndexers: customIndexers,
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
  previousCategory = nextPreviousCategory(outgoingCategory, category, previousCategory);
  restrictToCategory = !!d.restrictToCategory;
  insecure = !!d.insecure;
  pollMs = clampPoll(d.pollMs);
  pathMapFrom = (d.pathMapFrom || "").trim();
  pathMapTo = (d.pathMapTo || "").trim();
  destCollectionId = d.destCollectionId == null ? "" : String(d.destCollectionId);
  autoImport = !!d.autoImport;
  chooseFilesFirst = !!d.chooseFilesFirst;
  autoFetchFound = !!d.autoFetchFound;
  discoveryEnabled = !!d.discoveryEnabled;
  tier3Disposition = d.tier3Disposition === "import" || d.tier3Disposition === "remove" ? d.tier3Disposition : "seed";

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

// Open one torrent's contents — the shared tail of clicking a torrent row and
// clicking a row in the "Matching files" list.
//
// Arriving from a list filter that matched this torrent's FILES: open the
// contents already narrowed to them — the torrent row's "matches N files" note
// and the match rows both promise exactly that. Only when the torrent's own
// name did NOT match (a name match means the user wants the torrent, not three
// files of it), and only when they have never typed a files filter for this
// torrent — the host input's stateKey memory would replay their text over
// ours, leaving the box and the list disagreeing.
function openTorrentContents(hash) {
  expandedHash = hash;
  var q = String(listFilter).trim();
  if (q && fileFilters[hash] === undefined) {
    var t = torrents[hash];
    var names = fileNamesByHash[hash];
    if (t && names && !matchesFilter(t.name || "", q) && matchingNames(names, q).length) {
      fileFilters[hash] = q;
    }
  }
  render();
  ensureFiles(hash);
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
// ---------------------------------------------------------------------------
// Web indexers — search torrent WEBSITES directly (Jackett-inspired)
//
// The idea borrowed from Jackett is indexers as DATA, not code: a JSON
// definition per site says how to build the search URL and how to read rows
// out of the response (JSON path, RSS tags, or CSS selectors over HTML).
// Adding a site is pasting a definition in settings, never a plugin release.
//
// The sandbox has no DOM — `document` is shadowed and DOMParser is off the
// sandbox contract — so HTML is parsed by the small tolerant parser below.
// It is NOT a browser parser and says so: no adoption agency (misnested
// <b><i></b></i>), no table foster-parenting, no <template>, no SVG/MathML
// foreign-content rules, no encodings beyond what the host already decoded.
// Tracker result tables don't need any of that; the auto-close rules cover
// the tag soup they actually serve.
// ---------------------------------------------------------------------------

// --- Markup parser ------------------------------------------------------------

var VOID_ELEMENTS = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
  link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
};
// Content is text until the matching close tag — a script containing the
// string "</table>" must not close the table.
var RAW_TEXT_ELEMENTS = { script: 1, style: 1, textarea: 1, title: 1 };
// Opening the KEY implicitly closes an open VALUE at the top of the stack,
// repeatedly. This is the whole tag-soup story for result tables: trackers
// routinely omit </td>, </tr> and </li>.
var AUTO_CLOSE = {
  li: { li: 1, p: 1 },
  p: { p: 1 },
  div: { p: 1 },
  table: { p: 1 },
  ul: { p: 1 },
  ol: { p: 1 },
  tr: { td: 1, th: 1, tr: 1 },
  td: { td: 1, th: 1 },
  th: { td: 1, th: 1 },
  thead: { td: 1, th: 1, tr: 1, tbody: 1, tfoot: 1, thead: 1 },
  tbody: { td: 1, th: 1, tr: 1, thead: 1, tfoot: 1, tbody: 1 },
  tfoot: { td: 1, th: 1, tr: 1, thead: 1, tbody: 1, tfoot: 1 },
  option: { option: 1 }
};

var NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(s) {
  var str = String(s == null ? "" : s);
  if (str.indexOf("&") === -1) return str;
  return str.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (whole, body) {
    if (body.charAt(0) === "#") {
      var hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      var code = parseInt(body.substring(hex ? 2 : 1), hex ? 16 : 10);
      // No surrogate pairs — an astral emoji entity in a torrent name
      // degrades to the raw entity text, which is fine.
      return isFinite(code) && code > 0 && code < 0xffff ? String.fromCharCode(code) : whole;
    }
    var lower = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole;
  });
}

// Parse HTML (htmlMode) or XML/RSS (!htmlMode) into a tree of
// { tag, attrs, children, parent } elements and { text, parent } text nodes.
// `parent` pointers exist for the selector combinators — a node is NOT
// JSON-serializable.
function parseMarkup(text, htmlMode) {
  var src = String(text == null ? "" : text);
  var root = { tag: "#root", attrs: {}, children: [], parent: null };
  var stack = [root];
  var i = 0;
  var n = src.length;

  var top = function () {
    return stack[stack.length - 1];
  };
  var addText = function (raw, skipDecode) {
    if (!raw) return;
    top().children.push({ text: skipDecode ? raw : decodeEntities(raw), parent: top() });
  };

  while (i < n) {
    var lt = src.indexOf("<", i);
    if (lt === -1) {
      addText(src.substring(i));
      break;
    }
    if (lt > i) addText(src.substring(i, lt));

    if (src.substr(lt, 4) === "<!--") {
      var endComment = src.indexOf("-->", lt + 4);
      i = endComment === -1 ? n : endComment + 3;
      continue;
    }
    if (src.substr(lt, 9) === "<![CDATA[") {
      var endCdata = src.indexOf("]]>", lt + 9);
      addText(src.substring(lt + 9, endCdata === -1 ? n : endCdata), true);
      i = endCdata === -1 ? n : endCdata + 3;
      continue;
    }
    var next = src.charAt(lt + 1);
    if (next === "!" || next === "?") {
      var endDecl = src.indexOf(">", lt + 1);
      i = endDecl === -1 ? n : endDecl + 1;
      continue;
    }
    if (next === "/") {
      var endClose = src.indexOf(">", lt + 2);
      var closeName = src
        .substring(lt + 2, endClose === -1 ? n : endClose)
        .replace(/[\s/].*$/, "")
        .toLowerCase();
      if (closeName) {
        // Pop to the nearest matching open tag anywhere in the stack (closing
        // everything in between); a close nothing opened is ignored.
        for (var s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tag === closeName) {
            stack.length = s;
            break;
          }
        }
      }
      i = endClose === -1 ? n : endClose + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      // A bare "<" in text ("<3 seeders") is text, not markup.
      addText("<");
      i = lt + 1;
      continue;
    }

    // Opening tag: name, then attributes in their quoting variants.
    var j = lt + 1;
    while (j < n && /[^\s/>]/.test(src.charAt(j))) j++;
    var tag = src.substring(lt + 1, j).toLowerCase();
    var attrs = {};
    var selfClosed = false;
    while (j < n) {
      while (j < n && /\s/.test(src.charAt(j))) j++;
      var ch = src.charAt(j);
      if (ch === ">") {
        j++;
        break;
      }
      if (ch === "/") {
        if (src.charAt(j + 1) === ">") {
          selfClosed = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      if (j >= n) break;
      var nameStart = j;
      while (j < n && /[^\s=/>]/.test(src.charAt(j))) j++;
      var attrName = src.substring(nameStart, j).toLowerCase();
      while (j < n && /\s/.test(src.charAt(j))) j++;
      var attrValue = "";
      if (src.charAt(j) === "=") {
        j++;
        while (j < n && /\s/.test(src.charAt(j))) j++;
        var quote = src.charAt(j);
        if (quote === "\"" || quote === "'") {
          var endQuote = src.indexOf(quote, j + 1);
          attrValue = src.substring(j + 1, endQuote === -1 ? n : endQuote);
          j = endQuote === -1 ? n : endQuote + 1;
        } else {
          var valueStart = j;
          while (j < n && /[^\s>]/.test(src.charAt(j))) j++;
          attrValue = src.substring(valueStart, j);
        }
      }
      if (attrName) attrs[attrName] = decodeEntities(attrValue);
    }
    i = j;

    if (htmlMode) {
      var closes = AUTO_CLOSE[tag];
      while (closes && stack.length > 1 && closes[top().tag]) stack.pop();
    }
    var el = { tag: tag, attrs: attrs, children: [], parent: top() };
    top().children.push(el);
    var isVoid = htmlMode && VOID_ELEMENTS[tag];
    if (!selfClosed && !isVoid) stack.push(el);

    if (htmlMode && RAW_TEXT_ELEMENTS[tag] && !selfClosed) {
      var closeRe = new RegExp("</" + tag + "[\\s>]", "i");
      var match = closeRe.exec(src.substring(i));
      var rawEnd = match ? i + match.index : n;
      if (rawEnd > i) el.children.push({ text: src.substring(i, rawEnd), parent: el });
      if (match) {
        var gt = src.indexOf(">", rawEnd);
        i = gt === -1 ? n : gt + 1;
      } else {
        i = n;
      }
      stack.pop();
    }
  }
  return root;
}

// Concatenated descendant text, whitespace collapsed. What "the cell says".
function nodeText(node) {
  if (!node) return "";
  if (node.text !== undefined) return String(node.text).replace(/\s+/g, " ").trim();
  var out = [];
  var walk = function (nd) {
    var kids = nd.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].text !== undefined) out.push(kids[i].text);
      else walk(kids[i]);
    }
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

// --- Selector engine ------------------------------------------------------------
//
// The supported subset, chosen by what the bundled definitions need and
// nothing more: tag, .class, #id, [attr], [attr=v], [attr^=v], [attr*=v],
// compounds, descendant (space), child (>), :nth-child(n). Anything else is
// an ERROR, not a silent mismatch — the parser doubles as the definition
// validator, so a user pasting ":not(...)" is told exactly what isn't
// supported.

function parseSelector(sel) {
  var s = String(sel == null ? "" : sel).trim();
  if (!s) return { error: "empty selector" };
  var steps = [];
  var i = 0;
  var n = s.length;
  var pendingComb = " ";
  while (i < n) {
    var step = { combinator: pendingComb, tag: "", id: "", classes: [], attrs: [], nth: 0 };
    var compoundStart = i;
    var tagStart = i;
    // No ":" in tag names — a namespaced RSS tag (nyaa:seeders) is reached via
    // childByTag(), never a selector, and letting ":" into the name here would
    // silently swallow ":nth-child" and every unsupported pseudo.
    while (i < n && /[a-zA-Z0-9_*-]/.test(s.charAt(i))) i++;
    if (i > tagStart) {
      var tagName = s.substring(tagStart, i);
      if (tagName !== "*") step.tag = tagName.toLowerCase();
    }
    var simpleLoop = true;
    while (simpleLoop && i < n) {
      var ch = s.charAt(i);
      if (ch === ".") {
        i++;
        var classStart = i;
        while (i < n && /[a-zA-Z0-9_-]/.test(s.charAt(i))) i++;
        if (i === classStart) return { error: "empty class name in “" + sel + "”" };
        step.classes.push(s.substring(classStart, i));
      } else if (ch === "#") {
        i++;
        var idStart = i;
        while (i < n && /[a-zA-Z0-9_-]/.test(s.charAt(i))) i++;
        if (i === idStart) return { error: "empty id in “" + sel + "”" };
        step.id = s.substring(idStart, i);
      } else if (ch === "[") {
        var closeBracket = s.indexOf("]", i);
        if (closeBracket === -1) return { error: "unclosed [ in “" + sel + "”" };
        var body = s.substring(i + 1, closeBracket);
        i = closeBracket + 1;
        var attrMatch = /^([a-zA-Z0-9_:-]+)\s*(?:([\^*]?=)\s*(.*))?$/.exec(body);
        if (!attrMatch) return { error: "unsupported attribute selector “[" + body + "]” in “" + sel + "”" };
        var rawValue = attrMatch[3] === undefined ? null : attrMatch[3].replace(/^["']/, "").replace(/["']$/, "");
        step.attrs.push({ name: attrMatch[1].toLowerCase(), op: attrMatch[2] || "", value: rawValue });
      } else if (ch === ":") {
        var nthMatch = /^:nth-child\((\d+)\)/.exec(s.substring(i));
        if (!nthMatch) return { error: "unsupported selector feature “" + s.substring(i, i + 12) + "…” in “" + sel + "”" };
        step.nth = parseInt(nthMatch[1], 10);
        i += nthMatch[0].length;
      } else if (ch === "," || ch === "+" || ch === "~") {
        return { error: "unsupported selector feature “" + ch + "” in “" + sel + "”" };
      } else {
        simpleLoop = false;
      }
    }
    if (i === compoundStart) return { error: "could not parse “" + sel + "”" };
    steps.push(step);
    // Between compounds: whitespace = descendant, ">" = child.
    var sawWs = false;
    while (i < n && /\s/.test(s.charAt(i))) {
      i++;
      sawWs = true;
    }
    if (i < n && s.charAt(i) === ">") {
      pendingComb = ">";
      i++;
      while (i < n && /\s/.test(s.charAt(i))) i++;
    } else if (sawWs) {
      pendingComb = " ";
    } else if (i < n) {
      return { error: "could not parse “" + sel + "” near “" + s.substring(i, i + 8) + "”" };
    }
  }
  if (!steps.length) return { error: "empty selector" };
  return { steps: steps };
}

function matchesStep(el, step) {
  if (!el || el.text !== undefined || el.tag === "#root") return false;
  if (step.tag && el.tag !== step.tag) return false;
  if (step.id && el.attrs.id !== step.id) return false;
  for (var c = 0; c < step.classes.length; c++) {
    var classes = " " + (el.attrs["class"] || "") + " ";
    if (classes.indexOf(" " + step.classes[c] + " ") === -1) return false;
  }
  for (var a = 0; a < step.attrs.length; a++) {
    var spec = step.attrs[a];
    var val = el.attrs[spec.name];
    if (val === undefined) return false;
    if (spec.value !== null) {
      if (spec.op === "=" && val !== spec.value) return false;
      if (spec.op === "^=" && val.indexOf(spec.value) !== 0) return false;
      if (spec.op === "*=" && val.indexOf(spec.value) === -1) return false;
    }
  }
  if (step.nth) {
    var parent = el.parent;
    if (!parent) return false;
    var position = 0;
    var kids = parent.children;
    for (var k = 0; k < kids.length; k++) {
      if (kids[k].text !== undefined) continue;
      position++;
      if (kids[k] === el) break;
    }
    if (position !== step.nth) return false;
  }
  return true;
}

// Verify the left part of the chain for an element that matched the rightmost
// compound. Descendant combinators backtrack up the ancestor list.
function matchesChain(el, steps, stepIdx) {
  if (stepIdx === 0) return true;
  var prev = steps[stepIdx - 1];
  if (steps[stepIdx].combinator === ">") {
    var parent = el.parent;
    return !!(parent && matchesStep(parent, prev) && matchesChain(parent, steps, stepIdx - 1));
  }
  var anc = el.parent;
  while (anc) {
    if (matchesStep(anc, prev) && matchesChain(anc, steps, stepIdx - 1)) return true;
    anc = anc.parent;
  }
  return false;
}

function selectAll(root, selector) {
  var parsed = typeof selector === "string" ? parseSelector(selector) : selector;
  if (!parsed || parsed.error || !root) return [];
  var steps = parsed.steps;
  var last = steps.length - 1;
  var out = [];
  var walk = function (node) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.text !== undefined) continue;
      if (matchesStep(el, steps[last]) && matchesChain(el, steps, last)) out.push(el);
      walk(el);
    }
  };
  walk(root);
  return out;
}

function selectFirst(root, selector) {
  var all = selectAll(root, selector);
  return all.length ? all[0] : null;
}

// First DIRECT child element with this tag name — the RSS field accessor
// (handles namespaced names like "nyaa:seeders", which selectors refuse).
function childByTag(el, tagName) {
  var name = String(tagName || "").toLowerCase();
  var kids = (el && el.children) || [];
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].text === undefined && kids[i].tag === name) return kids[i];
  }
  return null;
}

// --- Value filters ------------------------------------------------------------

// "1.4 GB" / "1,4 Go" / "1.234,5 MB" / "1,234.5 MiB" → bytes. The LAST of
// "."/"," present is the decimal separator; the other is thousands noise.
// KB/KiB/Ko variants are used interchangeably by indexers, so everything is
// 1024-based — the value only feeds display and sorting.
function parseSize(s) {
  var str = String(s == null ? "" : s).replace(/\u00a0/g, " ").trim();
  var m = /^([\d.,\s]+?)\s*([kmgt]?i?[bo])\b/i.exec(str);
  var numPart;
  var unitChar;
  if (m) {
    numPart = m[1];
    unitChar = m[2].toLowerCase().charAt(0);
  } else if (/^[\d.,\s]+$/.test(str) && str.length) {
    numPart = str;
    unitChar = "b";
  } else {
    return null;
  }
  var num = numPart.replace(/\s+/g, "");
  var lastDot = num.lastIndexOf(".");
  var lastComma = num.lastIndexOf(",");
  if (lastDot > lastComma) num = num.replace(/,/g, "");
  else if (lastComma > -1) num = num.replace(/\./g, "").replace(",", ".");
  var value = parseFloat(num);
  if (!isFinite(value) || value < 0) return null;
  var mult =
    unitChar === "k" ? 1024
      : unitChar === "m" ? 1048576
        : unitChar === "g" ? 1073741824
          : unitChar === "t" ? 1099511627776
            : 1;
  return Math.round(value * mult);
}

var KNOWN_FILTERS = { trim: 1, regex: 2, parseSize: 1, parseInt: 1, prepend: 2, append: 2, querystring: 2, replace: 3 };

function applyFilters(value, filters) {
  var v = value == null ? "" : value;
  var list = filters || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var name = f && f[0];
    if (name === "trim") v = String(v).trim();
    else if (name === "regex") {
      var rm = new RegExp(f[1]).exec(String(v));
      v = rm ? (rm[1] !== undefined ? rm[1] : rm[0]) : "";
    } else if (name === "parseSize") v = parseSize(v);
    else if (name === "parseInt") {
      var cleaned = String(v)
        .replace(/[\s\u00a0]/g, "")
        .replace(/[.,](?=\d{3}(\D|$))/g, "");
      var parsed = parseInt(cleaned, 10);
      v = isNaN(parsed) ? null : parsed;
    } else if (name === "prepend") v = String(f[1]) + String(v);
    else if (name === "append") v = String(v) + String(f[1]);
    else if (name === "querystring") {
      var escaped = String(f[1]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var qm = new RegExp("[?&]" + escaped + "=([^&#]*)").exec(String(v));
      v = qm ? decodeURIComponent(qm[1].replace(/\+/g, " ")) : "";
    } else if (name === "replace") v = String(v).split(String(f[1])).join(String(f[2]));
    // Unknown names are rejected by validateIndexerDef; at runtime they are
    // skipped so one bad custom def degrades instead of throwing mid-sweep.
  }
  return v;
}

// --- Indexer definitions & engine ----------------------------------------------

var WEB_TIMEOUT_MS = 10000;
var WEB_MIN_GAP_MS = 2500;
var WEB_GAP_JITTER_MS = 500;
var WEB_DEF_ROW_CAP = 50;
var WEB_TOTAL_ROW_CAP = 150;

// Dot-path into a JSON value; "" is the value itself. Deliberately tiny — no
// wildcards, no arrays-in-the-middle; nothing the bundled defs need.
function jsonPath(value, path) {
  var p = String(path == null ? "" : path);
  if (!p) return value;
  var parts = p.split(".");
  var v = value;
  for (var i = 0; i < parts.length; i++) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[parts[i]];
  }
  return v;
}

function buildSearchUrl(def, query) {
  return String(def.search.url).replace("{q}", encodeURIComponent(String(query == null ? "" : query)));
}

// magnet:?xt=urn:btih:… from a JSON row. Returns null for anything that is
// not a real 40-hex hash — apibay answers an EMPTY search with one sentinel
// row whose hash is all zeros, and without this rule every empty TPB search
// would produce a fake addable result.
function buildMagnet(infoHash, name, trackers) {
  var hash = String(infoHash == null ? "" : infoHash).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  if (/^0{40}$/.test(hash)) return null;
  var out = "magnet:?xt=urn:btih:" + hash;
  if (name) out += "&dn=" + encodeURIComponent(String(name));
  var list = trackers || [];
  for (var i = 0; i < list.length; i++) out += "&tr=" + encodeURIComponent(String(list[i]));
  return out;
}

// Extract one field from one row per the def type. Returns the raw string
// (before filters); "" when the source finds nothing.
function extractField(spec, row, defType) {
  if (defType === "json") {
    var v = jsonPath(row, spec.path);
    return v == null ? "" : String(v);
  }
  if (defType === "rss") {
    var child = childByTag(row, spec.tag);
    return child ? nodeText(child) : "";
  }
  var el = spec.selector ? selectFirst(row, spec.selector) : row;
  if (!el) return "";
  if (spec.attribute) {
    var attr = el.attrs && el.attrs[String(spec.attribute).toLowerCase()];
    return attr == null ? "" : attr;
  }
  return nodeText(el);
}

// Run one definition against a RESPONSE BODY — pure, no network, which is what
// makes every bundled def testable against a saved fixture. Returns result
// rows in the plugin's standard search shape.
function runDefOnBody(def, bodyText) {
  var rows;
  if (def.type === "json") {
    var parsed = JSON.parse(bodyText);
    var arr = jsonPath(parsed, (def.rows && def.rows.path) || "");
    rows = Object.prototype.toString.call(arr) === "[object Array]" ? arr : [];
  } else if (def.type === "rss") {
    rows = selectAll(parseMarkup(bodyText, false), (def.rows && def.rows.tag) || "item");
  } else {
    rows = selectAll(parseMarkup(bodyText, true), def.rows.selector);
  }
  var cap = Math.min(rows.length, def.limit || WEB_DEF_ROW_CAP);
  var out = [];
  for (var i = 0; i < cap; i++) {
    var mapped = mapDefRow(def, rows[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapDefRow(def, row) {
  var fields = def.fields || {};
  var result = { siteUrl: def.siteUrl, engineName: "web:" + def.id };
  var names = ["fileName", "fileUrl", "fileSize", "nbSeeders", "nbLeechers", "descrLink"];
  for (var i = 0; i < names.length; i++) {
    var key = names[i];
    var spec = fields[key];
    if (!spec) continue;
    var value;
    if (key === "fileUrl" && spec.magnet) {
      value = buildMagnet(
        extractField(spec.magnet.infoHash, row, def.type),
        spec.magnet.name ? extractField(spec.magnet.name, row, def.type) : "",
        spec.magnet.trackers
      );
      if (value === null) return null; // sentinel / junk hash — drop the row
    } else {
      value = applyFilters(extractField(spec, row, def.type), spec.filters);
    }
    // Unknown numbers stay ABSENT, never -1: a row with -1 size and -1 swarm
    // is the isPluginNotice shape and would render as an engine error.
    if (key === "fileSize" || key === "nbSeeders" || key === "nbLeechers") {
      if (typeof value === "number" && isFinite(value) && value >= 0) result[key] = value;
    } else if (value) {
      result[key] = String(value);
    }
  }
  if (!result.fileName) return null;
  if (!result.fileUrl) {
    // Magnet-on-detail-page defs: the row ships its detail URL as fileUrl so
    // identity and the add flow have something stable, tagged for the lazy
    // magnet resolution at add time (resolveWebFileUrl).
    if (def.magnetFollow && result.descrLink) {
      result.fileUrl = result.descrLink;
      result.webFollow = def.id;
    } else {
      return null;
    }
  }
  return result;
}

// --- Bundled definitions --------------------------------------------------------
//
// Data, not code. Selectors are pinned by the fixture tests; when a site
// redesigns, the fix is a new definition, not a new parser.

var WEB_DEFS = [
  {
    schemaVersion: 1,
    id: "tpb",
    name: "The Pirate Bay",
    siteUrl: "https://thepiratebay.org",
    type: "json",
    search: { url: "https://apibay.org/q.php?q={q}&cat=100" },
    rows: { path: "" },
    fields: {
      fileName: { path: "name" },
      fileUrl: {
        magnet: {
          infoHash: { path: "info_hash" },
          name: { path: "name" },
          trackers: [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce"
          ]
        }
      },
      fileSize: { path: "size", filters: [["parseInt"]] },
      nbSeeders: { path: "seeders", filters: [["parseInt"]] },
      nbLeechers: { path: "leechers", filters: [["parseInt"]] },
      descrLink: { path: "id", filters: [["prepend", "https://thepiratebay.org/description.php?id="]] }
    }
  },
  {
    schemaVersion: 1,
    id: "nyaa",
    name: "Nyaa",
    siteUrl: "https://nyaa.si",
    type: "rss",
    search: { url: "https://nyaa.si/?page=rss&q={q}&c=2_0&f=0" },
    rows: { tag: "item" },
    fields: {
      fileName: { tag: "title" },
      fileUrl: { tag: "link" },
      fileSize: { tag: "nyaa:size", filters: [["parseSize"]] },
      nbSeeders: { tag: "nyaa:seeders", filters: [["parseInt"]] },
      nbLeechers: { tag: "nyaa:leechers", filters: [["parseInt"]] },
      descrLink: { tag: "guid" }
    }
  },
  {
    schemaVersion: 1,
    id: "x1337",
    name: "1337x",
    siteUrl: "https://1337x.to",
    type: "html",
    search: { url: "https://1337x.to/category-search/{q}/Music/1/" },
    rows: { selector: "table.table-list tbody > tr" },
    fields: {
      fileName: { selector: "td.coll-1 a:nth-child(2)" },
      descrLink: { selector: "td.coll-1 a:nth-child(2)", attribute: "href", filters: [["prepend", "https://1337x.to"]] },
      nbSeeders: { selector: "td.coll-2", filters: [["parseInt"]] },
      nbLeechers: { selector: "td.coll-3", filters: [["parseInt"]] },
      // The size cell embeds a completed-count span; take the leading size.
      fileSize: { selector: "td.coll-4", filters: [["regex", "^[\\d.,]+\\s*[KMGT]?i?B"], ["parseSize"]] }
    },
    magnetFollow: { selector: "a[href^=magnet]", attribute: "href" }
  },
  {
    schemaVersion: 1,
    id: "tgx",
    name: "TorrentGalaxy",
    siteUrl: "https://torrentgalaxy.to",
    type: "html",
    search: { url: "https://torrentgalaxy.to/torrents.php?search={q}&c22=1&c26=1&sort=seeders&order=desc" },
    rows: { selector: "div.tgxtablerow" },
    fields: {
      fileName: { selector: "div.tgxtablecell a.txlight" },
      descrLink: { selector: "div.tgxtablecell a.txlight", attribute: "href", filters: [["prepend", "https://torrentgalaxy.to"]] },
      fileUrl: { selector: "a[href^=magnet]", attribute: "href" },
      fileSize: { selector: "span.badge-secondary", filters: [["parseSize"]] },
      nbSeeders: { selector: "span[title*=Seeder]", filters: [["regex", "(\\d+)\\s*/"], ["parseInt"]] },
      nbLeechers: { selector: "span[title*=Seeder]", filters: [["regex", "/\\s*(\\d+)"], ["parseInt"]] }
    }
  }
];

// --- Validation -----------------------------------------------------------------

// Human-readable problems for a definition — what the settings paste box
// shows, and the tripwire proving every bundled def stays valid.
function validateIndexerDef(def, existingIds) {
  var problems = [];
  var d = def || {};
  var push = function (msg) {
    problems.push(msg);
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(d.id || ""))) push("“id” must be 1–32 chars of a-z, 0-9, - or _");
  else if (existingIds && existingIds[d.id]) push("“id” “" + d.id + "” is already taken");
  if (!String(d.name || "").trim()) push("“name” is required");
  if (!/^https?:\/\//.test(String(d.siteUrl || ""))) push("“siteUrl” must be an http(s) URL");
  var type = String(d.type || "");
  if (type !== "json" && type !== "rss" && type !== "html") push("“type” must be json, rss or html");
  var searchUrl = d.search && d.search.url;
  if (!/^https?:\/\//.test(String(searchUrl || ""))) push("“search.url” must be an http(s) URL");
  else if (String(searchUrl).indexOf("{q}") === -1) push("“search.url” must contain {q}");
  if (type === "html") {
    var rowsSel = d.rows && d.rows.selector;
    if (!rowsSel) push("an html definition needs “rows.selector”");
    else {
      var parsedRows = parseSelector(rowsSel);
      if (parsedRows.error) push("“rows.selector”: " + parsedRows.error);
    }
  } else if (type === "json") {
    if (!d.rows || typeof d.rows.path !== "string") push("a json definition needs “rows.path” (\"\" for the response root)");
  }
  var fields = d.fields || {};
  var allowedFields = { fileName: 1, fileUrl: 1, fileSize: 1, nbSeeders: 1, nbLeechers: 1, descrLink: 1 };
  for (var key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (!allowedFields[key]) {
      push("unknown field “" + key + "”");
      continue;
    }
    var spec = fields[key] || {};
    if (key === "fileUrl" && spec.magnet) {
      if (type !== "json") push("“fileUrl.magnet” is only for json definitions");
      if (!spec.magnet.infoHash) push("“fileUrl.magnet” needs “infoHash”");
      var trackers = spec.magnet.trackers || [];
      for (var t = 0; t < trackers.length; t++) {
        if (!/^(udp|https?):\/\//.test(String(trackers[t]))) push("tracker “" + trackers[t] + "” must be udp:// or http(s)://");
      }
    } else {
      var sources = 0;
      if (typeof spec.path === "string") sources++;
      if (spec.tag) sources++;
      if (spec.selector) sources++;
      if (sources !== 1) push("field “" + key + "” needs exactly one source (path / tag / selector)");
      else if (type === "json" && typeof spec.path !== "string") push("field “" + key + "” must use “path” in a json definition");
      else if (type === "rss" && !spec.tag) push("field “" + key + "” must use “tag” in an rss definition");
      else if (type === "html") {
        if (!spec.selector) push("field “" + key + "” must use “selector” in an html definition");
        else {
          var parsedField = parseSelector(spec.selector);
          if (parsedField.error) push("field “" + key + "”: " + parsedField.error);
        }
      }
    }
    var filters = spec.filters || [];
    for (var f = 0; f < filters.length; f++) {
      var fname = filters[f] && filters[f][0];
      if (!KNOWN_FILTERS[fname]) push("field “" + key + "”: unknown filter “" + fname + "”");
      else if (filters[f].length !== KNOWN_FILTERS[fname]) push("field “" + key + "”: filter “" + fname + "” takes " + (KNOWN_FILTERS[fname] - 1) + " argument(s)");
      else if (fname === "regex") {
        try {
          new RegExp(filters[f][1]);
        } catch (e) {
          push("field “" + key + "”: regex “" + filters[f][1] + "” doesn't compile");
        }
      }
    }
  }
  if (!fields.fileName) push("“fields.fileName” is required");
  if (!fields.fileUrl && !d.magnetFollow) push("“fields.fileUrl” is required unless “magnetFollow” is set");
  if (d.magnetFollow) {
    if (type !== "html") push("“magnetFollow” is only for html definitions");
    else if (!d.magnetFollow.selector) push("“magnetFollow” needs a “selector”");
    else {
      var parsedFollow = parseSelector(d.magnetFollow.selector);
      if (parsedFollow.error) push("“magnetFollow.selector”: " + parsedFollow.error);
    }
    if (d.magnetFollow && !fields.descrLink) push("“magnetFollow” needs “fields.descrLink” (the detail page to follow)");
  }
  if (d.limit !== undefined && !(d.limit >= 1 && d.limit <= 100)) push("“limit” must be 1–100");
  if (d.search && d.search.timeoutMs !== undefined && !(d.search.timeoutMs >= 2000 && d.search.timeoutMs <= 20000)) push("“search.timeoutMs” must be 2000–20000");
  if (d.search && d.search.minGapMs !== undefined && !(d.search.minGapMs >= 0 && d.search.minGapMs <= 60000)) push("“search.minGapMs” must be 0–60000");
  return problems;
}

// --- The sweep --------------------------------------------------------------------

// Per-HOST politeness: consecutive hits on one host are spaced by minGap +
// jitter (the google plugin's pattern), while different indexers run in
// parallel — a second same-host hit inside a second is the Cloudflare ban
// signature; hits on different sites are unrelated.
var webHostChains = {};

// The real fetch, injected everywhere else so tests can substitute a stub —
// the sandbox shadows global fetch and no test ever calls activate().
function webFetchFn(url, init) {
  return api.network.fetch(url, init);
}

// In-memory health per def id — { ok, fail, lastError } — for the settings
// note and the debug narration. Session-only, like the google plugin's stats.
var webIndexerStats = {};

function hostOf(url) {
  var m = /^https?:\/\/([^/]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

function throttledWebFetch(url, def, fetchFn, opts) {
  var host = hostOf(url);
  var minGap = (opts && opts.minGapMs !== undefined) ? opts.minGapMs : (def.search && def.search.minGapMs) || WEB_MIN_GAP_MS;
  var chain = webHostChains[host] || { tail: Promise.resolve(), lastAt: 0 };
  webHostChains[host] = chain;
  var run = chain.tail.then(function () {
    var wait = Math.max(0, chain.lastAt + minGap + Math.random() * WEB_GAP_JITTER_MS - Date.now());
    return delay(wait).then(function () {
      chain.lastAt = Date.now();
      return fetchFn(url, {
        method: "GET",
        headers: (def.search && def.search.headers) || undefined,
        timeoutMs: (def.search && def.search.timeoutMs) || WEB_TIMEOUT_MS
      });
    });
  });
  // The chain survives a failed request; the caller still sees the rejection.
  chain.tail = run.then(
    function () {
      return null;
    },
    function () {
      return null;
    }
  );
  return run.then(function (resp) {
    if (resp.status < 200 || resp.status >= 300) throw new Error("HTTP " + resp.status);
    return resp.text();
  });
}

function recordWebStat(id, ok, err) {
  var s = webIndexerStats[id] || { ok: 0, fail: 0, lastError: null };
  webIndexerStats[id] = s;
  if (ok) s.ok++;
  else {
    s.fail++;
    s.lastError = err || null;
  }
}

// Search every enabled definition, in parallel across hosts, failures
// isolated: a dead site records a stat and yields ONE notice-shaped row
// (fileSize/seeders/leechers = -1) that the existing search-notice rendering
// prints as "web:x: HTTP 403" — the sweep itself never rejects.
function webSearchAll(defs, query, fetchFn, opts) {
  var list = defs || [];
  var q = String(query == null ? "" : query).trim();
  if (!q || !list.length) return Promise.resolve([]);
  var jobs = [];
  for (var i = 0; i < list.length; i++) {
    (function (def) {
      var url = buildSearchUrl(def, q);
      dbg("search: [web:" + def.id + "] GET " + url);
      jobs.push(
        throttledWebFetch(url, def, fetchFn, opts)
          .then(function (body) {
            var rows = runDefOnBody(def, body);
            recordWebStat(def.id, true);
            dbg("search: [web:" + def.id + "] " + rows.length + " rows");
            return rows;
          })
          .catch(function (e) {
            recordWebStat(def.id, false, errText(e));
            console.error("qBittorrent: web indexer " + def.id + " failed:", e);
            dbg("search: [web:" + def.id + "] failed — " + errText(e));
            return [
              {
                fileName: errText(e),
                fileSize: -1,
                nbSeeders: -1,
                nbLeechers: -1,
                engineName: "web:" + def.id,
                siteUrl: def.siteUrl
              }
            ];
          })
      );
    })(list[i]);
  }
  return Promise.all(jobs).then(function (results) {
    var out = [];
    var real = 0;
    for (var r = 0; r < results.length; r++) {
      for (var j = 0; j < results[r].length; j++) {
        var row = results[r][j];
        if (isPluginNotice(row)) {
          out.push(row); // notices exempt from the cap
        } else if (real < WEB_TOTAL_ROW_CAP) {
          out.push(row);
          real++;
        }
      }
    }
    return out;
  });
}

// The definitions currently in force: bundled ones minus the user's disables,
// plus their custom ones (validated at paste time).
function enabledWebDefs() {
  var out = [];
  for (var i = 0; i < WEB_DEFS.length; i++) {
    if (!webIndexersDisabled[WEB_DEFS[i].id]) out.push(WEB_DEFS[i]);
  }
  for (var c = 0; c < customIndexers.length; c++) {
    if (!webIndexersDisabled[customIndexers[c].id]) out.push(customIndexers[c]);
  }
  return out;
}

function webDefById(id) {
  var all = WEB_DEFS.concat(customIndexers);
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

// qBittorrent's `downloader` field routes an add through one of ITS OWN
// search plugins. Our web engine names ("web:tpb") mean nothing to it — an
// add carrying one would fail. Every add path maps engineName through this.
function downloaderFor(result) {
  var name = String((result && result.engineName) || "");
  return name.indexOf("web:") === 0 ? "" : name;
}

// Lazy magnet resolution for magnetFollow rows: the list page had no magnet,
// only the detail URL. Fetched at ADD time, once, for the one row the user
// actually wants — an eager per-row fetch would hammer the site 20+ times per
// search for results nobody clicks.
function resolveWebFileUrl(result, fetchFn) {
  if (!result || !result.webFollow) return Promise.resolve(result);
  var def = webDefById(result.webFollow);
  if (!def || !def.magnetFollow) return Promise.resolve(result);
  dbg("add: [web:" + def.id + "] fetching the detail page for its magnet — " + result.fileUrl);
  return throttledWebFetch(result.fileUrl, def, fetchFn).then(function (body) {
    var el = selectFirst(parseMarkup(body, true), def.magnetFollow.selector);
    var magnet = el && el.attrs ? el.attrs[String(def.magnetFollow.attribute || "href").toLowerCase()] : null;
    if (!magnet || magnet.indexOf("magnet:") !== 0) {
      throw new Error("No magnet link found on the torrent's page");
    }
    var out = {};
    for (var k in result) {
      if (Object.prototype.hasOwnProperty.call(result, k)) out[k] = result[k];
    }
    out.fileUrl = magnet;
    delete out.webFollow;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Metadata resolver — serve ANY track from torrents
// ---------------------------------------------------------------------------
//
// Two host surfaces, deliberately different in what they're allowed to cost:
//
// - The STREAM resolver ("qBittorrent" in Settings → Streaming → Source
//   priority) fires on every unplayable track in the app, has a hard 60s cap,
//   and has no progress channel — so it answers ONLY from what torrents
//   already hold, and declines fast. A found-but-undownloaded file is primed
//   (started) and still declined, so the next source plays it today and the
//   torrent serves it tomorrow.
// - The DOWNLOAD provider may work for minutes: the host's 60s timeout is
//   idle-based and every reportProgress() resets it. Tiers 2 (wait for a file
//   the torrent holds) and 3 (go find a torrent) live here.

// --- Debug tracing ------------------------------------------------------------
//
// The Debug tab runs the REAL resolver functions and watches them narrate.
// dbg() is a no-op unless a debug run is in flight, so the production paths
// pay one boolean check per step and the narration can be written where the
// decisions are made instead of duplicated in a shadow pipeline.
var debugRunning = false;
var debugStartedAt = 0;
var debugLog = [];
var DEBUG_LOG_MAX = 300;
// What the Debug tab's inputs hold. Session-only — this is a workbench.
var debugFields = { title: "", artist: "", album: "" };

// A debug run is the REAL pipeline — the download test genuinely adds and
// downloads torrents. That is the point (a dry run would debug a different
// program), so the tab says it plainly instead of pretending otherwise.
function runDebugResolve(kind) {
  if (debugRunning) return;
  var t = debugFields.title.trim();
  var a = debugFields.artist.trim();
  var al = debugFields.album.trim();
  if (!t && !a) {
    api.ui.showNotification("Enter at least a title or an artist");
    return;
  }
  debugLog = [];
  debugRunning = true;
  debugStartedAt = Date.now();
  dbg(
    (kind === "stream" ? "STREAM resolve" : kind === "stream-fetch" ? "STREAM+FETCH resolve" : "DOWNLOAD resolve") +
      ": title=“" + t + "” artist=“" + a + "” album=“" + al + "”"
  );
  var run =
    kind === "stream"
      ? resolveStreamByMetadata(t, a || null, al || null, null, {})
      : kind === "stream-fetch"
        ? resolveStreamByMetadataFetching(t, a || null, al || null, null, {})
        : resolveDownloadByMetadata(t, a || null, al || null, null, "");
  run
    .then(function (result) {
      dbg(
        result
          ? "RESULT: " + (result.url || "(no url?)") + (result.label ? "  [" + result.label + "]" : "")
          : "DECLINED (null) — the host would fall through to the next source"
      );
    })
    .catch(function (e) {
      console.error("qBittorrent: debug resolve failed:", e);
      dbg("ERROR: " + errText(e));
    })
    .then(function () {
      debugRunning = false;
      render();
    });
}

function debugTabNodes() {
  var children = [
    {
      type: "text",
      className: "muted",
      content:
        "Runs the real resolver against your qBittorrent and narrates every step. " +
        "The download test is not a simulation — it can add torrents and download files, exactly as a real download would."
    },
    { type: "text-input", placeholder: "Title", action: "qbt:debug-title", value: debugFields.title },
    { type: "text-input", placeholder: "Artist", action: "qbt:debug-artist", value: debugFields.artist },
    { type: "text-input", placeholder: "Album", action: "qbt:debug-album", value: debugFields.album },
    {
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "Test play (downloaded)", action: "qbt:debug-stream", variant: "accent", disabled: debugRunning },
        { type: "button", label: "Test play (fetch & play)", action: "qbt:debug-stream-fetch", variant: "secondary", disabled: debugRunning },
        { type: "button", label: "Test download (tiers 1–3)", action: "qbt:debug-download", variant: "secondary", disabled: debugRunning },
        { type: "button", label: "Clear log", action: "qbt:debug-clear", variant: "secondary", disabled: debugRunning || !debugLog.length }
      ]
    }
  ];
  if (debugRunning) children.push({ type: "loading", message: "Resolving — steps appear below as they happen…" });
  for (var i = 0; i < debugLog.length; i++) {
    children.push({ type: "text", className: "muted", content: debugLog[i] });
  }
  return children;
}

function dbg(msg) {
  if (!debugRunning) return;
  var secs = ((Date.now() - debugStartedAt) / 1000).toFixed(1);
  debugLog.push("+" + secs + "s  " + msg);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  render();
}

// The one line that says WHAT is being searched for and WHERE. The local cache
// isn't queried with a string — it's token-matched — so this prints the
// normalized needles the matcher will actually use, which is what settles
// "why didn't it find it": you can read the folded tokens against the folded
// filenames.
function dbgCacheTarget(prefix, want) {
  if (!debugRunning) return;
  var bits = ["title “" + normalizeForMatch(want.title) + "”"];
  if (want.artist) bits.push("artist “" + normalizeForMatch(want.artist) + "”");
  if (want.album) bits.push("album “" + normalizeForMatch(want.album) + "”");
  dbg(prefix + " [local cache] matching " + bits.join(" + ") + " across " + Object.keys(fileNamesByHash).length + " cached torrents");
}

// Progress narration without the firehose: one line per decile, not per poll.
function dbgEvery10(label) {
  var last = -1;
  return function (frac) {
    var decile = Math.floor(numOr(frac, 0) * 10);
    if (decile > last) {
      last = decile;
      dbg(label + " " + Math.round(numOr(frac, 0) * 100) + "%");
    }
  };
}

// Progress to the host's download modal. Best-effort by design: the host may
// have abandoned the resolve, and a throw here must not kill a working job.
function reportPct(percent) {
  if (api && api.downloads && typeof api.downloads.reportProgress === "function") {
    try {
      api.downloads.reportProgress({ percent: Math.max(0, Math.min(100, Math.round(percent))) });
    } catch (e) {
      // Progress is decoration on the resolve, never the resolve itself.
    }
  }
}

function locateFileByName(files, name) {
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].name === name) return list[i];
  }
  return null;
}

function wantFromArgs(title, artistName, albumName, durationSecs) {
  return {
    title: String(title || ""),
    artist: artistName == null ? "" : String(artistName),
    album: albumName == null ? "" : String(albumName),
    durationSecs: numOr(durationSecs, 0)
  };
}

// Tier-1 verification by the file's own tags, when they can be read. Only a
// CONTRADICTION blocks — silent tags leave the name-based match standing.
// The duration check rides along: tags carry the real length, and 30s apart
// is a different recording whatever the filename says.
function verifyMatchByTags(torrent, file, want) {
  if (!canReadTags() || !filesAreReachable() || numOr(file.progress, 0) < 1) {
    return Promise.resolve("unknown");
  }
  return readTagsForFiles(torrent, [file]).then(function () {
    var tags = tagsFor(torrent, file);
    if (tags && want.durationSecs > 0 && numOr(tags.duration_secs, 0) > 0) {
      if (Math.abs(tags.duration_secs - want.durationSecs) > 30) return "contradict";
    }
    return confirmByTags(tags, want);
  });
}

// --- Stream resolver (tier 1 + prime) ----------------------------------------

// Torrents already primed this session, so replaying a track that is mid-
// download doesn't restack priorities and re-toast on every attempt.
var primedFetches = {};

function primeFoundFile(hash, file) {
  if (primedFetches[hash + ":" + file.index]) return;
  primedFetches[hash + ":" + file.index] = true;
  var t = torrents[hash];
  var name = (t && t.name) || "torrent";
  var ensureWanted = numOr(file.priority, 1) === 0 ? postFilePriority(hash, [file.index], 1) : Promise.resolve();
  ensureWanted
    .then(function () {
      return t && isPaused(t) ? postAction(startEndpoint(), [hash], "Starting the torrent") : null;
    })
    .then(function () {
      api.ui.showNotification("That song is in “" + name + "” — downloading it now so it can play from the torrent next time");
    })
    .catch(function (e) {
      console.error("qBittorrent: could not start the found file's download:", e);
      // Let a failed prime be retried on the next play.
      delete primedFetches[hash + ":" + file.index];
    });
}

// TWO Source-priority entries share this core, split by what they may cost:
//
// - "qBittorrent (downloaded)" (mayFetch=false) answers only from files that
//   are already here — instant or decline, with a found-but-missing file
//   primed for next time.
// - "qBittorrent (fetch & play)" (mayFetch=true) may WAIT for the download of
//   a file an existing torrent holds, up to STREAM_FETCH_MAX_MS — safely
//   under the host's hard 60s cap. Placed low in Source priority it fires
//   only when nothing else could play, which is exactly when waiting is
//   acceptable. On timeout or stall the download keeps running (it is a
//   prime with a head start) and the resolver declines.
//
// (fetch & play) ALSO runs discovery when no existing torrent has the track —
// enabling that entry plus the "Search torrents for downloads" setting is the
// consent for adding torrents on a play. The job is raced against the stream
// budget: a fast swarm occasionally lands a single track inside it, and when
// it doesn't, the resolver declines while the job runs to its bounded end in
// the background — the next source plays the track today, the torrent serves
// it next time, and a notification says so when the file arrives.
var STREAM_FETCH_MAX_MS = 50000;

// One background discovery per track, keyed by artist+title — replaying a
// track that declined must not enqueue the same search again while the first
// is still working.
var backgroundDiscovery = {};

function streamDiscoveryRace(tag, want) {
  var key = normalizeForMatch(String(want.artist || "") + " " + String(want.title || ""));
  if (backgroundDiscovery[key]) {
    dbg(tag + " discovery for this track is already running — decline");
    return Promise.resolve(null);
  }
  backgroundDiscovery[key] = true;
  dbg(tag + " [local cache] no match — starting discovery, racing it against the " + Math.round(STREAM_FETCH_MAX_MS / 1000) + "s budget");
  var job = discoverAndFetch(want, "")
    .catch(function (e) {
      console.error("qBittorrent: play-triggered discovery failed:", e);
      return null;
    })
    .then(function (r) {
      delete backgroundDiscovery[key];
      return r;
    });
  return new Promise(function (resolve) {
    var answered = false;
    var timer = setTimeout(function () {
      answered = true;
      dbg(tag + " budget spent — discovery keeps running in the background, decline");
      resolve(null);
    }, STREAM_FETCH_MAX_MS);
    job.then(function (r) {
      if (!answered) {
        clearTimeout(timer);
        answered = true;
        if (r && r.url) {
          dbg(tag + " discovery finished inside the budget — answering " + r.url);
          // A file:// URL is a legal stream answer; the host classifies it.
          resolve({ url: r.url, label: "qBittorrent", sourceUrl: r.url });
        } else {
          dbg(tag + " discovery found nothing — decline");
          resolve(null);
        }
        return;
      }
      // The play has long moved on — say what arrived, or the download the
      // user implicitly ordered finishes invisibly.
      if (r && r.url) {
        var got = (r.metadata && r.metadata.title) || want.title;
        api.ui.showNotification("Fetched “" + got + "” from a torrent — it will play from there next time");
      }
    });
  });
}

function streamResolveCore(title, artistName, albumName, durationSecs, opts, mayFetch) {
  var tag = mayFetch ? "stream+fetch:" : "stream:";
  // Every decline must be FAST — this fires for every track no other source
  // could play, and a slow "no" here drags the whole app's playback.
  if (!connected || !baseUrl) {
    dbg(tag + " not connected to qBittorrent — decline");
    return Promise.resolve(null);
  }
  if (!filesAreReachable()) {
    dbg(tag + " qBittorrent's files aren't reachable on this machine — decline");
    return Promise.resolve(null);
  }
  var want = wantFromArgs(title, artistName, albumName, durationSecs);
  dbgCacheTarget(tag, want);
  var best = findTrackInTorrents(want, torrents, fileNamesByHash);
  if (!best) {
    // (fetch & play) goes and FINDS one; the instant entry just declines.
    if (mayFetch && discoveryEnabled) return streamDiscoveryRace(tag, want);
    dbg(tag + " [local cache] no match — decline" + (mayFetch ? " (discovery is off in settings)" : ""));
    return Promise.resolve(null);
  }
  var t = torrents[best.hash];
  dbg(tag + " [local cache] matched “" + best.name + "” in “" + ((t && t.name) || best.hash) + "” (score " + best.score.toFixed(2) + ")");

  var answer = function (file) {
    return verifyMatchByTags(torrents[best.hash] || t, file, want).then(function (verdict) {
      dbg(tag + " tag check — " + verdict);
      if (verdict === "contradict") return null;
      // Our own scheme: the host recurses into the qbt:// by-URI resolver,
      // which owns path mapping and source-panel attribution already.
      var result = { url: qbtUri(best.hash, file.index), label: "qBittorrent" };
      if (opts && opts.preferVideo) result.video = mediaKindOf(file.name) === "video";
      dbg(tag + " answering " + result.url);
      return result;
    });
  };

  // One request to learn the file's REAL index and progress — the name cache
  // holds neither, and the position in it is not the qBittorrent index.
  return fetchFilesQuiet(best.hash)
    .then(function (files) {
      var file = locateFileByName(files, best.name);
      if (!file) {
        dbg(tag + " the matched file is no longer in the torrent — decline");
        return null;
      }
      if (numOr(file.progress, 0) >= 1) return answer(file);

      if (!mayFetch) {
        // The torrent HOLDS it but hasn't downloaded it. This entry can't
        // wait, so start the file (setting only) and decline — the next
        // source plays it now, this one next time.
        dbg(
          tag + " file is only " + Math.round(numOr(file.progress, 0) * 100) + "% downloaded — " +
            (autoFetchFound ? "priming its download and declining" : "auto-fetch is off, declining")
        );
        if (autoFetchFound) primeFoundFile(best.hash, file);
        return null;
      }

      // Fetch & play: select the file, start the torrent, and wait it out
      // inside the stream budget.
      dbg(
        tag + " file is " + Math.round(numOr(file.progress, 0) * 100) + "% here — starting it and waiting up to " +
          Math.round(STREAM_FETCH_MAX_MS / 1000) + "s"
      );
      var dbgTick = dbgEvery10(tag + " downloading —");
      var ensureWanted = numOr(file.priority, 1) === 0 ? postFilePriority(best.hash, [file.index], 1) : Promise.resolve();
      return ensureWanted
        .then(function () {
          return isPaused(t) ? postAction(startEndpoint(), [best.hash], "Starting the torrent") : null;
        })
        .then(function () {
          return waitForFileDownload(best.hash, file.index, dbgTick, { maxMs: STREAM_FETCH_MAX_MS });
        })
        .then(answer)
        .catch(function (e) {
          // Timeout or stall: leave the download running — it is a prime with
          // a head start, and the next play of this track is a tier-1 hit.
          dbg(tag + " " + errText(e) + " — the download keeps running, decline");
          return null;
        });
    })
    .catch(function (e) {
      console.error("qBittorrent: stream resolve failed:", e);
      dbg(tag + " failed — " + errText(e));
      return null;
    });
}

// The handlers themselves, named so the Debug tab can run them directly.
function resolveStreamByMetadata(title, artistName, albumName, durationSecs, opts) {
  return streamResolveCore(title, artistName, albumName, durationSecs, opts, false);
}

function resolveStreamByMetadataFetching(title, artistName, albumName, durationSecs, opts) {
  return streamResolveCore(title, artistName, albumName, durationSecs, opts, true);
}

function registerMetadataStreamResolver() {
  if (!api.playback || typeof api.playback.onStreamResolve !== "function") return;
  api.playback.onStreamResolve("qbt-stream", resolveStreamByMetadata);
  api.playback.onStreamResolve("qbt-stream-fetch", resolveStreamByMetadataFetching);
}

// --- Download provider: tiers 1–2 --------------------------------------------

function extOf(name) {
  var m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : null;
}

function downloadResultFor(torrent, file) {
  var path = localPathFor(torrent, file);
  if (!path) throw new Error("qBittorrent didn't report where it saved this torrent");
  var track = mergeFileTrack(torrent, file, tagsFor(torrent, file));
  return {
    url: "file://" + path,
    headers: null,
    ext: extOf(file.name),
    metadata: {
      title: track.title,
      artist: track.artist_name,
      album: track.album_title,
      trackNumber: track.track_number
    }
  };
}

// Poll one file until it is fully here. Progress feeds the modal AND resets
// the host's idle timeout; the stall guard is ours — a swarm that stops
// delivering bytes for two minutes is not going to finish inside anyone's
// patience, and the caller decides what to do with the corpse.
var FILE_WAIT_POLL_MS = 2000;

function waitForFileDownload(hash, fileIndex, onProgress, waitOpts) {
  var maxMs = (waitOpts && waitOpts.maxMs) || RESOLVE_MAX_MS;
  var startedAt = Date.now();
  var stall = { bytes: -1, at: Date.now() };
  var step = function () {
    return fetchFilesQuiet(hash).then(function (files) {
      var file = null;
      for (var i = 0; i < files.length; i++) {
        if (files[i].index === fileIndex) {
          file = files[i];
          break;
        }
      }
      if (!file) throw new Error("That file is no longer in the torrent");
      var t = torrents[hash];
      if (!t) throw new Error("That torrent is no longer in qBittorrent");
      if (isErrored(t)) throw new Error("qBittorrent reports the torrent as errored");
      var progress = numOr(file.progress, 0);
      if (progress >= 1) return file;
      if (onProgress) onProgress(progress);
      var now = Date.now();
      if (now - startedAt > maxMs) throw new Error("The download didn't finish in time");
      var bytes = Math.floor(progress * numOr(file.size, 0));
      var check = detectResolveStall(stall, bytes, now, RESOLVE_STALL_MS);
      stall = check.next;
      if (check.stalled) throw new Error("The download stalled — no data arrived for " + Math.round(RESOLVE_STALL_MS / 60000) + " minutes");
      return refresh().then(function () {
        return delay(FILE_WAIT_POLL_MS).then(step);
      });
    });
  };
  return step();
}

// Tier 1/2: the wanted track is in an EXISTING torrent. Serve it if it is
// here; select-and-wait if it isn't.
function fetchExistingMatch(best, want) {
  var t = torrents[best.hash];
  if (!t) return Promise.resolve(null);
  return fetchFilesQuiet(best.hash).then(function (files) {
    var file = locateFileByName(files, best.name);
    if (!file) {
      dbg("existing: the matched file is no longer in the torrent");
      return null;
    }
    if (numOr(file.progress, 0) >= 1) {
      dbg("existing: file is fully downloaded — tier 1");
      return verifyMatchByTags(t, file, want).then(function (verdict) {
        dbg("existing: tag check — " + verdict);
        if (verdict === "contradict") return null;
        reportPct(100);
        return downloadResultFor(t, file);
      });
    }
    // Tier 2. The file may be deselected (priority 0) — wanting to download it
    // IS the selection now.
    dbg("existing: file is " + Math.round(numOr(file.progress, 0) * 100) + "% here — tier 2, selecting it and starting the torrent");
    reportPct(5);
    var dbgTick = dbgEvery10("existing: downloading —");
    var ensureWanted = numOr(file.priority, 1) === 0 ? postFilePriority(best.hash, [file.index], 1) : Promise.resolve();
    return ensureWanted
      .then(function () {
        return isPaused(t) ? postAction(startEndpoint(), [best.hash], "Starting the torrent") : null;
      })
      .then(function () {
        return waitForFileDownload(best.hash, file.index, function (frac) {
          reportPct(5 + 94 * frac);
          dbgTick(frac);
        });
      })
      .then(function (done) {
        var t2 = torrents[best.hash] || t;
        return verifyMatchByTags(t2, done, want).then(function (verdict) {
          dbg("existing: download complete — tag check " + verdict);
          if (verdict === "contradict") {
            throw new Error("The downloaded file's tags say it is a different song — not handing it over");
          }
          reportPct(100);
          return downloadResultFor(t2, done);
        });
      });
  });
}

// --- Tier 3: discovery -------------------------------------------------------

var RESOLVE_SEARCH_MAX_MS = 15000;
var RESOLVE_ATTACH_ATTEMPTS = 12;
var RESOLVE_META_MAX_MS = 25000;
var RESOLVE_MAX_CANDIDATES = 3;
var RESOLVE_STALL_MS = 120000;
var RESOLVE_MAX_MS = 900000;
var RESOLVE_MIN_SIZE = 5 * 1024 * 1024;
var RESOLVE_MAX_SIZE = 30 * 1024 * 1024 * 1024;
var ORPHAN_MAX_MS = 10 * 60 * 1000;

// Pure: byte-progress stall arithmetic. `prev` = { bytes, at }; returns the
// carried state plus the verdict, so callers can't misplace the bookkeeping.
function detectResolveStall(prev, bytes, nowMs, stallMs) {
  if (bytes > prev.bytes) return { stalled: false, next: { bytes: bytes, at: nowMs } };
  return { stalled: nowMs - prev.at >= stallMs, next: prev };
}

// Pure: the modal's percent for each stage, monotonic 0→100 so the bar never
// walks backwards. Candidates split the 10–34 band between them.
function resolvePercent(stage, candidateIndex, frac) {
  var f = Math.max(0, Math.min(1, numOr(frac, 0)));
  if (stage === "search") return 2 + 8 * f;
  if (stage === "candidate") return 10 + numOr(candidateIndex, 0) * 8 + 8 * f;
  if (stage === "commit") return 35;
  if (stage === "download") return 35 + 64 * f;
  return 0;
}

// Hard filters — everything a candidate must be before scoring even starts.
// Matching uses the NORMALIZED matcher, not matchesFilter: "Björk" has to find
// a torrent that spells it "Bjork".
function filterTier3Candidates(results, ctx) {
  var out = [];
  var list = results || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || isPluginNotice(r)) continue;
    if (!r.fileUrl) continue; // a description page cannot be added
    if (classifyTorrentMedia(r.fileName) === "video") continue;
    if (swarmCount(r.nbSeeders) === 0) continue; // dead; unknown (null) passes
    var size = numOr(r.fileSize, 0);
    if (size > 0 && (size < RESOLVE_MIN_SIZE || size > RESOLVE_MAX_SIZE)) continue;
    if (ctx.artist && !containsAllTokens(normalizeForMatch(r.fileName || ""), ctx.artist)) continue;
    out.push(r);
  }
  return out;
}

// Seeders are the availability FLOOR, not the ranking: the top-seeded result
// is routinely a 128k rip or a 400 GB discography. Format keywords weighted by
// what the host asked for, size sanity, and a discography demotion do the rest.
function formatKeywordScore(name, format) {
  var n = String(name || "");
  var lossless = /\b(flac|alac|wav|lossless)\b/i.test(n);
  var cbr320 = /\b320\b/.test(n);
  var v0 = /\bv0\b/i.test(n);
  var hiRes = /\b24[\s-]?(bit|96|192)\b/i.test(n);
  var f = String(format || "").toLowerCase();
  if (f === "flac" || f === "alac" || f === "wav") {
    return (lossless ? 12 : 0) + (hiRes ? 4 : 0) + (cbr320 || /\bmp3\b/i.test(n) ? -4 : 0);
  }
  if (f === "mp3" || f === "aac" || f === "m4a" || f === "ogg" || f === "opus") {
    return (cbr320 ? 12 : 0) + (v0 ? 8 : 0) + (lossless ? 2 : 0);
  }
  return (lossless ? 6 : 0) + (cbr320 ? 4 : 0);
}

function scoreSearchCandidate(r, ctx) {
  var s = 0;
  var seeds = swarmCount(r.nbSeeders);
  s += seeds === null ? 2 : Math.min(40, (4 * Math.log(1 + seeds)) / Math.LN2);
  var nameNorm = normalizeForMatch(r.fileName || "");
  if (ctx.album && containsAllTokens(nameNorm, ctx.album)) s += 15;
  if (ctx.title && containsAllTokens(nameNorm, ctx.title)) s += 6;
  s += formatKeywordScore(r.fileName, ctx.format);
  var size = numOr(r.fileSize, 0);
  if (size >= 50 * 1024 * 1024 && size <= 2 * 1024 * 1024 * 1024) s += 8;
  else if (size > 10 * 1024 * 1024 * 1024) s -= 8;
  if (/discograph|complete|collection|anthology|box\s?set/i.test(String(r.fileName || ""))) s -= 10;
  return s;
}

function rankTier3Candidates(results, ctx) {
  var viable = filterTier3Candidates(results, ctx);
  viable.sort(function (a, b) {
    var d = scoreSearchCandidate(b, ctx) - scoreSearchCandidate(a, ctx);
    if (d) return d;
    return numOr(b.nbLeechers, 0) - numOr(a.nbLeechers, 0);
  });
  return viable.slice(0, RESOLVE_MAX_CANDIDATES);
}

// The file inside an examined torrent that IS the wanted track — the same
// precision matcher tier 1 uses, so a candidate that merely looks like the
// right release can still be rejected file by file.
function pickFileForTrack(files, torrentName, want) {
  var best = null;
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    if (!mediaKindOf(list[i].name)) continue;
    var score = titleMatchScore({ fileName: list[i].name, torrentName: torrentName }, want);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score) best = { file: list[i], score: score };
  }
  return best ? best.file : null;
}

// Pure: should the janitor remove this torrent? Only ones WE added (tracked in
// the orphan map), not owned by a live job, and old enough that no bounded
// stage can still be working on them.
function isResolveOrphan(torrent, addedAtMs, nowMs, ownedByLiveJob) {
  if (!torrent || !addedAtMs || ownedByLiveJob) return false;
  return nowMs - addedAtMs > ORPHAN_MAX_MS;
}

// Candidates this plugin added for examination, persisted so a plugin reload
// or host crash mid-examine can't strand a paused torrent forever. The winner
// leaves the map the moment its download is started.
var tier3Orphans = {};
var ORPHANS_STORAGE_KEY = "tier3Pending";

function trackOrphan(hash) {
  tier3Orphans[hash] = Date.now();
  persistOrphans();
}

function untrackOrphan(hash) {
  if (!(hash in tier3Orphans)) return;
  delete tier3Orphans[hash];
  persistOrphans();
}

function persistOrphans() {
  if (!api) return;
  api.storage.set(ORPHANS_STORAGE_KEY, tier3Orphans).catch(function (e) {
    console.error("qBittorrent: could not save the examined-torrents list:", e);
  });
}

function loadOrphans() {
  return api.storage
    .get(ORPHANS_STORAGE_KEY)
    .then(function (saved) {
      if (saved && typeof saved === "object") tier3Orphans = saved;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not read the examined-torrents list:", e);
    });
}

// Runs from the poll loop: remove leftovers of jobs that never finished.
function sweepResolveOrphans() {
  var owned = resolveJob ? resolveJob.hashes : {};
  var now = Date.now();
  for (var hash in tier3Orphans) {
    if (!Object.prototype.hasOwnProperty.call(tier3Orphans, hash)) continue;
    var t = torrents[hash];
    if (!t) {
      // Gone from the server — nothing left to clean.
      delete tier3Orphans[hash];
      persistOrphans();
      continue;
    }
    if (isResolveOrphan(t, tier3Orphans[hash], now, !!owned[hash])) {
      var stranded = hash;
      untrackOrphan(stranded);
      deleteTorrents([stranded], true).catch(function (e) {
        console.error("qBittorrent: could not remove a stranded examined torrent:", e);
      });
    }
  }
}

// One discovery at a time, FIFO for the next few (an album download fires
// several resolves at once), a hard no beyond that. A waiter keeps the host's
// idle timer alive and gives up if the queue doesn't reach it in 5 minutes.
var resolveJob = null;
var resolveQueueTail = Promise.resolve();
var resolveQueueDepth = 0;
var RESOLVE_QUEUE_MAX = 3;
var RESOLVE_QUEUE_WAIT_MS = 5 * 60 * 1000;

function enqueueDiscovery(fn) {
  if (resolveQueueDepth >= RESOLVE_QUEUE_MAX) return Promise.resolve(null);
  resolveQueueDepth++;
  var waitedFrom = Date.now();
  var keepAlive = setInterval(function () {
    reportPct(1);
  }, 15000);
  var turn = resolveQueueTail.then(function () {
    clearInterval(keepAlive);
    if (Date.now() - waitedFrom > RESOLVE_QUEUE_WAIT_MS) return null;
    return fn();
  });
  // The chain must survive a failed job, or one bad resolve wedges the queue.
  resolveQueueTail = turn.catch(function () {
    return null;
  });
  return turn.then(
    function (r) {
      resolveQueueDepth--;
      return r;
    },
    function (e) {
      clearInterval(keepAlive);
      resolveQueueDepth--;
      throw e;
    }
  );
}

// Told once per session, not once per failed track of an album.
var saidNoSearchPlugins = false;

function discoverAndFetch(want, format) {
  return enqueueDiscovery(function () {
    return runDiscovery(want, format);
  });
}

// The queries discovery tries, in order. Torrent releases are named by ARTIST
// and ALBUM, never by track titles — so "artist album" leads, the artist alone
// follows (catches singles, EPs, and releases whose name doesn't say the
// album), and the bare title is used ONLY when there is no artist to search
// by: "One" as a torrent search is noise, but it is all a titled-only track
// has to offer.
function discoveryQueries(want) {
  var artist = String((want && want.artist) || "").trim();
  var album = String((want && want.album) || "").trim();
  var title = String((want && want.title) || "").trim();
  var out = [];
  if (artist && album) out.push(artist + " " + album);
  if (artist) out.push(artist);
  if (!artist && title) out.push(title);
  return out;
}

function runDiscovery(want, format) {
  var ctx = { title: want.title, artist: want.artist, album: want.album, format: format };
  var queries = discoveryQueries(want);
  if (!queries.length) return Promise.resolve(null);
  resolveJob = { hashes: {}, startedAt: Date.now() };
  reportPct(resolvePercent("search", 0, 0));
  var searchStep = function (q) {
    return collectSearchResults(q, {
      maxMs: RESOLVE_SEARCH_MAX_MS,
      onTick: function (count, elapsed) {
        reportPct(resolvePercent("search", 0, elapsed / RESOLVE_SEARCH_MAX_MS));
      }
    });
  };
  // Walk the ladder until a query yields something worth examining.
  var trySearch = function (idx) {
    if (idx >= queries.length) return Promise.resolve([]);
    dbg("discovery: [qBittorrent app] search string “" + queries[idx] + "” (" + (idx + 1) + "/" + queries.length + ")");
    return searchStep(queries[idx]).then(function (results) {
      var viable = filterTier3Candidates(results || [], ctx);
      var ranked = rankTier3Candidates(results, ctx);
      dbg("discovery: [qBittorrent app] “" + queries[idx] + "” → " + (results || []).length + " results, " + viable.length + " viable");
      for (var di = 0; di < ranked.length; di++) {
        dbg(
          "  " + (di + 1) + ". “" + ranked[di].fileName + "” — " +
            formatBytes(ranked[di].fileSize) + ", " + formatSeedCount(swarmCount(ranked[di].nbSeeders)) +
            " seeds, score " + scoreSearchCandidate(ranked[di], ctx).toFixed(1)
        );
      }
      if (ranked.length) return ranked;
      return trySearch(idx + 1);
    });
  };
  return trySearch(0)
    .then(function (candidates) {
      if (!candidates.length) {
        dbg("discovery: nothing viable from any query — giving up");
        return null;
      }
      return examineCandidates(candidates, 0, want);
    })
    .catch(function (e) {
      if (String(e && e.message) === "no-plugins") {
        dbg("discovery: qBittorrent has no search plugins installed — giving up");
        if (!saidNoSearchPlugins) {
          saidNoSearchPlugins = true;
          api.ui.showNotification(
            "qBittorrent has no search plugins, so tracks can't be found automatically — install some under View → Search Engine in qBittorrent"
          );
        }
        return null;
      }
      throw e;
    })
    .then(
      function (r) {
        resolveJob = null;
        return r;
      },
      function (e) {
        resolveJob = null;
        throw e;
      }
    );
}

function examineCandidates(candidates, i, want) {
  if (i >= candidates.length) return Promise.resolve(null);
  var r = candidates[i];
  var addedHash = null;
  dbg("examine " + (i + 1) + "/" + candidates.length + ": adding “" + r.fileName + "” paused");
  reportPct(resolvePercent("candidate", i, 0));
  var before = shallowHashSet(torrents);
  var expected = null;
  // A web magnet-follow candidate holds only its detail URL until now; the
  // magnet is fetched for the ONE candidate being examined, not for the list.
  return resolveWebFileUrl(r, webFetchFn)
    .then(function (resolved) {
      r = resolved;
      expected = magnetHash(r.fileUrl);
      return addTorrentRaw(r.fileUrl, { paused: true, downloader: downloaderFor(r) });
    })
    .then(function () {
      return waitForAddedTorrent(before, expected, r.fileName || "", 0, RESOLVE_ATTACH_ATTEMPTS);
    })
    .then(function (hash) {
      if (!hash) {
        dbg("  it never registered in qBittorrent (dead link?) — next candidate");
        return null; // dead link — nothing was added, nothing to clean
      }
      addedHash = hash;
      if (resolveJob) resolveJob.hashes[hash] = true;
      trackOrphan(hash);
      dbg("  registered as " + hash.substring(0, 12) + "… — waiting for its file list");
      return waitForMetadataQuiet(hash, {
        maxMs: RESOLVE_META_MAX_MS,
        onTick: function (elapsed) {
          reportPct(resolvePercent("candidate", i, 0.2 + (0.6 * elapsed) / RESOLVE_META_MAX_MS));
        }
      }).then(function (res) {
        if (!res.ok) {
          dbg(res.gone ? "  the torrent vanished while waiting — next candidate" : "  no file list after " + Math.round(RESOLVE_META_MAX_MS / 1000) + "s — removing it, next candidate");
          return null;
        }
        return fetchFilesQuiet(hash).then(function (files) {
          var t = torrents[hash];
          var file = pickFileForTrack(files, (t && t.name) || r.fileName || "", want);
          if (!file) {
            dbg("  " + files.length + " files, none match the track — removing it, next candidate");
            return null;
          }
          dbg("  " + files.length + " files — picked “" + file.name + "”");
          return { hash: hash, files: files, file: file };
        });
      });
    })
    .catch(function (e) {
      console.error("qBittorrent: examining a search candidate failed:", e);
      return null;
    })
    .then(function (found) {
      if (found) return commitCandidate(found, want);
      // This candidate is a dud — remove what we added and move on.
      var cleanup = addedHash
        ? deleteTorrents([addedHash], true).catch(function (e) {
            console.error("qBittorrent: could not remove an examined torrent:", e);
          })
        : Promise.resolve();
      if (addedHash) untrackOrphan(addedHash);
      return cleanup.then(function () {
        return examineCandidates(candidates, i + 1, want);
      });
    });
}

function commitCandidate(found, want) {
  var hash = found.hash;
  dbg("commit: deselect all → select “" + found.file.name + "” → start");
  reportPct(resolvePercent("commit", 0, 0));
  var dbgTick = dbgEvery10("commit: downloading —");
  var all = [];
  for (var i = 0; i < found.files.length; i++) {
    if (typeof found.files[i].index === "number") all.push(found.files[i].index);
  }
  // Deselect first, start second — the armPeek rule. Starting a torrent whose
  // files are at their default priority downloads the entire release.
  return postFilePriority(hash, all, 0)
    .then(function () {
      return postFilePriority(hash, [found.file.index], 1);
    })
    .then(function () {
      return postAction(startEndpoint(), [hash], "Starting the download");
    })
    .then(function () {
      // Started on purpose = no longer an orphan; from here it is an ordinary
      // torrent the user can see, stop, or remove like any other.
      untrackOrphan(hash);
      return waitForFileDownload(hash, found.file.index, function (frac) {
        reportPct(resolvePercent("download", 0, frac));
        dbgTick(frac);
      });
    })
    .then(function (file) {
      var t = torrents[hash];
      if (!t) throw new Error("That torrent is no longer in qBittorrent");
      return verifyMatchByTags(t, file, want).then(function (verdict) {
        dbg("commit: download complete — tag check " + verdict);
        if (verdict === "contradict") {
          return deleteTorrents([hash], true).then(function () {
            throw new Error("The downloaded file's tags say it is a different song");
          });
        }
        var result = downloadResultFor(t, file);
        dbg("commit: disposition “" + tier3Disposition + "”");
        return finalizeDisposition(hash, t).then(function () {
          reportPct(100);
          return result;
        });
      });
    })
    .catch(function (e) {
      // A stalled or vanished download leaves nothing worth keeping — a
      // partial track is useless and the torrent would sit there forever.
      untrackOrphan(hash);
      if (torrents[hash]) {
        return deleteTorrents([hash], true).then(function () {
          throw e;
        });
      }
      throw e;
    });
}

// What happens to the winning torrent once its file is delivered. "seed" is
// the default: safe for private-tracker ratios, and the rest of the release
// becomes an instant tier-1 hit. The result path stays valid in every branch —
// deleteFiles is never true here.
function finalizeDisposition(hash, torrent) {
  if (tier3Disposition === "import") {
    return importFinished([torrent])
      .catch(function (e) {
        console.error("qBittorrent: import after discovery failed:", e);
      })
      .then(function () {
        return deleteTorrents([hash], false);
      })
      .catch(function (e) {
        console.error("qBittorrent: could not remove the discovered torrent after import:", e);
      });
  }
  if (tier3Disposition === "remove") {
    return deleteTorrents([hash], false).catch(function (e) {
      console.error("qBittorrent: could not remove the discovered torrent:", e);
    });
  }
  return Promise.resolve(); // "seed" — leave it be
}

// --- Registration -------------------------------------------------------------

// What the last interactive search showed, so the pick can be resolved without
// re-searching. Keyed the way search rows are keyed everywhere else.
var interactiveMatches = {};
var interactiveQuery = "";

function pickFileForQuery(files, torrentName, query) {
  var hay = null;
  var best = null;
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    if (!mediaKindOf(list[i].name)) continue;
    hay = normalizeForMatch(String(list[i].name || "") + " " + String(torrentName || ""));
    if (containsAllTokens(hay, query)) {
      if (!best) best = list[i];
      else return null; // ambiguous — two files match the whole query
    }
  }
  if (best) return best;
  // No file carries the query. A torrent with exactly ONE media file is still
  // unambiguous; anything else needs the user to open it and choose.
  var media = [];
  for (var j = 0; j < list.length; j++) {
    if (mediaKindOf(list[j].name)) media.push(list[j]);
  }
  return media.length === 1 ? media[0] : null;
}

// Named for the same reason as the stream half: the Debug tab runs it raw.
function resolveDownloadByMetadata(title, artistName, albumName, durationSecs, format) {
  if (!connected || !baseUrl) {
    dbg("download: not connected to qBittorrent — decline");
    return Promise.resolve(null);
  }
  if (!filesAreReachable()) {
    api.log("warn", "download resolve declined: qBittorrent's files aren't reachable from this machine", "qbittorrent");
    dbg("download: qBittorrent's files aren't reachable on this machine — decline");
    return Promise.resolve(null);
  }
  var want = wantFromArgs(title, artistName, albumName, durationSecs);
  dbgCacheTarget("download:", want);
  var best = findTrackInTorrents(want, torrents, fileNamesByHash);
  if (best) {
    var bt = torrents[best.hash];
    dbg("download: [local cache] matched “" + best.name + "” in “" + ((bt && bt.name) || best.hash) + "” (score " + best.score.toFixed(2) + ")");
    return fetchExistingMatch(best, want).then(function (r) {
      if (r) return r;
      dbg("download: the existing match fell through" + (discoveryEnabled ? " — trying the qBittorrent app" : " and discovery is off — decline"));
      return discoveryEnabled ? discoverAndFetch(want, format) : null;
    });
  }
  dbg("download: [local cache] no match" + (discoveryEnabled ? " — moving to the qBittorrent app's search" : " and discovery is off — decline"));
  return discoveryEnabled ? discoverAndFetch(want, format) : Promise.resolve(null);
}

function registerDownloadProvider() {
  if (!api.downloads || typeof api.downloads.onResolveByMetadata !== "function") return;

  api.downloads.onResolveByMetadata("qbt-download", resolveDownloadByMetadata);

  if (typeof api.downloads.onInteractiveSearch === "function") {
    api.downloads.onInteractiveSearch("qbt-download", function (query, limit) {
      if (!connected || !baseUrl || !filesAreReachable()) return Promise.resolve([]);
      return collectSearchResults(query, { maxMs: RESOLVE_SEARCH_MAX_MS })
        .then(function (results) {
          var sorted = sortSearchResults(results || []);
          interactiveMatches = {};
          interactiveQuery = String(query || "");
          var out = [];
          for (var i = 0; i < sorted.length && out.length < (limit || 10); i++) {
            var r = sorted[i];
            if (isPluginNotice(r) || !r.fileUrl) continue;
            var id = searchResultId(r);
            interactiveMatches[id] = r;
            out.push({
              id: id,
              title: String(r.fileName || ""),
              // The row's second line — the download-relevant facts, since a
              // torrent has no artist field of its own.
              artistName: formatBytes(r.fileSize) + " · " + formatSeedCount(swarmCount(r.nbSeeders)) + " seeds · " + siteLabel(r.siteUrl),
              durationSecs: null
            });
          }
          return out;
        })
        .catch(function (e) {
          if (String(e && e.message) === "no-plugins") return [];
          throw e;
        });
    });
  }

  if (typeof api.downloads.onInteractiveResolve === "function") {
    api.downloads.onInteractiveResolve("qbt-download", function (matchId, format) {
      var r = interactiveMatches[String(matchId)];
      if (!r) throw new Error("That result is no longer available — search again");
      var query = interactiveQuery;
      return enqueueDiscovery(function () {
        resolveJob = { hashes: {}, startedAt: Date.now() };
        var before = shallowHashSet(torrents);
        var expected = null;
        var addedHash = null;
        return resolveWebFileUrl(r, webFetchFn)
          .then(function (resolved) {
            r = resolved;
            expected = magnetHash(r.fileUrl);
            return addTorrentRaw(r.fileUrl, { paused: true, downloader: downloaderFor(r) });
          })
          .then(function () {
            return waitForAddedTorrent(before, expected, r.fileName || "", 0, RESOLVE_ATTACH_ATTEMPTS);
          })
          .then(function (hash) {
            if (!hash) throw new Error("qBittorrent never registered that torrent");
            addedHash = hash;
            resolveJob.hashes[hash] = true;
            trackOrphan(hash);
            return waitForMetadataQuiet(hash, { maxMs: RESOLVE_META_MAX_MS });
          })
          .then(function (res) {
            if (!res.ok) throw new Error("Couldn't get that torrent's file list");
            return fetchFilesQuiet(addedHash);
          })
          .then(function (files) {
            var t = torrents[addedHash];
            var file = pickFileForQuery(files, (t && t.name) || "", query);
            if (!file) {
              throw new Error("Couldn't tell which file in that torrent is the track — add it from the Torrents view and choose the file there");
            }
            return commitCandidate({ hash: addedHash, files: files, file: file }, { title: query });
          })
          .catch(function (e) {
            if (addedHash && torrents[addedHash]) {
              untrackOrphan(addedHash);
              return deleteTorrents([addedHash], true).then(function () {
                throw e;
              });
            }
            throw e;
          })
          .then(
            function (result) {
              resolveJob = null;
              return result;
            },
            function (e) {
              resolveJob = null;
              throw e;
            }
          );
      });
    });
  }
}

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
    // The file's own tags when they're already cached — the read was started
    // when this list arrived. Read-only on purpose: rendering must never kick
    // off a probe, or scrolling a 2000-file torrent would probe 2000 files.
    var tags = kind && done && torrent ? tagsFor(torrent, f) : null;
    // A non-media file keeps its real filename: "cover" and "01" are what the
    // track parser would leave, which is useless when deciding whether to skip
    // something.
    var label = kind ? firstText([tags && tags.title, parsed.title, baseName(f.name)]) : baseName(f.name);
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
    var offered = fileRowActions(kind, done, skipped, filesAreReachable());
    items.push({
      id: String(f.index),
      // No "⊘"/"◌" prefix on the name any more: the tile carries the state in
      // colour and the subtitle says it in words, and a third copy glued to the
      // front of the filename only made the names harder to read.
      title: title,
      subtitle: subtitle,
      imageUrl: fileIconFor(f, torrent),
      // What this row can actually do — see fileRowActions for which, and why.
      actions: offered.actions,
      album: torrent ? torrent.name : undefined,
      action: offered.action,
      // Only a finished, reachable, PLAYABLE file gets a path — that is what
      // makes the host's right-click menu and drag-to-queue work on these rows.
      // Priority is irrelevant here: a downloaded file's bytes are on disk and
      // playable whether or not it is still selected.
      path: kind && done && filesAreReachable() ? qbtUri(hash, f.index) : null,
      artistName: kind ? firstText([tags && tags.artist, tags && tags.album_artist, parsed.artist]) : null,
      albumTitle: kind && torrent ? firstText([tags && tags.album, torrent.name]) : null
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
    if (hash) openTorrentContents(hash);
  });

  // A row in the "Matching files" list. The hash rides in the row id — the
  // plain row list reports only `itemId`, and a torrent hash is hex so the
  // colon framing cannot appear inside it.
  api.ui.onAction("qbt:open-match", function (data) {
    var id = String((data && data.itemId) || "");
    var m = /^qbtm:([^:]+):/.exec(id);
    if (m && torrents[m[1]]) openTorrentContents(m[1]);
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
    var hash = expandedHash;
    tracksForIndicesTagged(hash, indices).then(function (tracks) {
      if (!tracks.length) {
        api.ui.showNotification(unplayableReason(selectedFiles(hash, indices)));
        return;
      }
      var t = torrents[hash];
      api.playback.playTracks(tracks, 0, { name: (t && t.name) || "Torrent" });
    }).catch(function (e) {
      console.error("qBittorrent: could not play the selected files:", e);
    });
  });

  api.ui.onAction("qbt:file-download", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 1);
  });

  api.ui.onAction("qbt:file-skip", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 0);
  });

  api.ui.onAction("qbt:file-open", function (data) {
    openLocalFile(data, false);
  });
  api.ui.onAction("qbt:file-folder", function (data) {
    openLocalFile(data, true);
  });

  api.ui.onAction("qbt:list-filter", function (data) {
    listFilter = String((data && data.query) || "");
    // Typing is the demand signal: start (or keep) filling the name cache for
    // whatever the filter can't answer yet.
    pumpNameBurst();
    render();
  });

  api.ui.onAction("qbt:list-filter-clear", function () {
    listFilter = "";
    render();
  });

  api.ui.onAction("qbt:file-filter", function (data) {
    if (!expandedHash) return;
    fileFilters[expandedHash] = String((data && data.query) || "");
    render();
  });

  api.ui.onAction("qbt:file-filter-clear", function (data) {
    var hash = hashOf(data) || expandedHash;
    if (!hash) return;
    // Empty string, not delete: `undefined` means "never touched", which is
    // what lets the list filter pre-seed this box on open. A torrent the user
    // explicitly cleared has been touched — pre-seeding it again would replay
    // the very text they just dismissed.
    fileFilters[hash] = "";
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
  api.ui.onAction("qbt:debug-title", function (data) {
    debugFields.title = (data && data.value) || "";
  });
  api.ui.onAction("qbt:debug-artist", function (data) {
    debugFields.artist = (data && data.value) || "";
  });
  api.ui.onAction("qbt:debug-album", function (data) {
    debugFields.album = (data && data.value) || "";
  });
  api.ui.onAction("qbt:debug-stream", function () {
    runDebugResolve("stream");
  });
  api.ui.onAction("qbt:debug-stream-fetch", function () {
    runDebugResolve("stream-fetch");
  });
  api.ui.onAction("qbt:debug-download", function () {
    runDebugResolve("download");
  });
  api.ui.onAction("qbt:debug-clear", function () {
    debugLog = [];
    render();
  });
  api.ui.onAction("qbt:set-auto-fetch", function (data) {
    currentDraft().autoFetchFound = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:set-discovery", function (data) {
    currentDraft().discoveryEnabled = !!(data && (data.checked === undefined ? data.value : data.checked));
    renderSettings();
  });
  api.ui.onAction("qbt:set-disposition", function (data) {
    var v = (data && data.value) || "seed";
    currentDraft().tier3Disposition = v === "import" || v === "remove" ? v : "seed";
    renderSettings();
  });

  // Web indexer toggles act on the LIVE settings, not the draft — flipping a
  // site on shouldn't wait behind Save & connect, which also resets the
  // session. Same persistence path as everything else (persistSettings).
  var registerWebIndexerActions = function (def) {
    api.ui.onAction("qbt:webidx-" + def.id, function (data) {
      var on = !!(data && (data.checked === undefined ? data.value : data.checked));
      if (on) delete webIndexersDisabled[def.id];
      else webIndexersDisabled[def.id] = true;
      persistSettings();
      renderSettings();
      render();
    });
    api.ui.onAction("qbt:webdel-" + def.id, function () {
      for (var i = 0; i < customIndexers.length; i++) {
        if (customIndexers[i].id === def.id) {
          customIndexers.splice(i, 1);
          break;
        }
      }
      delete webIndexersDisabled[def.id];
      persistSettings();
      renderSettings();
      render();
    });
    api.ui.onAction("qbt:webview-" + def.id, function () {
      // The live definition (bundled or custom) into the box, to read, copy,
      // or tweak-and-re-Add under a new id.
      webIndexerDraft = JSON.stringify(webDefById(def.id) || def, null, 2);
      renderSettings();
    });
  };
  for (var wd = 0; wd < WEB_DEFS.length; wd++) registerWebIndexerActions(WEB_DEFS[wd]);
  for (var cd = 0; cd < customIndexers.length; cd++) registerWebIndexerActions(customIndexers[cd]);
  registerCustomIndexerActions = registerWebIndexerActions;

  api.ui.onAction("qbt:web-draft", function (data) {
    webIndexerDraft = (data && data.value) || "";
  });

  api.ui.onAction("qbt:web-add", function () {
    var text = webIndexerDraft.trim();
    if (!text) {
      api.ui.showNotification("Paste an indexer definition first");
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      api.ui.showNotification("That isn't valid JSON: " + errText(e));
      return;
    }
    // One definition or an array of them — importing several at once is the
    // same path, so a box filled by "Export all" round-trips straight back in.
    var incoming = Object.prototype.toString.call(parsed) === "[object Array]" ? parsed : [parsed];
    if (!incoming.length) {
      api.ui.showNotification("Nothing to add");
      return;
    }
    var taken = {};
    var all = WEB_DEFS.concat(customIndexers);
    for (var i = 0; i < all.length; i++) taken[all[i].id] = true;
    // Re-importing an EXISTING id replaces that definition rather than being
    // rejected as a duplicate — that is how you edit one via View JSON.
    var accepted = [];
    for (var d = 0; d < incoming.length; d++) {
      var def = incoming[d];
      var replacing = def && customIndexers.some(function (c) { return c.id === def.id; });
      var checkAgainst = {};
      for (var k in taken) if (!(replacing && k === def.id)) checkAgainst[k] = true;
      var problems = validateIndexerDef(def, checkAgainst);
      if (problems.length) {
        api.ui.showNotification("“" + ((def && def.name) || (def && def.id) || "definition " + (d + 1)) + "”: " + problems.slice(0, 2).join(" · "));
        return; // all-or-nothing: a bad one in the batch aborts, box kept
      }
      accepted.push({ def: def, replacing: replacing });
      taken[def.id] = true;
    }
    for (var a = 0; a < accepted.length; a++) {
      var it = accepted[a];
      if (it.replacing) {
        for (var r = 0; r < customIndexers.length; r++) {
          if (customIndexers[r].id === it.def.id) {
            customIndexers[r] = it.def;
            break;
          }
        }
      } else {
        customIndexers.push(it.def);
        registerWebIndexerActions(it.def);
      }
    }
    webIndexerDraft = "";
    persistSettings();
    api.ui.showNotification(
      accepted.length === 1
        ? (accepted[0].replacing ? "Updated “" : "Added “") + accepted[0].def.name + "” — it joins every search from now on"
        : "Imported " + accepted.length + " indexers"
    );
    renderSettings();
    render();
  });

  api.ui.onAction("qbt:web-export", function () {
    // Every indexer — bundled and custom — as an array, ready to copy out or
    // paste back in. The full set is what makes it a backup.
    webIndexerDraft = JSON.stringify(WEB_DEFS.concat(customIndexers), null, 2);
    renderSettings();
  });

  api.ui.onAction("qbt:web-clear", function () {
    webIndexerDraft = "";
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
// restriction on, is only this plugin's own torrents, and with the list filter
// typed, only the rows it shows. "Stop all" over a filter for one release must
// not halt the other hundred transfers sitting off-screen.
function hashesInView() {
  var filtered = filterTorrentList(visibleTorrents(), listFilter, fileNamesByHash);
  var out = [];
  for (var i = 0; i < filtered.shown.length; i++) out.push(filtered.shown[i].torrent.hash);
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
  registerMetadataStreamResolver();
  registerDownloadProvider();
  registerContextMenu();
  render();
  renderSettings();

  loadSettings()
    .then(function () {
      // Custom indexer definitions restored from storage need their toggle /
      // remove handlers — registerActions ran before settings existed.
      if (registerCustomIndexerActions) {
        for (var ci = 0; ci < customIndexers.length; ci++) registerCustomIndexerActions(customIndexers[ci]);
      }
    })
    .then(loadNamesCache)
    .then(loadOrphans)
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
  // A headless search job (the discovery engine's) holds server resources
  // exactly like the tab's — dispose of it the same way.
  if (headlessSearchJobId != null) {
    var strandedHeadless = headlessSearchJobId;
    headlessSearchJobId = null;
    disposeSearch(strandedHeadless).catch(function (e) {
      console.error("qBittorrent: could not dispose of the discovery search job on deactivate:", e);
    });
  }
  // A debounced name-cache write still waiting its 2s must land before the
  // api handle is gone — otherwise the last burst of a session is refetched
  // next time, which is exactly what the cache exists to prevent.
  if (namesPersistTimer) {
    clearTimeout(namesPersistTimer);
    namesPersistTimer = null;
    persistNames();
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
  _categoryFilterActive: categoryFilterActive,
  _nextPreviousCategory: nextPreviousCategory,
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
  _fileRowActions: fileRowActions,
  _parentDir: parentDir,
  _fileUrlFor: fileUrlFor,
  _unplayableReason: unplayableReason,
  _mergeFileTrack: mergeFileTrack,
  _firstText: firstText,
  _firstNum: firstNum,
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
  _matchingNames: matchingNames,
  _filterTorrentList: filterTorrentList,
  _fileMatchNote: fileMatchNote,
  _fileMatchItems: fileMatchItems,
  _normalizeForMatch: normalizeForMatch,
  _containsAllTokens: containsAllTokens,
  _titleMatchScore: titleMatchScore,
  _findTrackInTorrents: findTrackInTorrents,
  _confirmByTags: confirmByTags,
  _MATCH_THRESHOLD: MATCH_THRESHOLD,
  _filterTier3Candidates: filterTier3Candidates,
  _scoreSearchCandidate: scoreSearchCandidate,
  _rankTier3Candidates: rankTier3Candidates,
  _formatKeywordScore: formatKeywordScore,
  _detectResolveStall: detectResolveStall,
  _resolvePercent: resolvePercent,
  _isResolveOrphan: isResolveOrphan,
  _pickFileForTrack: pickFileForTrack,
  _pickFileForQuery: pickFileForQuery,
  _discoveryQueries: discoveryQueries,
  _decodeEntities: decodeEntities,
  _parseHtml: function (text) { return parseMarkup(text, true); },
  _parseXml: function (text) { return parseMarkup(text, false); },
  _nodeText: nodeText,
  _parseSelector: parseSelector,
  _selectAll: selectAll,
  _selectFirst: selectFirst,
  _childByTag: childByTag,
  _parseSize: parseSize,
  _applyFilters: applyFilters,
  _jsonPath: jsonPath,
  _buildSearchUrl: buildSearchUrl,
  _buildMagnet: buildMagnet,
  _runDefOnBody: runDefOnBody,
  _validateIndexerDef: validateIndexerDef,
  _webSearchAll: webSearchAll,
  _resolveWebFileUrl: resolveWebFileUrl,
  _downloaderFor: downloaderFor,
  _WEB_DEFS: WEB_DEFS,
  _resolveBudgets: {
    searchMaxMs: RESOLVE_SEARCH_MAX_MS,
    attachAttempts: RESOLVE_ATTACH_ATTEMPTS,
    attachPollMs: ATTACH_POLL_MS,
    metaMaxMs: RESOLVE_META_MAX_MS,
    maxCandidates: RESOLVE_MAX_CANDIDATES,
    stallMs: RESOLVE_STALL_MS,
    maxMs: RESOLVE_MAX_MS,
    orphanMaxMs: ORPHAN_MAX_MS
  },
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
