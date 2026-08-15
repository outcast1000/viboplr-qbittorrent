// viboplr-qbittorrent — control a qBittorrent WebUI from Viboplr.
//
// Design notes:
//  - Auth is a session COOKIE. /api/v2/auth/login answers with
//    `Set-Cookie: SID=…` and qBittorrent offers no header/API-key alternative,
//    which is why this plugin needs Viboplr >= 1.0.27: api.network.fetch only
//    began returning response headers (and getSetCookie()) there. The SID is
//    kept in MEMORY ONLY — a session token that outlives a restart is a
//    liability, and re-logging in costs exactly one request.
//  - A qBittorrent with "Bypass authentication for clients on localhost" turned
//    on answers the login with "Ok." and NO cookie. That is a valid session, not
//    a failure, so a cookieless login is accepted and simply sends no Cookie
//    header afterwards.
//  - ANY 403 means the session lapsed — expiry, a qBittorrent restart, or a
//    password change. One re-login plus one retry covers all three; a second
//    403 is a real answer and is surfaced.
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

// qBittorrent reports "no estimate" as this sentinel rather than null.
var ETA_INFINITY = 8640000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var api = null;

// Settings (persisted).
var baseUrl = "";
var username = "";
var password = "";
var category = "viboplr";
var restrictToCategory = true;
var insecure = false;
var pollMs = 5000;
// Remote → local prefix rewrite, for a qBittorrent on another machine whose
// download directory is mounted here under a different root.
var pathMapFrom = "";
var pathMapTo = "";

// Draft settings — what the settings panel's inputs currently hold. Kept apart
// from the live values so a half-typed password never reaches storage and never
// takes down a working session mid-keystroke.
var draft = null;

// Session.
var sid = null; // cookie value, or "" when qBittorrent runs cookieless
var sessionReady = false;
var loginPromise = null; // single-flight: a burst of requests triggers ONE login
var cookielessLogin = false;
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

// Pull the SID out of the response's Set-Cookie values. Takes the whole list
// rather than one joined string because a joined list can't be split back apart
// safely — a cookie's Expires attribute contains a comma of its own.
function parseSid(cookies) {
  var list = cookies || [];
  for (var i = 0; i < list.length; i++) {
    var m = /(?:^|;\s*)SID=([^;]*)/.exec(String(list[i]));
    if (m && m[1]) return m[1];
  }
  return null;
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
  if (/temporarily banned|too many failed/.test(m)) return "banned";
  if (/kept rejecting the session|rejected the session/.test(m)) return "session";
  if (/rejected the username or password|rejected the username/.test(m)) return "auth";
  if (/sent no session cookie/.test(m)) return "session";
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
    "In qBittorrent, open Tools → Options → Web UI.",
    "Tick “Web User Interface (Remote control)” and note the port (8080 by default).",
    "Set a username and password there — leave “Bypass authentication for clients on localhost” off unless you want to skip credentials entirely.",
    "Back here, enter the address (e.g. http://localhost:8080) with that username and password.",
    "Press Save & connect."
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
    if (kind === "auth") {
      return {
        kind: kind,
        tone: "error",
        label: "qBittorrent rejected the username or password",
        detail: "The server is reachable — the credentials are what it turned down.",
        fix: "Check them under qBittorrent's Tools → Options → Web UI, then Save & connect again."
      };
    }
    if (kind === "banned") {
      return {
        kind: kind,
        tone: "error",
        label: "qBittorrent has temporarily banned this machine",
        detail: "It bans an IP after repeated failed logins — the credentials are wrong, not the address.",
        fix: "Fix the password, then wait for the ban to lapse (one hour by default) or restart qBittorrent."
      };
    }
    if (kind === "session") {
      return {
        kind: kind,
        tone: "error",
        label: "The login worked, but the session was rejected",
        detail: "qBittorrent accepted the credentials and then refused the session cookie that came back — which usually means the cookie never arrived.",
        fix: "Update Viboplr to " + MIN_HOST_VERSION + " or newer, or turn on “Bypass authentication for clients on localhost” in qBittorrent."
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
  if (sid) headers["Cookie"] = "SID=" + sid;
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

function login() {
  if (loginPromise) return loginPromise;
  if (!baseUrl) return Promise.reject(new Error("No qBittorrent server configured"));

  sid = null;
  sessionReady = false;

  loginPromise = rawRequest("/auth/login", {
    method: "POST",
    form: { username: username, password: password }
  })
    .then(function (resp) {
      return resp.text().then(function (text) {
        var body = String(text || "").trim();
        if (resp.status === 403) {
          throw new Error("qBittorrent has temporarily banned this IP after too many failed logins");
        }
        if (resp.status !== 200 || body === "Fails.") {
          throw new Error("qBittorrent rejected the username or password");
        }
        var cookies = typeof resp.getSetCookie === "function" ? resp.getSetCookie() : [];
        var got = parseSid(cookies);
        // No cookie is legitimate when "Bypass authentication for clients on
        // localhost" is on. It is ALSO what an older host looks like (one that
        // can't read response headers at all) — the two are indistinguishable
        // here, so accept it and let the first 403 tell them apart.
        cookielessLogin = !got;
        sid = got || "";
        sessionReady = true;
        return sid;
      });
    })
    .then(
      function (v) {
        loginPromise = null;
        return v;
      },
      function (e) {
        loginPromise = null;
        sessionReady = false;
        throw e;
      }
    );

  return loginPromise;
}

function ensureSession() {
  if (sessionReady) return Promise.resolve(sid);
  return login();
}

function authed(path, opts) {
  return ensureSession()
    .then(function () {
      return rawRequest(path, opts);
    })
    .then(function (resp) {
      if (resp.status !== 403) return resp;
      // Session lapsed. One re-login, one retry — then believe the answer.
      sessionReady = false;
      return login()
        .then(function () {
          return rawRequest(path, opts);
        })
        .then(function (retry) {
          if (retry.status === 403) {
            throw new Error(
              cookielessLogin
                ? "qBittorrent kept rejecting the session. Viboplr 1.0.27 or newer is needed to read the login cookie — or turn on “Bypass authentication for clients on localhost” in qBittorrent."
                : "qBittorrent rejected the session"
            );
          }
          return retry;
        });
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

function addTorrent(source) {
  var uri = String(source || "").trim();
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
  if (category) form.category = category;

  return authed("/torrents/add", { method: "POST", form: form })
    .then(function (resp) {
      expectOk(resp, "Adding the torrent");
      var name = magnetDisplayName(uri);
      api.ui.showNotification(name ? "Added " + name : "Added to qBittorrent");
      return refresh();
    })
    .catch(function (e) {
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
          progress: f.progress
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
  var buttons = [];

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
    var rows = fileRowsNode(t.hash);
    if (rows) children.push(rows);
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
      { id: "all", label: "All", count: counts.all }
    ]
  });

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
      username: username,
      password: password,
      category: category,
      restrictToCategory: restrictToCategory,
      insecure: insecure,
      pollMs: pollMs,
      pathMapFrom: pathMapFrom,
      pathMapTo: pathMapTo
    };
  }
  return draft;
}

function renderSettings() {
  if (!api) return;
  var d = currentDraft();

  var status = connectionStatus();
  var statusChildren = [
    {
      type: "stats-grid",
      items: [
        { label: "Status", value: status.label },
        { label: "qBittorrent", value: qbtVersion || "—" },
        { label: "WebAPI", value: apiVersion || "—" },
        { label: "Viboplr", value: (api.appVersion || "?") + (hostTooOld ? " (too old)" : "") }
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
  }

  api.ui.setViewData(SETTINGS_ID, {
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
            label: "Username",
            control: { type: "text-input", placeholder: "admin", action: "qbt:set-user", value: d.username }
          },
          {
            type: "settings-row",
            label: "Password",
            description: "Stored in Viboplr's plugin database in plain text — prefer a dedicated WebUI account over your main one.",
            control: { type: "text-input", action: "qbt:set-pass", password: true, value: d.password }
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
            description: "Torrents added from Viboplr are tagged with this category in qBittorrent.",
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
  });
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
      username = s.username || "";
      password = s.password || "";
      category = s.category === undefined ? "viboplr" : s.category;
      restrictToCategory = s.restrictToCategory !== false;
      insecure = !!s.insecure;
      pollMs = clampPoll(s.pollMs);
      pathMapFrom = s.pathMapFrom || "";
      pathMapTo = s.pathMapTo || "";
      draft = null;
    })
    .catch(function (e) {
      console.error("qBittorrent: could not read settings:", e);
    });
}

function saveSettings() {
  var d = currentDraft();
  baseUrl = normalizeBaseUrl(d.baseUrl);
  username = d.username || "";
  password = d.password || "";
  category = (d.category || "").trim();
  restrictToCategory = !!d.restrictToCategory;
  insecure = !!d.insecure;
  pollMs = clampPoll(d.pollMs);
  pathMapFrom = (d.pathMapFrom || "").trim();
  pathMapTo = (d.pathMapTo || "").trim();

  // Any of these can invalidate the session (a new host, new credentials, a
  // different TLS stance), so drop it rather than discovering that on the next
  // 403.
  sid = null;
  sessionReady = false;
  apiVersion = null;
  qbtVersion = null;
  rid = 0;
  torrents = {};
  filesByHash = {};
  expandedHash = null;
  connected = false;
  lastError = null;

  return api.storage
    .set(STORAGE_KEY, {
      baseUrl: baseUrl,
      username: username,
      password: password,
      category: category,
      restrictToCategory: restrictToCategory,
      insecure: insecure,
      pollMs: pollMs,
      pathMapFrom: pathMapFrom,
      pathMapTo: pathMapTo
    })
    .catch(function (e) {
      console.error("qBittorrent: could not save settings:", e);
      api.ui.showNotification("Couldn't save those settings: " + errText(e));
    })
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
  var prev = { baseUrl: baseUrl, username: username, password: password, insecure: insecure, sid: sid, ready: sessionReady };
  baseUrl = probeUrl;
  username = d.username || "";
  password = d.password || "";
  insecure = !!d.insecure;
  sid = null;
  sessionReady = false;

  return login()
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
      username = prev.username;
      password = prev.password;
      insecure = prev.insecure;
      sid = prev.sid;
      sessionReady = prev.ready;
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

function fileRowsNode(hash) {
  var torrent = torrents[hash];
  var files = filesByHash[hash];
  if (filesLoading === hash && !files) return { type: "loading", message: "Reading files…" };
  if (!files) return null;

  var media = [];
  for (var i = 0; i < files.length; i++) {
    if (mediaKindOf(files[i].name)) media.push(files[i]);
  }
  if (!media.length) {
    return { type: "text", content: "No audio or video files in this torrent.", className: "muted" };
  }

  media.sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  var items = [];
  for (var j = 0; j < media.length; j++) {
    var f = media[j];
    var done = Number(f.progress) >= 1;
    var parsed = parseFileTrack(f.name);
    var subtitle = formatBytes(f.size);
    if (!done) subtitle += " · " + Math.round(Number(f.progress || 0) * 100) + "% downloaded";
    items.push({
      id: String(f.index),
      // An unfinished file stays visible but is marked, so the list shows the
      // whole torrent rather than appearing to be missing tracks.
      title: (done ? "" : "◌ ") + parsed.title,
      subtitle: subtitle,
      album: torrent ? torrent.name : undefined,
      action: done ? "qbt:play-file" : undefined,
      // Only a finished, reachable file gets a path — that is what makes the
      // host's right-click menu and drag-to-queue work on these rows.
      path: done && filesAreReachable() ? qbtUri(hash, f.index) : null,
      artistName: parsed.artist,
      albumTitle: torrent ? torrent.name : null
    });
  }
  return { type: "track-row-list", items: items, numbered: true };
}

function registerActions() {
  api.ui.onAction("qbt:tab", function (data) {
    activeTab = (data && data.tabId) || (data && data.id) || activeTab;
    render();
  });

  api.ui.onAction("qbt:add", function (data) {
    addTorrent((data && data.query) || "");
  });

  api.ui.onAction("qbt:refresh", function () {
    refresh();
  });

  api.ui.onAction("qbt:start", function (data) {
    var hash = hashOf(data);
    if (hash) actOn(startEndpoint(), [hash], "Starting the torrent");
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

  api.ui.onAction("qbt:play-torrent", function (data) {
    var hash = hashOf(data);
    if (hash) playFiles(hash, null);
  });

  api.ui.onAction("qbt:play-file", function (data) {
    // track-row-list sends the row's id back; the expanded torrent is the one
    // it belongs to.
    var index = parseInt((data && (data.itemId != null ? data.itemId : data.id)) || "", 10);
    if (isNaN(index) || !expandedHash) return;
    playFiles(expandedHash, index);
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
  api.ui.onAction("qbt:set-user", function (data) {
    currentDraft().username = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-pass", function (data) {
    currentDraft().password = (data && data.value) || "";
  });
  api.ui.onAction("qbt:set-category", function (data) {
    currentDraft().category = (data && data.value) || "";
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
  render();
  renderSettings();

  loadSettings()
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
  // The session dies with the plugin; nothing about it is worth persisting.
  sid = null;
  sessionReady = false;
  loginPromise = null;
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for the test harness.
  _normalizeBaseUrl: normalizeBaseUrl,
  _parseSid: parseSid,
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
  _mediaKindOf: mediaKindOf,
  _isWindowsPath: isWindowsPath,
  _joinRemotePath: joinRemotePath,
  _applyPathMapping: applyPathMapping,
  _isLikelyLocalHost: isLikelyLocalHost,
  _parseFileTrack: parseFileTrack,
  _qbtUri: qbtUri,
  _parseQbtUri: parseQbtUri,
  _playableFiles: playableFiles,
  _setupSteps: setupSteps,
  _looksLikeTorrentSource: looksLikeTorrentSource,
  _magnetDisplayName: magnetDisplayName,
  _encodeForm: encodeForm,
  _clampPoll: clampPoll
};
