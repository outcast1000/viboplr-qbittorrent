# viboplr-qbittorrent

Control a [qBittorrent](https://www.qbittorrent.org/) WebUI from inside
[Viboplr](https://viboplr.com): add magnet links, watch progress, and start, stop
or remove torrents without switching apps.

Requires **Viboplr 1.0.27 or newer**.

## Setup

1. In qBittorrent: **Tools → Options → Web UI**, tick *Web User Interface
   (Remote control)*, and note the port (8080 by default).
2. In Viboplr: **Settings → qBittorrent**, enter the WebUI address (e.g.
   `http://localhost:8080`) plus your username and password, then
   **Save & connect**. *Test connection* checks what you've typed before saving.
3. Open **Torrents** in the sidebar.

A reverse-proxied qBittorrent at a subpath (`https://home.example.com/qbt`)
works — enter the full address including the path.

## How it decides what to touch

Torrents added from Viboplr are tagged with a **category** (`viboplr` by
default), and *Only manage my own category* is **on** by default. While it is on,
the list and the Start all / Stop all buttons only ever see torrents in that
category — they cannot reach anything you manage yourself in qBittorrent. Turn it
off to manage everything.

**Remove** removes a torrent from qBittorrent and leaves the downloaded files on
disk. Deleting the data is deliberately not offered here; do that in qBittorrent
if you want it.

## Notes, limits and gotchas

- **Authentication is a session cookie.** qBittorrent's `/api/v2/auth/login`
  returns the session as `Set-Cookie: SID=…` and offers no API-key alternative,
  which is the whole reason this plugin needs Viboplr 1.0.27+ — earlier versions'
  `api.network.fetch` discarded response headers. The cookie is held in memory
  only and never written to disk; a restart simply logs in again.
- **Localhost auth bypass works too.** If you've ticked *Bypass authentication
  for clients on localhost*, qBittorrent logs you in without a cookie. That's
  accepted as a valid session.
- **Your password is stored in plain text** in Viboplr's plugin database, like
  every other plugin credential. Prefer a dedicated WebUI account over the one
  you use elsewhere.
- **It polls.** The plugin API has no "view opened" signal, so while the plugin
  is enabled and a server is configured it asks qBittorrent for changes every few
  seconds (5 by default, adjustable 2–60 in settings). It uses the incremental
  `/sync/maindata` endpoint, so a poll with nothing to report costs a few hundred
  bytes.
- **qBittorrent 4.x and 5.x are both supported.** 5.0 renamed
  `/torrents/pause` → `/stop` and `/resume` → `/start`; the WebAPI version is
  probed once per session and the right names are used.
- **Self-signed HTTPS** needs *Allow self-signed certificates* turned on.

## Not here yet

Planned, roughly in order: browsing a torrent's files and playing them straight
from disk, importing finished music into a local collection, completion
notifications, and driving qBittorrent's own search plugins from the view.

This plugin controls a torrent client. It ships no indexers and no content, and
searching (when it lands) will use whatever search plugins you have installed in
qBittorrent itself.

## Development

```bash
node --check index.js   # syntax
node --test             # unit tests
scripts/package.sh      # build qbittorrent.zip + update.json locally
```

The plugin is a single `index.js` evaluated by the host as a function body, plus
`manifest.json`. Tests load it through `test/harness/sandbox.js`, which shadows
the globals the real sandbox withholds (`fetch`, `require`, `document`, …) so a
mistake fails here rather than in the app.

Releases are cut by CI on a `vX.Y.Z` tag — never publish by hand; see the note at
the end of `scripts/package.sh`.
