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
var serverState = {};
var rid = 0;
var connected = false;
var lastError = null;
var busy = null; // hash currently mid-action, for button disabling
var pendingDelete = null; // hash awaiting delete confirmation

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
// Seconds spent waiting on each torrent's metadata. A magnet can take a minute,
// and a counter that climbs is the one honest answer to "is this still working?"
// — the same reason the host's download modal always shows elapsed time.
var metadataElapsed = {};
// True from pressing Add/View contents until the torrent has been matched to a
// row. Before that there is no row to put a message on, so the view carries one.
var preparingAdd = false;
var preparingElapsed = 0;
// The metadata preview ("download window"). null = closed.
var preview = null;
// Whether this qBittorrent has /torrents/fetchMetadata at all: null unknown,
// false = probed and absent (every release up to 5.2.3), true = present.
var metadataPreviewSupported = null;

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
var activeTab = "downloading";
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

// Read the file list out of a /torrents/fetchMetadata response.
//
// Shape (qBittorrent's serializeTorrentInfo): { infohash_v1, infohash_v2, id,
// info: { name, length, files: [{ path, length }] } }. Three answers are
// possible and only one is the real one:
//   - {}                       still fetching, ask again
//   - only the infohash keys   metadata not complete yet, ask again
//   - info.files present       done
//
// File entries carry NO index: their position in the array IS the file index
// that /torrents/filePrio takes, which is what makes a selection made here
// applicable after the torrent is added.
function parseMetadataPreview(data) {
  if (!data || typeof data !== "object") return null;
  var info = data.info;
  if (!info || !info.files || !info.files.length) return null;
  var files = [];
  for (var i = 0; i < info.files.length; i++) {
    var f = info.files[i] || {};
    files.push({ index: i, name: String(f.path || ""), size: Number(f.length || 0), progress: 0, priority: 1 });
  }
  return {
    name: String(info.name || ""),
    totalSize: Number(info.length || 0),
    files: files,
    hash: String(data.id || data.hash || data.infohash_v1 || "").toLowerCase() || null
  };
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

// Split a torrent's files into the audio and everything else, by file index.
// Video counts as "other": on a music release a video extra is usually the bulk
// of the download and the thing being skipped.
function partitionAudio(files) {
  var audio = [];
  var others = [];
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!f || typeof f.index !== "number") continue;
    if (mediaKindOf(f.name) === "audio") audio.push(f.index);
    else others.push(f.index);
  }
  return { audio: audio, others: others };
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

function searchResultSubtitle(r) {
  var bits = [formatBytes(r && r.fileSize)];
  bits.push(Number((r && r.nbSeeders) || 0) + " seeders");
  var leech = Number((r && r.nbLeechers) || 0);
  if (leech) bits.push(leech + " leechers");
  var site = siteLabel(r && r.siteUrl);
  if (site) bits.push(site);
  return bits.join("  ·  ");
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
    return Number(b.added_on || 0) - Number(a.added_on || 0);
  });
  return list;
}

function tabTorrents(tab) {
  var all = visibleTorrents();
  if (tab === "all") return all;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var done = isComplete(all[i]);
    if (tab === "completed" ? done : !done) out.push(all[i]);
  }
  return out;
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
// Shared by the paused-selection flow and the preview's add, which both need the
// hash before they can do anything else.
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
  activeTab = "downloading";

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
      return settle.then(function () {
        return fetchFiles(hash);
      }).then(function () {
        api.ui.showNotification("Ready — choose which files to download, then press Start");
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
  var expectedHash = holdForSelection ? magnetHash(uri) : null;
  if (category) form.category = category;
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
      activeTab = "downloading";
      render();
      return refresh().then(function () {
        if (holdForSelection) return beginSelection(knownBefore, expectedHash, 0, peek, nameHint);
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

// --- Metadata preview (the real "download window") --------------------------

var PREVIEW_POLL_MS = 1500;
var PREVIEW_MAX_MS = 60000;

// Ask qBittorrent what is inside a torrent WITHOUT adding it.
//
// /torrents/fetchMetadata exists on qBittorrent master but is in no release as
// of 5.2.3, so this is strictly opportunistic: the first 404/405 marks it
// unsupported for the session and every caller falls back to adding paused.
// Anything else is a real error and is reported as one.
function fetchMetadataPreview(source, elapsed) {
  if (metadataPreviewSupported === false) return Promise.resolve({ unsupported: true });
  return authed("/torrents/fetchMetadata", { method: "POST", form: { source: source } })
    .then(function (resp) {
      if (resp.status === 404 || resp.status === 405) {
        metadataPreviewSupported = false;
        return { unsupported: true };
      }
      if (resp.status < 200 || resp.status >= 300) {
        return resp.text().then(function (body) {
          throw new Error(String(body || "").trim() || "HTTP " + resp.status);
        });
      }
      metadataPreviewSupported = true;
      return resp.json().then(function (data) {
        var parsed = parseMetadataPreview(data);
        if (parsed) return { preview: parsed };
        // Empty object or infohash-only: still fetching from the swarm.
        if ((elapsed || 0) >= PREVIEW_MAX_MS) {
          throw new Error("Timed out waiting for this torrent's metadata");
        }
        if (preview) {
          preview.elapsed = (elapsed || 0) + PREVIEW_POLL_MS;
          render();
        }
        return delay(PREVIEW_POLL_MS).then(function () {
          // Abandoned while we waited.
          if (!preview || preview.source !== source) return { cancelled: true };
          return fetchMetadataPreview(source, (elapsed || 0) + PREVIEW_POLL_MS);
        });
      });
    });
}

function openPreview(source, nameHint) {
  preview = {
    source: source,
    name: nameHint || "",
    files: null,
    skipped: {},
    elapsed: 0,
    error: null,
    adding: false
  };
  activeTab = "search";
  render();

  return fetchMetadataPreview(source, 0)
    .then(function (result) {
      if (!preview || preview.source !== source) return null; // cancelled
      if (result.cancelled) return null;
      if (result.unsupported) {
        // No preview endpoint on this qBittorrent: fall back to the flow that
        // works everywhere — add it paused and show the contents from there.
        preview = null;
        render();
        api.ui.showNotification("This qBittorrent can't preview a torrent, so it's being added paused instead");
        return addTorrent(source, { peek: true, name: nameHint });
      }
      preview.files = result.preview.files;
      preview.name = result.preview.name || preview.name;
      preview.totalSize = result.preview.totalSize;
      render();
      return null;
    })
    .catch(function (e) {
      console.error("qBittorrent: metadata preview failed:", e);
      if (preview && preview.source === source) {
        preview.error = errText(e);
        render();
      }
    });
}

// Add what the preview showed, applying the choices made before anything was
// added at all. Paused first, then priorities, then start — priorities cannot be
// set on a torrent that does not exist yet, so this order is forced.
function addFromPreview() {
  if (!preview || !preview.files || preview.adding) return Promise.resolve();
  var kept = [];
  var skipped = [];
  for (var i = 0; i < preview.files.length; i++) {
    if (preview.skipped[preview.files[i].index]) skipped.push(preview.files[i].index);
    else kept.push(preview.files[i].index);
  }
  if (!kept.length) {
    api.ui.showNotification("Everything is set to skip — include at least one file");
    return Promise.resolve();
  }

  preview.adding = true;
  render();

  var source = preview.source;
  var nameHint = preview.name;
  var knownBefore = shallowHashSet(torrents);
  var expectedHash = magnetHash(source);
  var form = {
    urls: source,
    sequentialDownload: "true",
    firstLastPiecePrio: "true",
    paused: "true",
    stopped: "true"
  };
  if (category) form.category = category;
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
      if (/^fails\.?$/i.test(String(body || "").trim())) {
        throw new Error("qBittorrent refused it — it may already be in the list");
      }
      return refresh();
    })
    .then(function () {
      return waitForAddedTorrent(knownBefore, expectedHash, nameHint, 0);
    })
    .then(function (hash) {
      if (!hash) throw new Error("Added, but qBittorrent didn't register it in time");
      // Skips first, then start: starting before the priorities land would pull
      // pieces of files the user just excluded, which is the whole thing this
      // flow exists to avoid.
      var applied = skipped.length
        ? authed("/torrents/filePrio", { method: "POST", form: { hash: hash, id: skipped.join("|"), priority: 0 } })
        : Promise.resolve(null);
      return applied.then(function () {
        return actOn(startEndpoint(), [hash], "Starting the download");
      });
    })
    .then(function () {
      preview = null;
      activeTab = "downloading";
      api.ui.showNotification(
        skipped.length ? "Downloading " + kept.length + " of " + (kept.length + skipped.length) + " files" : "Download started"
      );
      render();
      return refresh();
    })
    .catch(function (e) {
      console.error("qBittorrent: adding from the preview failed:", e);
      if (preview) {
        preview.adding = false;
        preview.error = errText(e);
      }
      render();
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
  addTorrent(r.fileUrl, { peek: !!(opts && opts.peek), name: r.fileName });
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
  var finished = detectCompletions(knownComplete, list);
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
      // `index` is only present from WebAPI 2.8.2 on; before that a file's
      // position in this array IS its index, which is what the file-priority and
      // download-selection endpoints take. Falling back to the position keeps
      // playback working on older servers instead of building qbt://…/NaN.
      var files = [];
      for (var i = 0; i < (list || []).length; i++) {
        var f = list[i] || {};
        files.push({
          index: typeof f.index === "number" ? f.index : i,
          name: f.name,
          size: f.size,
          progress: f.progress,
          // 0 means "don't download this one". Everything else is a download
          // priority (1 normal, 6 high, 7 maximum) — the plugin only ever sets
          // 0 or 1, but it must not flatten a priority the user set in
          // qBittorrent itself, so the raw value is kept.
          priority: typeof f.priority === "number" ? f.priority : 1
        });
      }
      filesByHash[hash] = files;
      return files;
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

// Include or exclude files from the download (qBittorrent's per-file priority;
// 0 = don't download).
//
// Only ever sets 0 or 1: this is a two-state control, and writing a high/maximum
// priority the user had set in qBittorrent back down to normal would quietly
// undo their own tuning.
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
      return refresh();
    });
}

function ensureFiles(hash) {
  if (filesByHash[hash]) return Promise.resolve(filesByHash[hash]);
  return fetchFiles(hash);
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

function deleteTorrent(hash, deleteFiles) {
  busy = hash;
  render();
  return authed("/torrents/delete", {
    method: "POST",
    form: { hashes: hash, deleteFiles: deleteFiles ? "true" : "false" }
  })
    .then(function (resp) {
      expectOk(resp, "Removing the torrent");
      // Drop it locally rather than waiting a poll cycle — the row vanishing IS
      // the feedback for a destructive action.
      delete torrents[hash];
      delete pendingSelection[hash];
      delete peekedTorrents[hash];
      delete filesByHash[hash];
    })
    .catch(function (e) {
      console.error("qBittorrent: delete failed:", e);
      api.ui.showNotification("Couldn't remove that torrent: " + errText(e));
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

function torrentNode(t) {
  var pct = Math.round(Math.min(1, Math.max(0, Number(t.progress) || 0)) * 1000) / 10;
  var paused = isPaused(t);
  var done = isComplete(t);
  var rowBusy = busy === t.hash || busy === "*";

  var facts = [torrentStateLabel(t.state), formatBytes(t.size)];
  if (!done) {
    facts.push("↓ " + formatSpeed(t.dlspeed));
    facts.push("ETA " + formatEta(t.eta));
  } else {
    facts.push("↑ " + formatSpeed(t.upspeed));
    facts.push("ratio " + (Number(t.ratio) || 0).toFixed(2));
  }
  facts.push(Number(t.num_seeds || 0) + " seeds");

  var open = expandedHash === t.hash;
  var reachable = filesAreReachable();
  var awaiting = !!pendingSelection[t.hash];
  var peeked = !!peekedTorrents[t.hash];
  var buttons = [];

  // A torrent held for selection leads with the one thing to do next, and its
  // Start button says what it starts — "Start" alone reads as "resume", which is
  // not what is being decided here.
  if (awaiting) {
    buttons.push({
      type: "button",
      label: metadataFetching[t.hash] || !filesByHash[t.hash] ? "Waiting for the file list…" : "Start download",
      action: "qbt:start-selected",
      variant: "accent",
      // Nothing to choose from yet, so nothing to confirm yet.
      disabled: rowBusy || !!metadataFetching[t.hash] || !filesByHash[t.hash],
      data: { hash: t.hash }
    });
    // A peeked torrent was added only to be looked at, so throwing it away is a
    // first-class button rather than the generic "Remove…" further along the
    // row. It skips the confirm — nothing has downloaded, so there is nothing
    // to lose.
    if (peeked) {
      buttons.push({
        type: "button",
        label: "Discard",
        action: "qbt:discard-peek",
        variant: "secondary",
        disabled: rowBusy,
        data: { hash: t.hash }
      });
    }
  }

  // Play is offered only when the files are reachable from this machine —
  // qBittorrent on a NAS reports ITS paths, which mean nothing here. Hidden
  // rather than disabled: a permanently dead button on every row is noise, and
  // the Files list explains the situation once, where it's relevant.
  if (reachable && Number(t.progress) > 0) {
    buttons.push({
      type: "button",
      label: "Play",
      action: "qbt:play-torrent",
      variant: "accent",
      disabled: rowBusy,
      data: { hash: t.hash }
    });
  }
  buttons.push({
    type: "button",
    label: open ? "Hide files" : "Files",
    action: "qbt:toggle-files",
    variant: "secondary",
    data: { hash: t.hash }
  });
  // Only when the files actually sit inside a collection — a scan of a folder
  // the library doesn't cover would do nothing and look broken.
  if (done && collectionForTorrent(t)) {
    buttons.push({
      type: "button",
      label: "Add to library",
      action: "qbt:import",
      variant: "secondary",
      disabled: rowBusy,
      data: { hash: t.hash }
    });
  }
  buttons.push({
    type: "button",
    label: paused ? "Start" : "Stop",
    action: paused ? "qbt:start" : "qbt:stop",
    variant: "secondary",
    disabled: rowBusy,
    data: { hash: t.hash }
  });
  buttons.push({
    type: "button",
    label: "Remove…",
    action: "qbt:delete-ask",
    variant: "secondary",
    disabled: rowBusy,
    data: { hash: t.hash }
  });

  var children = [
    { type: "text", content: facts.join("  ·  "), className: "muted" },
    { type: "progress-bar", value: pct, max: 100, label: pct.toFixed(1) + "%" },
    { type: "layout", direction: "horizontal", children: buttons }
  ];

  if (open) {
    if (!reachable) {
      children.push({
        type: "text",
        className: "ds-banner ds-banner--warning",
        content:
          "qBittorrent looks like it's on another machine, so these files aren't on this one. " +
          "If its download folder is mounted here, set the path mapping in Settings → qBittorrent and they'll play."
      });
    }
    // "Only the audio" is the one bulk choice a music app can make confidently,
    // and it is the reason most people open this list: a release full of video
    // extras, scans and samples where only the tracks are wanted. Offered only
    // while there is still something to download — after that it would only
    // stop seeding files already on disk.
    var loaded = filesByHash[t.hash];
    if (loaded && !done) {
      var audioCount = 0;
      var otherCount = 0;
      for (var fi = 0; fi < loaded.length; fi++) {
        if (mediaKindOf(loaded[fi].name) === "audio") audioCount++;
        else otherCount++;
      }
      if (audioCount && otherCount) {
        children.push({
          type: "button",
          label: "Download only the audio (skip " + otherCount + " other file" + (otherCount === 1 ? "" : "s") + ")",
          action: "qbt:only-audio",
          variant: "secondary",
          disabled: rowBusy,
          data: { hash: t.hash }
        });
      }
    }
    var rows = fileRowsNode(t.hash);
    if (rows) children.push(rows);
  }

  if (awaiting) {
    children.unshift({
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
  }

  if (isErrored(t)) {
    children.unshift({ type: "text", content: "This torrent is in an error state in qBittorrent.", className: "error" });
  }

  return { type: "section", title: t.name || magnetDisplayName(t.magnet_uri) || t.hash, children: children };
}

// Two outcomes only, and the cancel side must be the harmless one: the host
// fires `cancelAction` on Escape as well as on the button, so anything
// destructive there would be triggered by the universal "get me out of this"
// key. Removing keeps the files — deleting them from disk is not offered here,
// because the safe default is the one that a mis-click can't cost you data.
function deleteConfirmNode(hash) {
  var t = torrents[hash];
  return {
    type: "confirm",
    title: "Remove torrent",
    message:
      "Remove “" + ((t && t.name) || hash) + "” from qBittorrent?\n\n" +
      "The downloaded files stay on disk — this only stops the transfer and drops it from the list.",
    confirmLabel: "Remove",
    cancelLabel: "Cancel",
    confirmVariant: "danger",
    confirmAction: "qbt:delete-confirm",
    cancelAction: "qbt:delete-cancel",
    data: { hash: hash }
  };
}

function render() {
  if (!api) return;

  if (pendingDelete) {
    api.ui.setViewData(VIEW_ID, deleteConfirmNode(pendingDelete));
    return;
  }

  var children = [];
  var banner = statusBanner();
  if (banner) children.push(banner);

  // Nothing configured (or a host that can't do the auth): the view's whole job
  // is to get the user set up, so it shows the steps rather than an empty list.
  if (!baseUrl || hostTooOld) {
    children.push(setupGuideNode());
    children.push({ type: "button", label: "Open settings", action: "qbt:open-settings", variant: "accent" });
    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children });
    return;
  }

  var counts = {
    downloading: tabTorrents("downloading").length,
    completed: tabTorrents("completed").length,
    all: tabTorrents("all").length
  };

  children.push({
    type: "tabs",
    activeTab: activeTab,
    action: "qbt:tab",
    tabs: [
      { id: "downloading", label: "Downloading", count: counts.downloading },
      { id: "completed", label: "Completed", count: counts.completed },
      { id: "all", label: "All", count: counts.all },
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

  children.push({
    type: "search-input",
    placeholder: "Paste a magnet link or .torrent URL",
    action: "qbt:add",
    buttonLabel: "Add",
    pasteButton: true
  });

  children.push({
    type: "stats-grid",
    items: [
      { label: "Download", value: formatSpeed(serverState.dl_info_speed) },
      { label: "Upload", value: formatSpeed(serverState.up_info_speed) },
      { label: "Free space", value: formatBytes(serverState.free_space_on_disk) },
      { label: "Torrents", value: counts.all }
    ]
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

  var list = tabTorrents(activeTab);
  if (!list.length) {
    children.push({
      type: "text",
      content: connected
        ? activeTab === "downloading"
          ? "Nothing downloading."
          : activeTab === "completed"
            ? "Nothing finished yet."
            : restrictToCategory && category
              ? "No torrents in the “" + category + "” category yet. Paste a magnet link above, or turn off “Only manage my own category” in settings to see everything."
              : "No torrents."
        : "Not connected to qBittorrent."
    });
  } else {
    for (var i = 0; i < list.length; i++) children.push(torrentNode(list[i]));
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
  return (data && data.hash) || null;
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
        return "file://" + path;
      });
    });
  });
}

// The download window: a torrent's contents, before it exists in qBittorrent.
function previewNodes() {
  var children = [];
  var title = preview.name || "this torrent";

  if (preview.error) {
    children.push({ type: "text", className: "ds-banner ds-banner--error", content: preview.error });
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "Add it paused instead", action: "qbt:preview-fallback", variant: "accent" },
        { type: "button", label: "Cancel", action: "qbt:preview-cancel", variant: "secondary" }
      ]
    });
    return children;
  }

  if (!preview.files) {
    children.push({
      type: "loading",
      message: "Reading what's inside " + title +
        (preview.elapsed >= 5000 ? " (" + Math.round(preview.elapsed / 1000) + "s)" : "") +
        " — nothing has been added to qBittorrent."
    });
    children.push({ type: "button", label: "Cancel", action: "qbt:preview-cancel", variant: "secondary" });
    return children;
  }

  var keptCount = 0;
  var keptBytes = 0;
  var items = [];
  var hasOther = false;
  var hasAudio = false;
  for (var i = 0; i < preview.files.length; i++) {
    var f = preview.files[i];
    var kind = mediaKindOf(f.name);
    if (kind === "audio") hasAudio = true;
    else hasOther = true;
    var skip = !!preview.skipped[f.index];
    if (!skip) {
      keptCount++;
      keptBytes += f.size;
    }
    var parsed = parseFileTrack(f.name);
    var label = kind ? parsed.title : String(f.name).replace(/\\/g, "/").split("/").pop();
    items.push({
      id: String(f.index),
      title: (skip ? "⊘ " : "") + label,
      subtitle: formatBytes(f.size) + (skip ? " · skipping" : "")
    });
  }

  children.push({ type: "section", title: title, children: [
    {
      type: "stats-grid",
      items: [
        { label: "Files", value: preview.files.length },
        { label: "Downloading", value: keptCount },
        { label: "Size", value: formatBytes(keptBytes) },
        { label: "Full size", value: formatBytes(preview.totalSize) }
      ]
    },
    {
      type: "text",
      className: "ds-banner ds-banner--warning",
      content: "Nothing has been added to qBittorrent yet. Pick what you want, then press Add and start."
    }
  ]});

  if (hasAudio && hasOther) {
    children.push({
      type: "button",
      label: "Only the audio",
      action: "qbt:preview-only-audio",
      variant: "secondary",
      disabled: preview.adding
    });
  }

  children.push({
    type: "track-row-list",
    items: items,
    numbered: true,
    selectable: true,
    actions: [
      { id: "qbt:preview-include", label: "Download this file", icon: "↓" },
      { id: "qbt:preview-skip", label: "Don't download this file", icon: "⊘" }
    ]
  });

  children.push({
    type: "layout",
    direction: "horizontal",
    children: [
      {
        type: "button",
        label: preview.adding ? "Adding…" : "Add and start",
        action: "qbt:preview-add",
        variant: "accent",
        disabled: preview.adding || !keptCount
      },
      { type: "button", label: "Cancel", action: "qbt:preview-cancel", variant: "secondary", disabled: preview.adding }
    ]
  });
  return children;
}

function searchTabNodes() {
  // The preview takes over the tab: it is a decision to make, not something to
  // read alongside a list of other results.
  if (preview) return previewNodes();
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
        content: "Search the indexers you've enabled in qBittorrent, and add what you find straight to the queue.",
        className: "muted"
      });
    }
    return children;
  }

  children.push({
    type: "text",
    content: searchResults.length + " results" + (searchStopped ? " — stopped early" : ""),
    className: "muted"
  });

  // One section per result, with buttons that are ALWAYS visible.
  //
  // These were rows in a track-row-list, whose buttons only appear on hover and
  // whose plain click does nothing at all — the host's selectable list treats a
  // single click as "select this row" and fires the row's action only on
  // double-click. So clicking a result looked broken, which is exactly what it
  // was reported as. Buttons you can see beat a compact list.
  for (var i = 0; i < searchResults.length; i++) {
    var r = searchResults[i];
    var id = searchResultId(r);
    children.push({
      type: "section",
      title: r.fileName || "(untitled)",
      children: [
        { type: "text", content: searchResultSubtitle(r), className: "muted" },
        {
          type: "layout",
          direction: "horizontal",
          children: [
            {
              type: "button",
              label: "Add to qBittorrent",
              action: "qbt:search-add",
              variant: "accent",
              data: { itemId: id }
            },
            {
              type: "button",
              label: "View contents",
              action: "qbt:search-view",
              variant: "secondary",
              data: { itemId: id }
            }
          ]
        }
      ]
    });
  }
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
  var all = files.slice();
  if (!all.length) {
    return { type: "text", content: "qBittorrent hasn't got this torrent's file list yet.", className: "muted" };
  }

  all.sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  var items = [];
  for (var j = 0; j < all.length; j++) {
    var f = all[j];
    var kind = mediaKindOf(f.name);
    var done = Number(f.progress) >= 1;
    var skipped = Number(f.priority) === 0;
    var parsed = parseFileTrack(f.name);
    // A non-media file keeps its real filename: "cover" and "01" are what the
    // track parser would leave, which is useless when deciding whether to skip
    // something.
    var label = kind ? parsed.title : String(f.name || "").replace(/\\/g, "/").split("/").pop();
    var subtitle = formatBytes(f.size);
    if (skipped) subtitle += " · not downloading";
    else if (!done) subtitle += " · " + Math.round(Number(f.progress || 0) * 100) + "% downloaded";
    items.push({
      id: String(f.index),
      // An unfinished file stays visible but is marked, so the list shows the
      // whole torrent rather than appearing to be missing tracks. A skipped one
      // is marked differently again — it is not coming unless you say so.
      title: (skipped ? "⊘ " : done ? "" : "◌ ") + label,
      subtitle: subtitle,
      album: torrent ? torrent.name : undefined,
      action: kind && done ? "qbt:play-file" : undefined,
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
  return {
    type: "track-row-list",
    items: items,
    numbered: true,
    selectable: true,
    actions: [
      { id: "qbt:play-file", label: "Play", icon: "▶" },
      { id: "qbt:enqueue-file", label: "Add to queue", icon: "+" },
      { id: "qbt:file-download", label: "Download this file", icon: "↓" },
      { id: "qbt:file-skip", label: "Don't download this file", icon: "⊘" }
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
    activeTab = (data && data.tabId) || (data && data.id) || activeTab;
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
    // One at a time: the fallback path adds a real (paused) torrent, and doing
    // that to a whole selection would leave a pile of them to clean up.
    var r = findSearchResult(ids[0]);
    if (!r || !r.fileUrl) {
      addSearchResult(ids[0], { peek: true });
      return;
    }
    openPreview(r.fileUrl, r.fileName);
  });

  api.ui.onAction("qbt:preview-include", function (data) {
    if (!preview) return;
    var idx = rowIndices(data);
    for (var i = 0; i < idx.length; i++) delete preview.skipped[idx[i]];
    render();
  });

  api.ui.onAction("qbt:preview-skip", function (data) {
    if (!preview) return;
    var idx = rowIndices(data);
    for (var i = 0; i < idx.length; i++) preview.skipped[idx[i]] = true;
    render();
  });

  api.ui.onAction("qbt:preview-only-audio", function () {
    if (!preview || !preview.files) return;
    var split = partitionAudio(preview.files);
    preview.skipped = {};
    for (var i = 0; i < split.others.length; i++) preview.skipped[split.others[i]] = true;
    render();
  });

  api.ui.onAction("qbt:preview-add", function () {
    addFromPreview();
  });

  api.ui.onAction("qbt:preview-fallback", function () {
    if (!preview) return;
    var source = preview.source;
    var name = preview.name;
    preview = null;
    render();
    addTorrent(source, { peek: true, name: name });
  });

  api.ui.onAction("qbt:preview-cancel", function () {
    // Nothing was added, so there is nothing to undo.
    preview = null;
    render();
  });

  api.ui.onAction("qbt:start", function (data) {
    var hash = hashOf(data);
    if (hash) {
      // Starting by hand ends the selection hold — the user has decided.
      delete pendingSelection[hash];
      delete peekedTorrents[hash];
      actOn(startEndpoint(), [hash], "Starting the torrent");
    }
  });

  api.ui.onAction("qbt:discard-peek", function (data) {
    var hash = hashOf(data);
    if (!hash) return;
    delete pendingSelection[hash];
    delete peekedTorrents[hash];
    delete metadataFetching[hash];
    if (expandedHash === hash) expandedHash = null;
    // deleteFiles is false: a peek downloads no content, and this must never be
    // a route to deleting data the user already had.
    deleteTorrent(hash, false);
  });

  api.ui.onAction("qbt:start-selected", function (data) {
    var hash = hashOf(data);
    if (!hash) return;
    delete pendingSelection[hash];
    delete peekedTorrents[hash];
    var files = filesByHash[hash] || [];
    var kept = 0;
    for (var i = 0; i < files.length; i++) {
      if (Number(files[i].priority) !== 0) kept++;
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
    var hash = hashOf(data);
    if (hash) actOn(stopEndpoint(), [hash], "Stopping the torrent");
  });

  api.ui.onAction("qbt:start-all", function () {
    actOn(startEndpoint(), hashesInView(), "Starting the torrents");
  });

  api.ui.onAction("qbt:stop-all", function () {
    actOn(stopEndpoint(), hashesInView(), "Stopping the torrents");
  });

  api.ui.onAction("qbt:toggle-files", function (data) {
    var hash = hashOf(data);
    if (!hash) return;
    expandedHash = expandedHash === hash ? null : hash;
    render();
    if (expandedHash) ensureFiles(hash);
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
    var hash = hashOf(data);
    if (hash) playFiles(hash, null);
  });

  api.ui.onAction("qbt:play-file", function (data) {
    // The row ids are file indices; the expanded torrent is the one they belong
    // to.
    var indices = rowIndices(data);
    if (!indices.length || !expandedHash) return;
    // A multi-row selection plays exactly those files; a single row plays the
    // whole torrent from that point, which is what clicking a track in any other
    // list does.
    if (indices.length > 1) {
      var tracks = tracksForIndices(expandedHash, indices);
      if (!tracks.length) {
        api.ui.showNotification("Nothing there that's finished downloading");
        return;
      }
      var t = torrents[expandedHash];
      api.playback.playTracks(tracks, 0, { name: (t && t.name) || "Torrent" });
      return;
    }
    playFiles(expandedHash, indices[0]);
  });

  api.ui.onAction("qbt:file-download", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 1);
  });

  api.ui.onAction("qbt:file-skip", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) setFilePriority(expandedHash, indices, 0);
  });

  api.ui.onAction("qbt:only-audio", function (data) {
    var hash = hashOf(data);
    var files = hash && filesByHash[hash];
    if (!files) return;
    var split = partitionAudio(files);
    if (!split.others.length || !split.audio.length) return;
    // Include the audio first: if the second call fails, the torrent is left
    // wanting MORE than intended rather than nothing at all, which is the
    // recoverable direction.
    setFilePriority(hash, split.audio, 1).then(function () {
      return setFilePriority(hash, split.others, 0);
    });
  });

  api.ui.onAction("qbt:enqueue-file", function (data) {
    var indices = rowIndices(data);
    if (indices.length && expandedHash) enqueueFiles(expandedHash, indices);
  });

  api.ui.onAction("qbt:delete-ask", function (data) {
    pendingDelete = hashOf(data);
    render();
  });

  api.ui.onAction("qbt:delete-confirm", function (data) {
    var hash = hashOf(data) || pendingDelete;
    if (hash) deleteTorrent(hash, false);
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
  var list = tabTorrents(activeTab);
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
  _collectionForPath: collectionForPath,
  _detectCompletions: detectCompletions,
  _mediaKindOf: mediaKindOf,
  _isWindowsPath: isWindowsPath,
  _joinRemotePath: joinRemotePath,
  _applyPathMapping: applyPathMapping,
  _isLikelyLocalHost: isLikelyLocalHost,
  _parseFileTrack: parseFileTrack,
  _qbtUri: qbtUri,
  _parseQbtUri: parseQbtUri,
  _parseMetadataPreview: parseMetadataPreview,
  _playableFiles: playableFiles,
  _partitionAudio: partitionAudio,
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
