# Changelog

## 0.4.0

Finished downloads reach your library on their own.

- **Save downloads into a collection.** Pick one in settings and torrents added
  from Viboplr are saved there — which is what makes everything below possible;
  files that land outside your collections are never seen by the library.
- **Finished downloads are imported automatically.** When a torrent completes
  inside one of your collections, that collection is rescanned and the tracks
  appear. Downloads outside every collection are left alone rather than
  triggering a scan that would find nothing.
- **A notification when a download finishes**, naming the torrent.
- **"Add to library"** on any finished torrent, for importing on demand. It only
  appears when the files are actually inside a collection.
- Restarting the app no longer looks like a hundred torrents finishing at once:
  what was already complete at startup is recorded silently.

## 0.3.0

Play straight out of a torrent, without importing anything.

- **Files list** per torrent (the Files button): every audio and video file it
  contains, with the unfinished ones marked and their progress shown.
- **Play** a whole torrent or any single finished file. They become ordinary
  queue entries — right-click menu, drag-to-queue and all — resolved through a
  `qbt://` handler that maps a torrent + file back to the file on disk.
- **Only finished files are playable.** A half-downloaded file would open and
  then hit EOF partway through, which reads as a corrupt file rather than an
  incomplete download.
- **Metadata comes from the filename** (track number, artist, title), because
  nothing in the plugin API reads tags off an arbitrary file. Importing into a
  collection still gives you real tags — this is the "hear it now" path.
- **Path mapping** for a qBittorrent on another machine: tell it what its
  download folder is called here and remote files play too. Without it, the
  Play buttons stay hidden rather than producing paths that mean nothing on
  this machine, and the Files list says why.

## 0.2.1

- Its own icon: the qBittorrent “qb” letterform, replacing a generic download
  arrow that was identical to the yt-dlp plugin’s — two different plugins were
  indistinguishable in the sidebar.

## 0.2.0

Status and setup. Nothing about connecting was discoverable before: a failure
showed up as a raw transport string, and the steps to get a Web UI running
weren't written down anywhere in the app.

- **Status panel** in Settings → qBittorrent: connection state, qBittorrent's own
  version, the WebAPI version, and the running Viboplr version.
- **Setup instructions** — the five steps to enable and connect a Web UI, shown
  in the Torrents view when nothing is configured and in the settings panel until
  the connection actually works.
- **Failures now name their own fix.** Each kind of problem is identified and
  given the specific next step: unreachable server, timeout, wrong credentials,
  an IP ban after repeated failed logins (which a new password alone won't
  clear), a rejected session, or an address that answers but isn't a Web UI.
- **A too-old Viboplr is detected and explained** rather than surfacing later as
  a confusing session error. The plugin needs 1.0.27 for the response headers
  that carry qBittorrent's login cookie; below that it says so, points at the
  update, and stops polling instead of failing every few seconds.

## 0.1.0

First release. Control a qBittorrent WebUI from inside Viboplr.

- **Torrents sidebar view** — Downloading / Completed / All tabs, live progress
  bars, transfer speeds, ETA, seed counts, and global download/upload speed plus
  free disk space.
- **Add by magnet link or .torrent URL**, with a Paste button that fills the box
  from the clipboard and submits in one click. Everything added gets sequential
  download and first/last piece priority so a partial file is playable.
- **Start, stop and remove** individual torrents, or start/stop everything in
  view. Removing leaves the downloaded files on disk.
- **Sidebar badge** showing how many torrents are actively downloading, or an
  error dot when qBittorrent can't be reached.
- **Category scoping** (on by default) — the view and its bulk buttons only ever
  touch torrents in this plugin's own category, so they can never reach torrents
  you manage yourself.
- Works with qBittorrent 4.x and 5.x: the WebAPI version is probed once per
  session and the renamed 5.0 start/stop endpoints are used where they exist.

Requires Viboplr 1.0.27 or newer, which is the first version whose plugin API
exposes HTTP response headers — qBittorrent's login hands back a session cookie
and there is no other way to read it.
