# Changelog

## 0.10.0

**Choose files before anything downloads** — the missing half of 0.9.0, which
could only skip files after the torrent had already started pulling them.

- New setting, **Choose files before downloading**. With it on, a torrent is
  added paused, its file list is fetched, and it waits for you.
- The row says so plainly and its button reads **Start download**, not “Start”.
- **Magnets work too.** A magnet is only a hash, and qBittorrent won’t fetch the
  file list for a stopped torrent — so it is started briefly for metadata and
  stopped again the moment it arrives. No file data moves during that.
- Starting with every file skipped is refused, since it would download nothing
  and look broken.
- Off by default: it adds a decision to every add, which is not what you want
  when grabbing a single album.

## 0.9.0

Choose what a torrent actually downloads.

- **The Files list now shows every file**, not just the playable ones. You
  cannot skip a 4 GB video extra the list filtered out.
- **Include or skip any file** with the ↓ and ⊘ buttons on its row. Skipped
  files are marked and stop downloading; qBittorrent keeps the rest going.
- **“Download only the audio”** on any unfinished torrent with non-audio files —
  the usual reason to open the list on a music release full of scans, samples
  and video extras.
- Priorities you set in qBittorrent itself (high, maximum) are left alone; this
  only ever switches a file between “download” and “don’t”.

## 0.8.0

- **A running search can be stopped.** A slow indexer could hold one open for
  the full 45-second budget, and the only way out was to start a different
  search. Results already returned are kept.
- Stopping says so rather than reporting “nothing found” — the search never got
  far enough to have a verdict.
- Disabling the plugin mid-search no longer strands a search job on the server.

## 0.7.0

Give each Viboplr profile its own qBittorrent category.

- The **Category** setting (Settings → qBittorrent) always accepted any name;
  it now says what that is for. Point two profiles at one qBittorrent with
  different categories and neither sees the other’s downloads. Empty tags
  nothing.
- **Renaming no longer loses your torrents.** Everything added under the old
  name kept it and was hidden by the new filter, with no hint where it went.
  The view now says how many are stranded and offers to move them across — or
  to leave them, which is the right answer when the rename was to split a
  second profile off.

## 0.6.0

**Fixes adding a torrent from search appearing to do nothing.** Two separate
causes, both real:

- **A refused add reported success.** qBittorrent answers a rejected add with
  HTTP 200 and the body `Fails.`, so checking only the status code showed
  "Added to qBittorrent" for torrents it never took. The body is now checked and
  the real reason is shown.
- **The category wasn't being created.** qBittorrent doesn't create a category
  on demand, so torrents added with one that didn't exist yet ended up
  uncategorised — downloading fine, but hidden by the category-filtered list.
  The category is now created before it's relied on.
- Adding from the Search tab now **switches to Downloading**, so you can see
  where the torrent went instead of being left staring at search results.

Also, list rows now behave like every other track list in the app:

- **Files rows have hover Play and Add-to-queue buttons**, plus multi-select,
  keyboard navigation and drag-to-queue. Select several files and the buttons
  act on all of them.
- **Search results have a visible "Add to qBittorrent" button** rather than only
  responding to a click on the row.

## 0.5.0

Search, using the indexers you've already set up in qBittorrent.

- **A Search tab** in the Torrents view. Results stream in as the indexers answer
  rather than appearing all at once at the end, sorted by seeders, with size,
  swarm and source on each row. Click one to add it.
- **"Find torrents…"** on any track, album or artist in your library. It opens
  the Search tab and searches straight away. A track searches its *album* — one
  track's title finds single-track rips and misses the release it came from.
- **With no search plugins enabled, it says so** and points at where to add them
  in qBittorrent, instead of reporting "nothing found" for an album that exists.
- Search jobs are disposed of on every exit path, including retyping a query
  mid-search: qBittorrent caps how many can exist at once, and an abandoned job
  holds its slot.

This plugin ships no indexers. It drives whatever search plugins you have
installed in qBittorrent itself.

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
