# Changelog

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
