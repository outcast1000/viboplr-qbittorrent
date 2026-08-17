# viboplr-qbittorrent

Control a [qBittorrent](https://www.qbittorrent.org/) WebUI from inside
[Viboplr](https://viboplr.com): add magnet links, watch progress, and start, stop
or remove torrents without switching apps.

Requires **Viboplr 1.0.27+** and **qBittorrent 5.2.3+**.

## Setup

Requires **qBittorrent 5.2.3 or newer** — sign-in is an API key, and keys were
added in 5.2. Get it from [qbittorrent.org/download](https://www.qbittorrent.org/download);
the plugin also offers that link wherever it reports the version as the problem.

1. In qBittorrent: **Tools → Options → Web UI**, tick *Web User Interface
   (Remote control)*, and note the port (8080 by default).
2. On that same screen, under **API keys**, create one and copy it.
3. In Viboplr: open **Torrents** in the sidebar and go to the **Settings** tab
   (or Settings → qBittorrent — they are the same controls). Enter the address
   (e.g. `http://localhost:8080`), paste the key, then **Save & connect**.
   *Test connection* checks what you have typed before saving.

The same steps are shown in the app until the connection works.

A reverse-proxied qBittorrent at a subpath (`https://home.example.com/qbt`)
works — enter the full address including the path.

### Why an API key and nothing else

A key is sent on every request and needs no login. That means no session to
expire, no cookie whose name can change between qBittorrent versions (it changed
in 5.2, which silently broke logins), and nothing the failed-login IP ban can
lock you out of. Supporting a username and password as well meant two auth paths
and a whole session layer that existed only for the weaker one, so it is gone.

If you run qBittorrent with *Bypass authentication for clients on localhost*,
leave the key empty — no header is sent and that works.

Your key is stored in Viboplr's plugin database in plain text. Revoke it in
qBittorrent if you ever need to.

## The list

**One list, sorted by status.** Every torrent lives in the same **Torrents** tab
and states its own status — *Downloading*, *Seeding*, *Paused*, *Complete*,
*Fetching metadata*, *Error*. There is no Downloading/Completed/All split: those
were three filtered views of the same rows, and a torrent that finished used to
jump between them, disappearing from the list you were watching it in.

The order is the triage. Torrents waiting on a decision from you come first
(nothing happens to them until you act), then errors, then anything actually
transferring, then queued/stalled, then paused, with finished torrents last.
Ties break by most recently added. The tab carries the count.

The **name** leads and gets the full width. Everything else reads on the line
underneath, in one order: **status · file count · size · transfer · swarm** —
e.g. *Downloading · 14 files · 916 MB · ↓ 2.3 MB/s · ETA 7m · 12/40 seeds ·
3/9 leechers*. Count and size sit together because they answer one question, and
seeds and leechers give **connected out of what the tracker says exists**: 2
connected is a routing problem if 300 are out there and a dead release if 2 are.
A total qBittorrent hasn't been told is left off rather than shown as 0.

The tile carries the **percentage downloaded**, coloured by
state — blue transferring, green complete, yellow stalled or waiting on you,
grey stopped, red errored. Colour is the state and not the number on purpose:
90% stopped and 90% downloading are the same figure and completely different
situations.

**Clicking a row opens it** — a torrent is a container, and a click that only
highlighted it read as nothing having happened. Cmd/Ctrl-click and Shift-click
still build a selection, and Start / Stop / Remove in the toolbar above the list
take the whole of it in one go (Remove asks once, naming the count).

Hovering a row reveals **▶ Play**, **⏵ Start**, **⏸ Stop** and **🗑 Remove**.
There is no Contents button — the row itself opens the contents, so a button
would be a third route to the same place at the cost of tray width.

There is deliberately **no separate Pause**. qBittorrent has Start and Stop and
nothing between them — WebAPI 2.11 renamed pause/resume to stop/start precisely
because they were one pair — so two buttons posting to the same endpoint would
be a lie about what the client can do. *Stop* is the pause.

*Start all* / *Stop all* act on every torrent the list shows you — which, with
the category filter on, is only the ones this plugin added, and with the filter
box typed into, only the rows it shows.

### Filtering the list — including *inside* torrents

The filter box above the list matches as you type, space-separated terms all of
which must appear. It searches **torrent names and the file paths inside
them** — so `jóga flac` finds the compilation whose release name never says
Björk, and a folder name like `live` finds every release carrying one. A
torrent pulled in by its files says why on its row (*matches "07 - Jóga.flac"
+2 more*), and opening it lands on the contents already narrowed to those files.

The file lists come from a cache that fills itself. The list already fetches
each torrent's files once to print its file count; the names are kept, stored
persistently, and — because a torrent's hash *is* its file list — never go
stale and never need refetching, even across restarts. While you type against
torrents not yet cached, the fetches switch from a background trickle to a
bounded burst (six at a time), and the view says *"Searching inside torrents —
N still to check…"* rather than passing off an unfinished search as "no
matches". On a 1000-torrent seedbox the first-ever search fills in over about a
minute; every one after that is instant.

## Status

The **Settings** tab (and Settings → qBittorrent) opens with a status panel: the
connection state, qBittorrent's version, its WebAPI version, the Viboplr version
and which sign-in is in use. When something is wrong it names the specific fix
rather than showing a transport error — an unreachable server, a timeout, a
refused API key, no key where one is needed, a qBittorrent too old to make one,
or an address that answers but is not a Web UI. The Torrents view carries the
same message as a banner, so a broken connection is visible from where you would
notice it.

## How it decides what to touch

Torrents added from Viboplr are tagged with a **category** (`viboplr` by
default), and *Only manage my own category* is **on** by default. While it is on,
the list and the Start all / Stop all buttons only ever see torrents in that
category — they cannot reach anything you manage yourself in qBittorrent. Turn it
off to manage everything.

**Change the category per Viboplr profile.** Settings → qBittorrent → Category
takes any name you like, so `viboplr-alex` and `viboplr-work` can share one
qBittorrent without either profile seeing the other's downloads.

**Or use no category at all.** Leave the box empty and nothing is tagged, and
with no name to match there is nothing to filter by: the Torrents view lists
everything in qBittorrent and the bulk buttons reach all of it, whatever *Only
manage my own category* is set to. That switch narrows the list *to* a category;
it can't narrow it to no category.

Renaming it leaves your earlier downloads under the old name, where the filter
hides them — so the Torrents view offers to move them across, or to leave them
be (which is the right answer when the rename was to split a second profile off).
Clearing the box is not a rename: nothing is hidden afterwards, so nothing is
offered.

**Remove** removes a torrent from qBittorrent and leaves the downloaded files on
disk. Deleting the data is deliberately not offered here; do that in qBittorrent
if you want it.

## Notes, limits and gotchas

- **The open torrent contents refresh too.** A torrent per-file progress is a
  separate endpoint from the main poll, so while a contents panel is open the
  plugin re-reads that one torrent file list each cycle. Closed, it does not.
- **It polls.** The plugin API has no "view opened" signal, so while the plugin
  is enabled and a server is configured it asks qBittorrent for changes every few
  seconds (5 by default, adjustable 2–60 in settings). It uses the incremental
  `/sync/maindata` endpoint, so a poll with nothing to report costs a few hundred
  bytes.
- **qBittorrent 5.2.3 or newer.** API keys arrived in 5.2, and that is the only
  sign-in this plugin has. An older build is detected and named rather than
  leaving you hunting for a key it cannot create.
- **Self-signed HTTPS** needs *Allow self-signed certificates* turned on.

## Choosing files *before* the download starts

Turn on **Choose files before downloading** in settings. Torrents you add are
then paused, their file list is fetched, and the plugin opens straight into that
torrent's contents with *Paused. Choose which files you want below, then press
Start download.* In the list it reads **Waiting for you**, in yellow, above
everything else — it is the one row that makes no progress until you act.

Magnets work as well: a magnet is only a hash, and qBittorrent won't fetch a
stopped torrent's file list — so it's started briefly to get the metadata and
stopped again the moment it has it. No file data moves during that.

It's off by default, because it adds a decision to every add, which isn't what
you want when you're grabbing one album.

## Contents, and choosing what downloads

**Click a torrent** to see everything inside — not only the playable files: the
point of the list is often to skip the 4 GB video extra. (A plain click opens;
Cmd/Ctrl-click and Shift-click still build a multi-selection for the list's own
toolbar, and double-click or Enter opens it too.)

The contents **replace the list** rather than expanding the row:

- **A plain hero** — the torrent's name at full size and the **Back** button the
  rest of the app uses. No artwork, background or effects: a torrent has no image
  of its own, so the full hero was a 320px scrimmed panel wrapped around a
  placeholder disc.
- **Start / Stop and Remove**, the only two things you do to a torrent as a
  whole. Play lives on the file rows, where it acts on something actually on
  disk.
- **Two tabs.** **Files** is what the panel is for, so it's first and the
  default; **Info** is the numbers you occasionally check.

### The Files tab

The filter box narrows the list as you type, matching anywhere in the file's
*path* — so `extras` finds a whole folder — with space-separated terms that all
have to match (`live flac` narrows, it doesn't widen). Each torrent keeps its own
filter text, and a filter that matches nothing says so and offers a Clear.

Selecting files is **All · None · Audio · Video** in the list's own toolbar. They
*select* rows; then **↓ Download** or **⊘ Skip** acts on what you selected.
Keeping selection and action apart means every combination works without a button
for each: *Audio* then ↓, or *All* → ⊘ → *Audio* → ↓ for "only the tracks".
Presets follow the filter, so they can never select a row you cannot see, and a
preset with nothing of its kind is greyed out.

### The Info tab

Plain text in aligned label/value rows under three headings. **Transfer** —
status, progress, size, downloaded,
uploaded, speeds, time left, ratio, how long it's been active, when it was added
and finished. Speeds and time-left appear only while the torrent is *actually
moving*: on a stopped one they'd read as a fault rather than as something you
paused.

**Swarm** — seeds and leechers as *connected* and *in the swarm* separately (2
connected of 300 is a routing problem, 2 of 2 is a dead release), plus
**availability** (how many complete copies your connected peers add up to; below
1.00 nobody reachable has the whole thing, so it can stall short of 100% however
many seeds the tracker claims), tracker count, when a full copy was last seen,
and last activity.

**Files and location** — what's selected out of the total, where it's saving, the
category, and the hash.

Titles carry the folder, **relative to the torrent’s own folder** — *CD1 /
Opening*, *extras / scans / front.jpg* — so two discs’ track 1 are not the same
row twice.

What you won’t see is the folder every file shares. Almost every torrent wraps
its contents in one directory named after the release, and the hero above the
list already says it, so repeating it on every row was a column of the same
words pushing the part that matters off the end. Any deeper folder holding
*every* file goes the same way, leaving bare filenames. A file that genuinely
sits at the torrent’s root means there is no shared wrapper, so nothing is
stripped from anybody.

Files sort by full path, so a folder’s contents stay together, and a filter on a
folder name explains its own results.

Each row hovers only what it can actually do. A **Downloaded** file gets **▶
Play** and **+ Add to queue** — the bytes are on disk — and nothing else: there
is nothing left to fetch and nothing worth skipping. Anything else is still a
choice about whether to fetch it, so it gets **↓ Download** *or* **⊘ Skip**,
whichever it is not already in. Play and Add to queue are absent there because
they would act on a file that does not exist yet.

The list still declares all four, so a mixed multi-row selection can reach any
of them from the toolbar above it. The list still declares all four,
so a multi-row selection can reach either from the toolbar. Priorities you set in
qBittorrent itself (high, maximum) are left alone — this only ever switches a
file between *download* and *don't*.

## Playing from a torrent

**Play** on a file row plays **that file**, and on a multi-row selection exactly those files —
they become ordinary queue entries, with the usual right-click menu and
drag-to-queue. Hover a row for **▶ Play** and **+ Add to queue**.

Three things worth knowing:

- **Only finished files play.** A half-downloaded file would open and then stop
  partway through, which looks like a corrupt file rather than an incomplete
  download. Unfinished files are listed with their progress and marked `◌`.
- **Only audio and video are offered.** The cover art, the `.nfo` and the scans
  folder are listed — you may well want to *skip* them, which is half the point
  of the list — but a finished one offers no buttons at all: there is nothing to
  play, and nothing left to download or skip either.
- **Metadata comes from the file's own tags**, with the filename filling the
  gaps. Title, artist, album, track number and duration are read straight off
  the finished file; anything it doesn't carry falls back to what the filename
  says (track number and artist out of `03 - Artist - Title.flac`, the torrent
  name as the album). Per field, so a release tagged with an artist but no track
  number still gets its number from the filename. Reading tags needs Viboplr
  1.0.28 or newer — on an older app everything falls back to the filename, which
  is how this plugin worked before.
- **A remote qBittorrent needs a path mapping.** It reports the paths on *its*
  filesystem, which mean nothing here. If its download folder is mounted on this
  machine, fill in the two path boxes in settings and playback works. Without
  that, Play is hidden rather than handing you a broken file, and the Files list
  explains why.

## Getting downloads into your library

Set **Save downloads to** in settings to one of your local collections. Torrents
added from Viboplr then land there, and when one finishes the collection is
rescanned so the tracks turn up in your library — with the full tag set, artwork
and everything else a scan does, which is more than the play-from-torrent path
reads.

- A download that finishes **outside** every collection is left alone. Scanning a
  folder your library doesn't cover would find nothing and look broken.
- **Add to library** appears on any finished torrent whose files sit inside a
  collection, if you'd rather import on demand. Turn off *Add finished downloads
  to my library* to make that the only way.
- Restarting doesn't re-announce or re-import anything already finished.

## Searching

The **Search** tab drives the search plugins you have installed in qBittorrent —
this plugin ships none of its own. Results are sorted by seeders and stream in as
each indexer answers.

Results are a normal row list, the same one every other search surface in the app
uses. Each row leads with the **name**, carries its **size** in the trailing
column, and puts **seeders / leechers** and the indexer underneath. The thumbnail
carries the two facts you decide on:

- **What it is** — a **music note or a film strip**, read off the release name.
  `FLAC`, `MP3`, `320kbps`, `24bit`, `vinyl` mean audio; `1080p`, `x265`,
  `BluRay`, `S01E05` mean video, and win when a name carries both (a concert
  Blu-ray with a FLAC track is still video). A name with no format tags gets a
  plain sheet rather than a guess.
- **Whether it will actually download** — a **seeder badge** across the bottom:
  **green above 100**, **yellow above 10**, **red at or below 10**, and grey `?`
  when the indexer didn't report a swarm (which is not the same as zero). Counts
  past 999 read as `1.2k`. Results are sorted by seeders, so the colour runs
  green to red down the list.

Hovering a row
reveals **⬇ Download** and **📂 View contents**; double-click or Enter downloads.
Click, Cmd/Ctrl-click and Shift-click select, and **Download** in the toolbar
above the list takes everything selected in one go. *View contents* stays one at
a time — it adds a real (paused) torrent, and doing that to a whole selection
would leave a pile of them to clean up.

*View contents* adds the torrent **paused**, and once qBittorrent has the file
list it **starts it with every file set to skip**. Nothing transfers — there is
nothing selected to transfer — and the moment you include a file it begins
arriving. There is no second *Start download* press, because picking the files
*is* the decision. **Discard** removes the whole thing and never deletes
anything from disk.

While a torrent is in that state the list says **Choose files to start** in
yellow at **0%**, the contents panel puts *Download this file* first, and every
file reads *Not selected for download*. That labelling is load-bearing: with
nothing selected there is nothing left to want, so **qBittorrent itself reports
the torrent as 100% complete and starts seeding it**. The plugin never repeats
that — it isn't counted as Finished, isn't coloured green, isn't announced as a
finished download, and isn't imported into your library.

For a magnet that means a brief start purely to fetch metadata from the swarm —
no file data moves during it — and the row says so while it happens.

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
