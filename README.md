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

The tile carries the **percentage downloaded**, and its colour is that same
number: **red at 0%, green at 100%, yellow anywhere between**. One traffic
light, answering the question a four-character badge can actually answer — *have
I got this?* File tiles inside a torrent are banded by the same rule, so the two
lists read alike. (A file nobody asked for shows *skip* in grey instead: it has
no progress to report, and 0% red would read as "this failed" rather than "this
was never wanted".)

The colour follows the number *as displayed*, so they can never disagree: 0.4%
floors to `0%` and is red, and 99.7% floors to `99%` and stays yellow. Only an
actual 100% is green.

The tile used to be coloured by the torrent's **state** instead — blue moving,
grey stopped, red errored — so the badge said two different things at once and
the colour was the half nobody could read without a key. The state has better
places to live and is in all of them: the row's status text names it, the list
sorts by it (waiting-on-you first, then errors, then transfers), and the row
offers *Start* or *Stop* depending on which one it's in.

That percentage is **of the whole torrent**, not of the files you selected from
it. qBittorrent's own `progress` measures the selection, so picking one 3 MB
cover out of a 700 MB release reports it finished with 697 MB missing, and a
torrent with nothing selected reports 100% having downloaded nothing at all.
The figure here is bytes on disk over the torrent's real weight — and where the
file list is in hand (any torrent you have opened), it is counted file by file,
so a file you downloaded and later *deselected* still counts. The same number
appears on the torrent's own page, its bar and its Info tab.

**Clicking a row opens it** — a torrent is a container, and a click that only
highlighted it read as nothing having happened. Modifier-clicks open it too:
the list is **single-selection**, so there is no multi-selection for them to
build.

That is why there is no *All / None / Play / Start / Stop / Remove* bar above
the list any more. Everything you do to a torrent you do to *that* torrent, and
all four are on its own hover tray — so the bar was a second copy of the same
buttons, fed by a selection that existed only to feed it. Acting on many at once
is still *Start all* / *Stop all* below, which act on every row the list is
showing you.

Hovering a row reveals **▶ Play**, **⇅ Start** *or* **⏹ Stop**, and
**🗑 Remove** — only the ones that would actually do something:

- **Play** appears when the torrent holds a media file that is finished
  downloading. On a torrent you have opened, that is read file by file; before
  that it goes on what is knowable — a torrent with no media in it at all, or
  with nothing on disk yet, has no Play button, and a part-downloaded one keeps
  it (pressing it on a torrent with nothing ready explains itself, whereas a
  missing button on a playable torrent is a dead end).
- **Start** and **Stop** are one control in two states, so a row shows the one
  it isn't: Start on a stopped torrent, Stop on a running one. Showing both
  always meant one of them did nothing.

Only the glyph is on screen — the label is its tooltip — so Play and Start
deliberately don't share a shape. **⇅** is the transfer, in the same arrow
vocabulary the file rows use for downloading; **▶** is the music.

There is no Contents button — the row itself opens the contents, so a button
would be a third route to the same place at the cost of tray width.

There is deliberately **no separate Pause**, which is why Stop is a square and
not a pause bar. qBittorrent has Start and Stop and nothing between them —
WebAPI 2.11 renamed pause/resume to stop/start precisely because they were one
pair — so a button posting to the same endpoint under a different name would be
a lie about what the client can do. *Stop* is the pause.

*Start all* / *Stop all* act on every torrent the list shows you — which, with
the category filter on, is only the ones this plugin added, and with the filter
box typed into, only the rows it shows.

### Adding a torrent

**Add torrent…** leads the toolbar and opens an *Add a torrent* panel: paste a
magnet link or the address of a `.torrent` file, or press **Paste** to take
what's on the clipboard and add it in one click. The panel says what will happen
— it starts downloading straight away, or arrives paused when *Choose files
before downloading* is on — and closes itself once the torrent is added.

Adding is something you do once and then watch for an hour, so the box does not
hold a row above the list for the rest of the session. It is a panel rather than
a floating dialog because the plugin view API has no dialog with an input in it;
faking a modal out of divs is not what the rest of the app does.

**An empty list opens it for you.** With nothing to watch, getting a first
torrent in is the whole job of that screen. Close it and it stays closed.

### Filtering the list — including *inside* torrents

The filter box above the list matches as you type, space-separated terms all of
which must appear. It searches **torrent names and the file paths inside
them** — so `jóga flac` finds the compilation whose release name never says
Björk, and a folder name like `live` finds every release carrying one. A
torrent pulled in by its files says why on its row (*matches 3 files*), and the
files themselves appear as a **"Matching files" list under the torrents** — one
row per found file, with its state, its folder and its torrent named
underneath.

**Two toggles decide what a search shows you**, sitting above the results
whenever a search found files at all:

- **Files only** hides the torrent rows and leaves the matches. When what you
  are looking for is a *file*, the torrents above are the haystack.
- **Downloaded only** drops every match that isn't on disk, and the heading
  keeps both numbers (*downloaded only (12 of 40)*) so a narrowed list never
  passes for the whole answer.

They stay on between searches — "I'm looking for files I already have" is a mode
you're in for a run of searches, not a property of one query — and they only
appear, or take effect, when a search actually has file matches, so a mode left
on can't blank a screen it isn't describing. *Downloaded only* can still be
filling in while the file lists arrive; it says so rather than showing an empty
list as a verdict.

**That list is also a selection of its own.** It has the usual **All / None** and
a **Downloaded** preset that picks out exactly the matches whose bytes are on
disk — so "find every FLAC of this across my torrents and play the ones I
actually have" is three clicks. Selecting *files* rather than torrents is
possible because the torrent list above stopped being a selection (see above); a
second multi-selection under a *Start all* / *Stop all* toolbar was ambiguous
about what those acted on. A single click selects, and a downloaded match can be
dragged into the queue like any other track.

**A match row carries the same buttons as the same file inside its torrent**,
from the same code: **▶ Play** / **+ Add to queue** on a finished media file,
**📄 Open** / **📂 Show folder** on a finished one that isn't media, and
**↓ Download** or **⊘ Skip** on one that hasn't arrived — the choice it is not
already in. Double-click does what the row's first button does. A file is a
file; which list you found it in is not a property of it, so there is no
separate "Open torrent" button either (each row already names the torrent it
came from).

Those buttons need each matched torrent's real file list — the name cache knows
what a torrent *contains*, not what has *arrived*. The lists are fetched in the
background, six at a time, as you read; a row whose torrent hasn't been read yet
still shows, it just offers nothing, because with no file behind it there is
nothing to be right about. That fetch is deliberately kept out of the cache the contents panel uses,
so searching can never change what the plugin *does* about a torrent (what it
announces as finished, what it imports) — only what it shows you.

Every match gets a row. There is **no per-torrent cap** — there was one, five
rows and a *"+N more"* stand-in, but a row that isn't there is a row the
selection can't act on, so *Downloaded → Play* would quietly skip most of what
matched. The list caps at **100 rows in total** and says how many it cut;
narrowing the search is the way past that, and it's a control you're already
holding.

**Searching inside torrents starts at two characters.** One letter matches
almost every file in every release — a hundred rows that say nothing, fetched
the expensive way, since a single `a` would send the plugin off for file lists
across the whole library. Torrent *names* are still filtered from the first
character (that list is already in memory), and the view says which of the two
is happening rather than leaving you to guess why a search found less than you
expected.

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
point of the list is often to skip the 4 GB video extra. (Any click opens it,
modifiers included, as does double-click or Enter. The **files** inside a
torrent are a different matter — that list is multi-selection, with its own
Audio / Video presets and toolbar.)

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

Each row hovers only what it can actually do. A **Downloaded** media file gets
**▶ Play** and **+ Add to queue** — the bytes are on disk. A downloaded file
that *isn't* audio or video (cover art, an `.nfo`, a PDF booklet) can't be
played, so it offers **Open** and **Show folder** instead, when the files are on
this machine. Anything not yet downloaded is still a choice about whether to
fetch it, so it gets **↓ Download** *or* **⊘ Skip**, whichever it is not already
in — Play is absent there because it would act on a file that does not exist yet.
"Downloaded" is decided by the bytes on disk, not the selection, so a file you
downloaded and later *deselected* still reads Downloaded and still plays.

The list declares **all six** — the four above plus Open and Show folder — so a
mixed multi-row selection can reach any of them from the toolbar, and the shared
buttons stay in the same slot from row to row. (Declaring them is load-bearing:
the host only renders an action a row asks for *if the list declared it*. Open
and Show folder were missing from that declaration for several releases and
therefore never appeared at all.) Priorities you set in qBittorrent itself
(high, maximum) are left alone — this only ever switches a file between
*download* and *don't*.

## Playing from a torrent

**Play** on a file row plays **that file**, and on a multi-row selection exactly those files —
they become ordinary queue entries, with the usual right-click menu and
drag-to-queue. Hover a row for **▶ Play** and **+ Add to queue**.

Three things worth knowing:

- **Only finished files play.** A half-downloaded file would open and then stop
  partway through, which looks like a corrupt file rather than an incomplete
  download. Unfinished files are listed with their progress and marked `◌`.
- **Only audio and video play.** The cover art, the `.nfo` and the scans folder
  are listed — you may well want to *skip* them before they download, which is
  half the point of the list — and once one has finished it offers **Open** and
  **Show folder** rather than Play, so you can still reach the extras in a
  release.
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

The **Search** tab searches two sources at once and merges them: the **web
indexers** below (built in — no setup) and any **search plugins you have
installed in qBittorrent**. Results are sorted by seeders and stream in as each
source answers, with the site shown under each row.

### Web indexers

The plugin searches torrent sites directly, so search — and automatic
discovery (see "Playing and downloading ANY track from torrents") — works with no
qBittorrent search plugins at all. Four are built in and on by default:

- **The Pirate Bay** (via its JSON API), **Nyaa** (RSS), **1337x** and
  **TorrentGalaxy** (HTML).

Toggle each under **Settings → qBittorrent → Search …**, where a per-site health
note shows how it's doing this session. A site that's down or blocking you shows
as a single notice row (`web:1337x: HTTP 403`) and never sinks the others.

Each indexer is a **definition, not code** — a small JSON document saying how to
build the search URL and read the result rows. Under the indexer list you can
**view, export and import** these:

- **View JSON** (per site) drops that definition into the edit box — copy it, or
  tweak it and re-add it under a new id.
- **Export all** fills the box with every indexer as a single JSON array (a
  copy-out backup).
- The box **imports one definition or an array of them** — paste an exported set
  straight back in. Re-importing an id that already exists **updates** it. Bad
  definitions are rejected with plain-English errors, and a bad one in a batch
  aborts the whole import so nothing half-applies.

The format, briefly:

```json
{
  "id": "mysite",
  "name": "My Site",
  "siteUrl": "https://mysite.example",
  "type": "html",                       // "json" | "rss" | "html"
  "search": { "url": "https://mysite.example/search?q={q}" },
  "rows": { "selector": "table.results tbody > tr" },
  "fields": {
    "fileName":  { "selector": "td.name a" },
    "fileUrl":   { "selector": "a[href^=magnet]", "attribute": "href" },
    "fileSize":  { "selector": "td.size", "filters": [["parseSize"]] },
    "nbSeeders": { "selector": "td.se", "filters": [["parseInt"]] },
    "nbLeechers":{ "selector": "td.le", "filters": [["parseInt"]] }
  }
}
```

`{q}` is the URL-encoded query. For a **JSON** site, fields use `path` (a dot
path like `info_hash`) and `fileUrl` can be a computed `magnet` built from an
info-hash field. For **RSS**, fields use `tag` (e.g. `nyaa:seeders`). Filters
(`regex`, `parseSize`, `parseInt`, `prepend`, `append`, `querystring`, `replace`,
`trim`) clean a value up. If a site only exposes the magnet on the torrent's
detail page, add `"magnetFollow": { "selector": "a[href^=magnet]" }` and the
magnet is fetched lazily, only when you actually add that result. Selectors
support tag / `.class` / `#id` / `[attr]` / `[attr^=v]` / `[attr*=v]` /
compounds / descendant / `>` / `:nth-child(n)`.

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

With the web indexers on, the tab always has somewhere to search. If you turn
them all off *and* qBittorrent has no search plugins enabled, the tab says so and
tells you where to add them (qBittorrent → View → Search Engine → Search plugins)
rather than claiming nothing was found.

## Playing and downloading ANY track from torrents

The plugin registers with Viboplr as **two stream sources** (Settings →
Streaming → Source priority) and as a **download provider** — so a track from
anywhere in the app (library, playlist, another plugin's search results) can be
served out of your torrents.

The two Source-priority entries split by what a play may cost:

- **qBittorrent (downloaded)** answers instantly from files already here, and
  otherwise declines fast — put it high, it costs nothing.
- **qBittorrent (fetch & play)** may **download to answer**: a file an existing
  torrent holds is selected, started and waited out (up to 50s); a track in no
  torrent at all triggers the full **discovery** pipeline (search → score →
  examine → fetch one file), raced against the same budget. When time runs out
  the work keeps going in the background — the next source plays the track
  today, a notification announces the arrival, and the next play comes from the
  torrent. Put this entry *below* your other sources, so it fires only when
  nothing else could play; enabling it (plus *Search torrents for downloads*)
  is the consent for it to add torrents on a play.

Underneath, three tiers, cheapest first:

1. **Already downloaded.** The track is matched against every file your
   torrents hold (the same persistent name cache the list filter uses), the
   match is verified against the file's own tags when they can be read, and it
   plays instantly — straight off the disk.
2. **In a torrent, not downloaded.** Playing it can't wait for a swarm, so with
   *Fetch found tracks automatically* on, the file is selected and its torrent
   started — the play falls through to your next source (say, yt-dlp) today,
   and the torrent serves it tomorrow. A *download* of such a track does wait:
   the file is selected, the torrent started, and the download modal tracks it
   to completion.
3. **In no torrent at all.** With *Search torrents for downloads* on, a
   download for the track searches qBittorrent's search plugins (“artist
   album”, falling back to “artist title”), scores the results — seeders are a
   floor, not the ranking: format keywords weighted by your preferred format,
   size sanity, single albums over discographies — and examines up to three
   candidates by adding them **paused**, fetching their file lists, and looking
   for the exact track. The winner downloads **just that file**; every rejected
   candidate is removed on the spot.

**Matching is precision-first.** A wrong match plays the wrong song, so a title
match alone is never enough — the artist or the album has to appear in the file
path, the torrent name, or the file's tags, matching is diacritics-folded
(Jóga finds Joga), and a file whose tags or duration contradict the request is
rejected even after it downloaded.

**What happens to the winning torrent** is the *After a searched download
finishes* setting: **keep it seeding** (default — safe for private-tracker
ratios, and the rest of that release becomes instantly playable), import the
files and remove the torrent, or remove the torrent and keep the file. Torrents
added only for examination never linger: a janitor sweeps anything the resolver
left behind (a crash, a plugin reload) after ten minutes.

Two requirements, both checked before any work starts: the torrents' files must
be **reachable on this machine** (local qBittorrent, or the path mapping set),
and tier 3 needs **search plugins installed in qBittorrent** — without them the
resolver declines and says so once.

**Debugging a resolve.** The **Debug** tab is a workbench for exactly this
pipeline: enter a title/artist/album, run *Test play* (stream path) or *Test
download* (full tiers 1–3), and every step narrates itself with elapsed
times — the cache match and its score, search queries and ranked candidates,
each examined torrent, the file pick, download progress, and the final result
or the precise reason for the decline. It runs the real resolver, so a
download test can genuinely add torrents and download files.

## Not here yet

Planned: RSS auto-download rules for artists you follow, and playing a file
while it's still downloading.

This plugin controls a torrent client and searches public torrent sites; it
ships **definitions** for a handful of them but **no content of its own**, and
you can add or remove indexers freely.

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
