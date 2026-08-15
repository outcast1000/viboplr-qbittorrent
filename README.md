# viboplr-qbittorrent

Control a [qBittorrent](https://www.qbittorrent.org/) WebUI from inside
[Viboplr](https://viboplr.com): add magnet links, watch progress, and start, stop
or remove torrents without switching apps.

Requires **Viboplr 1.0.27 or newer**.

## Setup

1. In qBittorrent: **Tools → Options → Web UI**, tick *Web User Interface
   (Remote control)*, and note the port (8080 by default).
2. Set a username and password on that same screen. (Leave *Bypass
   authentication for clients on localhost* off unless you want to skip
   credentials entirely — that works too.)
3. In Viboplr: **Settings → qBittorrent**, enter the WebUI address (e.g.
   `http://localhost:8080`) plus those credentials, then **Save & connect**.
   *Test connection* checks what you've typed before saving.
4. Open **Torrents** in the sidebar.

The same steps are shown in the app — in the Torrents view before anything is
configured, and in Settings → qBittorrent until the connection works.

## Status

**Settings → qBittorrent** opens with a status panel: the connection state,
qBittorrent's version, its WebAPI version, and the Viboplr version you're
running. When something is wrong it names the specific fix rather than showing a
transport error — an unreachable server, a timeout, wrong credentials, an IP ban
after repeated failed logins (which changing the password alone won't clear), a
rejected session, or an address that answers but isn't a Web UI. The Torrents
view carries the same message as a banner, so a broken connection is visible from
where you'd notice it.

A reverse-proxied qBittorrent at a subpath (`https://home.example.com/qbt`)
works — enter the full address including the path.

## How it decides what to touch

Torrents added from Viboplr are tagged with a **category** (`viboplr` by
default), and *Only manage my own category* is **on** by default. While it is on,
the list and the Start all / Stop all buttons only ever see torrents in that
category — they cannot reach anything you manage yourself in qBittorrent. Turn it
off to manage everything.

**Change the category per Viboplr profile.** Settings → qBittorrent → Category
takes any name you like, so `viboplr-alex` and `viboplr-work` can share one
qBittorrent without either profile seeing the other's downloads. Leave it empty
to tag nothing at all.

Renaming it leaves your earlier downloads under the old name, where the filter
hides them — so the Torrents view offers to move them across, or to leave them
be (which is the right answer when the rename was to split a second profile off).

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

## Playing from a torrent

Press **Files** on any torrent to see the audio and video inside it. **Play**
plays the whole torrent, or click a single file to play just that one — they
become ordinary queue entries, with the usual right-click menu and drag-to-queue.

Three things worth knowing:

- **Only finished files play.** A half-downloaded file would open and then stop
  partway through, which looks like a corrupt file rather than an incomplete
  download. Unfinished files are listed with their progress and marked `◌`.
- **Metadata comes from the filename** — track number, artist and title are
  parsed from it, because nothing in the plugin API can read tags off an
  arbitrary file. Importing into a collection gives you real tags; this is the
  "hear it now" path.
- **A remote qBittorrent needs a path mapping.** It reports the paths on *its*
  filesystem, which mean nothing here. If its download folder is mounted on this
  machine, fill in the two path boxes in settings and playback works. Without
  that, Play is hidden rather than handing you a broken file, and the Files list
  explains why.

## Getting downloads into your library

Set **Save downloads to** in settings to one of your local collections. Torrents
added from Viboplr then land there, and when one finishes the collection is
rescanned so the tracks turn up in your library — with real tags read from the
files, unlike the filename-derived metadata you get playing straight from a
torrent.

- A download that finishes **outside** every collection is left alone. Scanning a
  folder your library doesn't cover would find nothing and look broken.
- **Add to library** appears on any finished torrent whose files sit inside a
  collection, if you'd rather import on demand. Turn off *Add finished downloads
  to my library* to make that the only way.
- Restarting doesn't re-announce or re-import anything already finished.

## Searching

The **Search** tab drives the search plugins you have installed in qBittorrent —
this plugin ships none of its own. Results are sorted by seeders and stream in as
each indexer answers; clicking one adds it.

Right-clicking a track, album or artist in your library offers **Find torrents…**,
which opens the tab and searches for it. A track searches its *album*, since
that's the unit indexers actually publish.

If qBittorrent has no search plugins enabled, the tab says so and tells you where
to add them (qBittorrent → View → Search Engine → Search plugins) rather than
claiming nothing was found.

## Not here yet

Planned: RSS auto-download rules for artists you follow, and playing a file
while it's still downloading.

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
