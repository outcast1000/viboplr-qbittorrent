# Changelog

## 0.25.1

**A "Not selected for download" file now offers only Download.** A file with
priority 0 that already had bytes on disk (a deselected file in an otherwise
complete torrent) read *"Not selected for download"* on its row but still
offered **Play** and **Add to queue** — the status ranked "skipped" first while
the buttons ranked "downloaded" first. Skipped now wins in both, so such a row
offers only **Download**, and it is no longer treated as playable by drag-to-
queue or the right-click menu either. The row and its actions finally agree.

## 0.25.0

**Search torrent websites directly — no qBittorrent search plugins needed.**

Until now every search (the Search tab AND automatic discovery) needed search
plugins installed in qBittorrent, which most people don't have. The plugin now
ships a Jackett-inspired **web indexer engine**: it searches torrent sites
itself and merges those results into everything — the Search tab, tier-3
discovery, fetch & play, and the Debug tab all gain web results with the site
shown as the source.

Four indexers are built in and on by default:

- **The Pirate Bay** (via its JSON API — rock solid),
- **Nyaa** (RSS),
- **1337x** and **TorrentGalaxy** (HTML).

Each is a **definition, not code** — a small JSON document describing how to
build the search URL and read the result rows. You can toggle each one in
Settings, and **paste your own** definition for any other site (validated with
human-readable errors before it's accepted); adding a site never needs a plugin
update. HTML is parsed by a tolerant built-in parser + CSS-selector subset, so
tag-soup result tables read correctly.

Robustness built in: indexers run in parallel with per-site politeness spacing,
a dead or blocked site is isolated (it shows as one "web:site: HTTP 403" notice
row and never sinks the others), unknown counts are omitted rather than faked,
and a site whose magnet lives on the torrent's detail page is fetched lazily —
only when you actually add that result, not for every row of every search.

## 0.24.0

**"Fetch & play" now goes and finds the torrent too.** 0.23.0's second
Source-priority entry only waited for files that existing torrents already
held — on a track in no torrent it declined exactly like the instant entry,
which made the two look identical. Now a cache miss on the fetch & play entry
triggers the full **discovery pipeline** (search → score → examine → download
one file, same engine, same janitor, same keep-seeding disposition), raced
against the 50-second stream budget:

- On a fast swarm a single track occasionally lands inside the budget and
  plays right then.
- Usually the budget wins: the entry declines so your next source plays the
  track NOW, the discovery job runs to its bounded end in the background, a
  notification announces the arrival, and the next play comes from the
  torrent.
- Replaying the track while its search is still running does not enqueue a
  second copy of the same job.

Gated on the existing *Search torrents for downloads* setting — enabling that
plus the fetch & play entry is the consent for adding torrents on a play. The
instant *(downloaded)* entry is untouched: it never writes anything.

## 0.23.0

**Two Source-priority entries instead of one, split by what a play may cost.**

- **qBittorrent (downloaded)** — what shipped before: answers instantly from
  files your torrents already hold, primes a found-but-undownloaded file, and
  otherwise declines fast.
- **qBittorrent (fetch & play)** — new: when an existing torrent HOLDS the
  track but hasn't downloaded it, this one selects the file, starts the
  torrent, and **waits for the download** (up to 50 seconds, under the host's
  hard 60s cap) — then plays it. On a healthy swarm a single track lands well
  inside that. If time runs out the download keeps running and the entry
  declines, so the next play is instant.

Order them to taste: *(downloaded)* high — it costs nothing; *(fetch & play)*
below your other sources, so it only fires when nothing else could play, which
is exactly when waiting is acceptable. Neither entry searches for NEW torrents
— adding torrents because a track failed to play would write to your client on
a trigger you never see; discovery stays on the download path.

The Debug tab gained a matching **Test play (fetch & play)** button.

## 0.22.1

**The Debug log now names the search string and the target.** Every lookup
line says where it ran — `[local cache]` (the persistent file-name cache) or
`[qBittorrent app]` (its search plugins) — and what it actually asked. For the
qBittorrent side that is the literal search string; for the cache, which is
token-matched rather than queried, it prints the **normalized** needles the
matcher really uses (`title “joga” + artist “bjork”`), so "why didn't it find
it" can be answered by reading the folded tokens against the folded filenames.

## 0.22.0

**A Debug tab for the resolver.** Type a title, artist and album into the new
**Debug** tab and run either half of the resolver against your real
qBittorrent — *Test play* for the stream path, *Test download* for the full
tiers-1–3 pipeline — and watch every step narrate itself with elapsed times:
cache match (with its score), file progress, tag verdicts, each search query
and its result counts, every ranked candidate with size/seeds/score, the
add–register–metadata–inspect walk per candidate, the one-file commit,
download progress by decile, the disposition, and the final result or the
exact reason for the decline.

The narration lives inside the real resolver functions and is a no-op unless
a debug run is in flight — so what the tab shows is what a real play or
download actually did, not a simulation. Which also means the download test is
not a dry run: it can genuinely add torrents and download files, and the tab
says so.

## 0.21.1

**Discovery searches the way torrents are named.** The query ladder is now
*artist album* → *artist alone*, with the bare title used only when the track
has no artist at all. The old second query, "artist title", asked indexers for
a torrent named after a track — which torrents almost never are — so its slot
now goes to the plain artist search, which catches singles, EPs and releases
whose name doesn't mention the album. The candidate filter still requires the
artist in the release name and the file matcher still finds the exact track
inside, so the broader query widens the net without loosening what qualifies.

## 0.21.0

**Any track in the app can now be served from your torrents.**

The plugin registers with Viboplr as a **stream source** ("qBittorrent" in
Settings → Streaming → Source priority) and as a **download provider**. Three
tiers, cheapest first:

- **Already downloaded** — the track is matched against every file your
  torrents hold (the same persistent name cache the list filter uses),
  verified against the file's own tags when readable, and plays instantly.
- **Held but not downloaded** — a *play* can't wait for a swarm, so the file is
  selected and its torrent started while the play falls through to your next
  source; the torrent serves it next time (the *Fetch found tracks
  automatically* setting). A *download* does wait, with live progress in the
  download modal.
- **In no torrent at all** — a download searches qBittorrent's search plugins
  ("artist album", then "artist title"), scores results — seeders are a floor,
  not the ranking: format keywords weighted by your preferred format, size
  sanity, single albums over discographies — and examines up to three
  candidates by adding them **paused** and reading their file lists. The winner
  downloads **just the one file**; every rejected candidate is removed on the
  spot, and a janitor sweeps anything a crashed job left behind.

**Matching is precision-first, because a wrong match plays the wrong song.**
A title alone never qualifies — the artist or album must appear in the file
path, the torrent name, or the tags; matching folds diacritics (Jóga finds
Joga) and strips remaster/feat. noise; a duration 30 seconds off is a
different recording; and a file whose tags contradict the request is rejected
even after it downloaded.

**The winning torrent keeps seeding by default** — safe for private-tracker
ratios, and the rest of that release becomes an instant local hit. The *After
a searched download finishes* setting can instead import the file and remove
the torrent, or remove the torrent and keep the file.

Also: an interactive picker (the download modal's search) lists candidate
torrents with size, seeders and source, and downloading a picked torrent runs
through the same select-one-file pipeline. The stream resolver declines fast
when qBittorrent is unreachable or its files aren't on this machine — it fires
for every track no other source could play, and hanging there would drag the
whole app.

## 0.20.0

**The files a search finds are now rows, not a clause in a subtitle.**

0.19.0 found files inside torrents but reported them as *matches "07 -
Jóga.flac" +2 more* squeezed into the front of an already-long torrent
subtitle — one filename shown, the rest hidden, and all of it the first thing
ellipsis ate on a narrow window.

- **A "Matching files" list renders under the torrents**: one row per found
  file — basename as the title, folder and torrent underneath, the file's
  media glyph over the torrent's progress badge. Clicking a row opens its
  torrent with the contents already narrowed to the matching files.
- **The torrent row keeps only the count** (*matches 3 files*) — it still
  explains why a torrent whose name says nothing is in the filtered list, and
  the naming now happens where there is room to read it.
- **Capped honestly.** A torrent matching an entire discography shows its
  first 5 with a *"+N more — open it to see them all"* row, the list tops out
  at 100 rows, and when that cap cuts anything the view says so instead of
  letting a truncated list read as the whole answer. The header carries the
  true total either way.

## 0.19.0

**The torrent list has a filter box, and it searches *inside* torrents.**

Space-separated terms, all of which must appear, matched as you type against
torrent names **and the file paths inside them** — `jóga flac` finds the
compilation whose release name never says Björk, and a folder name like `live`
finds every release carrying one.

- **A torrent pulled in by its files says why.** Its row leads with *matches
  "07 - Jóga.flac" +2 more* — otherwise a compilation showing up for a name it
  doesn't carry reads as a bug — and opening it lands on the contents already
  narrowed to those files.
- **The file lists come from a cache that fills itself, once ever.** The list
  was already fetching every torrent's full file list just to print its file
  count, then keeping only the number; the names are now kept and **persisted**.
  A torrent's hash *is* its file list, so an entry can never go stale — which
  also means file counts stop being refetched every session.
- **Typing turns the trickle into a burst.** The background count fetch runs at
  4 per poll so it never crowds the connection; against 1000 uncached torrents
  that is an 8-minute warm-up nobody typing into a search box will wait out.
  A typed filter switches the missing fetches to a bounded burst (6 in flight),
  filling results in as they land — about a minute for a 1000-torrent seedbox,
  once ever, then instant.
- **An unfinished search says so.** A torrent whose files aren't cached yet is
  *unknown*, not a non-match: the view reads *"Searching inside torrents — N
  still to check…"* and only says *"Nothing matches"* once everything has
  actually been checked.
- **Start all / Stop all honour the filter.** They have always acted on "what
  the list shows you"; with a filter typed, that is the filtered rows — *Stop
  all* over a filter for one release must not halt a hundred other transfers
  sitting off-screen.

## 0.18.0

**Tracks are named by the file, not by the filename.**

A queue entry from a torrent was pure filename guesswork: `parseFileTrack` saw
`03 - Björk - Jóga.flac` and nothing else, so a release numbered but not named
arrived with no artist at all, and every album was the raw torrent name —
`Radiohead - In Rainbows (2007) [FLAC 24-96]`.

- **Embedded tags now win**, via the host's new `api.system.readAudioTags`
  (Viboplr 1.0.28+). Title, artist, album, track number and — new — **duration**
  come off the file itself.
- **Merged per field, not all-or-nothing.** A file tagged with an artist but no
  track number still takes its number from the `03 - ` in front, and a file with
  no album tag still falls back to the torrent name. `album_artist` is only ever
  the second choice for artist: on a compilation it says "Various Artists" while
  the per-track artist is the one worth showing.
- **The file list says it too.** Tags are read once when a torrent's contents
  arrive, so the rows show real titles and artists — not just the queue entries
  built from them later. Rendering never triggers a read, so a 2000-file torrent
  doesn't probe 2000 files.
- **Nothing here can break playback.** A host too old for the API, a seedbox
  whose files aren't reachable from this machine, and an untagged release all
  fall back to exactly the filename parse this plugin shipped with.

**A file that isn't audio or video is no longer offered as one.**

Every release carries cover art, an `.nfo`, a folder of scans. A finished one
was offering **Play** and **Add to queue**, because the row asked only whether
the file had downloaded — pressing them queued nothing and then reported
"nothing there that's finished downloading" about a file the same row showed as
complete. It now offers nothing at all: there is nothing to play, and Download /
Skip are just as meaningless once the bytes are here. Unfinished files are
unchanged, since skipping a 4 GB video extra is a main reason to open the list.

**No category means no filter.**

Leaving the Category box empty is a supported choice — nothing is tagged — and
with no name to match against there is nothing to filter by, so every torrent in
qBittorrent is listed. That already worked in the list itself, but two places
disagreed: the stranded-torrents banner fired after clearing the box, announcing
that torrents were "hidden by the “” filter" while they sat in the list directly
underneath it (over a button that would have stripped their category in
qBittorrent), and the *Only manage my own category* switch described a filter
that wasn't running. Clearing is not a rename, so nothing is stranded and
nothing is offered; the switch now says it does nothing when no category is set.

## 0.17.0

**Search results are a list again, and the fields are in the order you read
them.**

Every result was a card: a title bar, a paragraph of details and two full-width
buttons. Four of them filled the screen and nothing could be compared against
anything else.

- **Name first, size second, swarm third.** The name is the row title and gets
  the full width; size moved to its own trailing column, where it can be compared
  down the list; seeders / leechers and the indexer sit underneath. Size is no
  longer repeated in the detail line.
- **"Add to qBittorrent" is now "⬇ Download"**, and it is a hover overlay button
  on the row like every other action in the app, alongside **📂 View contents**.
  Double-click or Enter downloads — the row list was dropped once before because
  a plain click did nothing, and a per-row action fixes that properly.
- **Multi-select works.** Click / Cmd-click / Shift-click, then Download the lot
  from the toolbar. *View contents* stays one at a time, and says so, because it
  adds a real paused torrent.
- **The thumbnail says what the torrent is, and whether it will download.** It
  used to be two arbitrary letters of the release name, drawn in the most
  eye-catching part of the row and meaning nothing. Now it carries both facts you
  choose on:
  - A **music note or a film strip**, read off the release tags: `FLAC` / `MP3` /
    `320kbps` / `24bit` / `vinyl` → audio, `1080p` / `x265` / `BluRay` / `S01E05`
    → video. Video wins when a name carries both, since a concert Blu-ray with a
    FLAC track is still four gigabytes of video. Tags match as whole tokens, so
    "24k Magic" isn't 4K and "Waves" isn't WAV, and a name with no tags at all
    gets a plain sheet instead of a guess.
  - A **colour-coded seeder badge** across the bottom — green above 100, yellow
    above 10, red at or below. Seeders decide whether a torrent downloads at all
    or sits at 0 B/s forever, and while scrolling a list you read a colour, not
    the third value of a subtitle sentence. An unreported swarm is a grey `?`,
    never red: "the indexer didn't say" is not a verdict on the torrent. Counts
    past 999 read as `1.2k`.
- **An unreported swarm reads as "swarm unknown"** rather than "0 seeders".
  Indexers send `-1` for "didn't report", and rendering that as zero was a
  verdict on the torrent that sent people past live results.
- Leechers now show at zero, so the fields stay in the same place on every row.

*View contents* already added the torrent paused (since 0.16.0) and still does;
the dead pre-0.16 fallback branch behind it is gone.

**Clicking a torrent opens it**, instead of merely highlighting the row. A
torrent is a container, and a click that only selected it read as nothing having
happened. Cmd/Ctrl-click and Shift-click still build the multi-selection the
toolbar acts on. (Needs the host's new per-list `openOnClick`; track lists
everywhere else keep click-to-select.)

With the row itself opening, the **📂 Contents** hover button is gone: it was a
third route to the same place, taking tray width from the actions that have no
other route. The tray is now ▶ Play · ⏵ Start · ⏸ Stop · 🗑 Remove.

**The contents panel is a detail page now.**

- **A plain hero**: the torrent's name at full size plus the **Back** button
  every detail page in the app uses. No artwork, background, motion look or FX
  picker — a torrent has no image of its own, so the full hero was a 320px
  scrimmed panel wrapped around a placeholder disc. (Needs the host's new
  `plain` flag on `detail-header`, which also overrides the hero's always-light
  text tokens: with no scrim behind them they'd be white text on the page.)
- **Start / Stop and Remove sit in the hero**, where every other detail page puts Play and Enqueue — those two verbs do not fit a torrent, so these replace the pair rather than sitting in a second bar underneath it. Nothing else at torrent level: Play moved to
  the file rows, where it acts on something actually on disk; *Add to library*
  went with the overflow menu (finished downloads still import automatically).
- **A file’s folder is part of its row title, relative to the torrent’s own
  folder** — *CD1 / Opening*, *extras / scans / front.jpg*. The name parser
  strips the path, so the list showed leaves only: two “01”s from CD1 and CD2
  were the same row twice, and a folder of scans looked like tracks at the root.
  The filter already matched on the full path, so this is also what makes a
  search for a folder name explain its own results.

  What is *not* shown is the folder every file shares. Almost every torrent
  wraps its contents in one directory named after the release, and the hero
  above the list already says it — repeating it per row was a column of the same
  words pushing the distinguishing part off the end. Any deeper folder holding
  every file goes too, leaving bare filenames. A file genuinely at the root
  means there is no shared wrapper, so nothing is stripped from anybody. It is
  computed across all files rather than the filtered view, so a filter narrows
  the list without re-titling what is left.
- **Play on a file row plays that file**, not the whole torrent from that point.
  The old behaviour borrowed the rule from a track list, but this list is a
  torrent contents — mostly not music — and a button on one file has only one
  reading. A multi-row selection plays exactly those files; an unfinished one
  says so instead of playing something else.
- **Each file row shows only the buttons that apply to it.** A downloaded file
  gets ▶ Play and + Add to queue and nothing else; anything still being decided
  gets ↓ Download *or* ⊘ Skip — never both, since they are the same
  decision in two directions and the one a file is already in is a no-op taking a
  slot. The list still declares all four so a mixed multi-row selection can reach
  either from the toolbar. (Needs the host's new per-item `actions` subset;
  order always follows the declared list, so the buttons two rows share stay in
  the same slot instead of shuffling.)
- **A file's size moved onto its detail line**, after the status — *Downloading ·
  40% · 28 MB* — the same move the torrent rows got, for the same reason: a
  trailing column put two figures that are read together at opposite ends of the
  row. Skipped files show it too; it's the number you're deciding on.
- **Split into two tabs.** **Files** — the filter and the list — is what the
  panel is for, so it's first and the default. **Info** is the numbers, as
  **plain text** rather than stat tiles: Transfer, Swarm, and Files-and-location,
  including availability, tracker count, last-full-copy-seen, save path and hash.
  Headings look like headings and values line up in a column — two generic host
  classes (`plugin-heading`, `plugin-kv`) rather than qBittorrent-specific CSS,
  since a block of reference facts is a shape any plugin view may need and the
  only alternatives were stat tiles (right for a few headline numbers, wrong for
  twenty rows) or "Label: value" text with nothing to align against.
  Speeds and a time-left now appear only while the torrent is *actually moving* —
  gating on "not finished" still printed "Download speed: —" and "Time left: ∞"
  on a stopped torrent, which reads as a fault rather than as something you
  paused.

**Fixed: the now-playing source panel showed `qbt://<hash>/3` instead of the
file path.**

The stream resolver returned a bare URL string, which has nowhere to carry a
`sourceUrl` — so the host had nothing to describe the track with but its own
URI. It now returns the one-candidate object form with `sourceUrl` set to the
resolved `file://` path (the host treats a one-candidate list exactly like a
bare URL, so nothing else changes). The panel shows the real path and its
**Open folder** button works.

The track keeps its `qbt://` path on purpose: that is a late-binding handle,
re-resolved through qBittorrent every time it plays, so it survives the file
being moved on completion, the save path changing, or a path mapping being
edited — none of which a `file://` frozen into the queue would.

**Fixed: the open torrent file list never updated.**

Click Download on a file, watch qBittorrent fetch it, and the row sat at
*Downloading 0%* for ever. Play then refused it — "nothing finished downloading
in this torrent yet" — about a file that plainly had, and its row never gained a
`path`, so drag-to-queue and the right-click menu were dead on it too. All one
cause: `/sync/maindata` describes **torrents**, and a torrent file list is a
separate endpoint that was only ever read when the panel opened and after a
priority change. Nothing re-read it while you watched.

The contents panel now re-reads the open torrent file list on each poll — one
request, only while a panel is open, quiet on failure (it keeps the list it has
rather than raising a toast over a working view), and it only re-renders when a
progress or priority actually moved.

**Fixed: a deselected file read "Downloading 0%".**

Two separate defects, both of which made the contents list say the opposite of
the truth:

- **A priority that arrived as the string `"0"` was read as 1.** The parser
  gated on `typeof f.priority === "number"`, which a string fails, so it fell
  through to the default of "download this one" — and a file the user had
  deselected came back marked for download. Every field from `/torrents/files`
  is now coerced with `Number()` instead, so `"0"` means zero. `index` had the
  same bug and it was worse there: a string index fell back to the file's
  position in the array, which sends `/torrents/filePrio` at the wrong file.
  Where a default is still needed, the safe direction wins.
- **"Downloading" was asserted from the file alone.** Whether a selected file is
  actually transferring depends on the *torrent*, not the file, so every file in
  a stopped, paused or errored torrent claimed to be downloading at 0%. Files
  now have four states — *Not selected for download*, *Selected · 40%*,
  *Downloading · 40%*, *Downloaded* — in four distinct tile colours.

**"View contents" now leaves the torrent armed, not parked.**

It added the torrent paused with every file selected, showed you the list, and
waited for a *Start download* press — a step that stood between you and the
thing you had just chosen, and one that started everything if you forgot to
deselect the 4 GB video extra first.

Now, as soon as the file list arrives, the torrent is **started with every file
set to skip**. Nothing transfers, because nothing is selected. **Including a
file downloads it on the spot** — picking the files *is* the decision, so there
is no second button. Deselecting one is not a decision to download anything, so
it doesn't start it.

The order is the safety of it, and it is asserted as an order: deselect first,
*then* start. The reverse downloads the whole release. Arming also verifies that
qBittorrent really did deselect everything before it starts anything — the
client silently keeps a completed file's priority — and falls back to the old
paused hold if any of that fails, rather than claiming a state it didn't reach.

**The trap this had to be built around:** a torrent with nothing selected has
nothing left to want, so **qBittorrent reports it as 100% complete and starts
seeding it**, having downloaded none of it. Everything that reads "is this
finished?" now asks a different question first, so a parked torrent is not
counted as Finished, not coloured green, not shown at 100%, not announced as a
finished download, and not imported into your library. The check is on the
files, not on the flag that got us there, so deselecting everything by hand is
handled the same way.

Its size column also switched to the torrent's real size: with nothing selected
qBittorrent reports the *wanted* size, which is 0 B.

**The Torrents tab is a list too, on the same rules.**

Every torrent was a card — title bar, paragraph, progress bar and up to six
full-width buttons — so three transfers filled the screen and nothing could be
compared against anything else. It is now the same row list the Search tab uses:

- **Name first, everything else on one detail line**: status · file count · size
  · transfer · swarm. Size sits with the file count rather than in a trailing
  column — the two answer one question and a column pulled them to opposite ends
  of the row. (A *search result* keeps its size column: there you compare sizes
  down a list of candidate releases, so the column earns its place.) The size is
  the torrent's real weight, since qBittorrent's `size` is only what is
  currently selected and reads 0 B when nothing is. The file count is fetched
  once per torrent and cached (the torrents endpoint doesn't report it) and is
  omitted for a torrent qBittorrent won't describe — including when it answers
  with an empty list, which would otherwise print an impossible "0 files".
- **Seeds and leechers show connected out of total** — *12/40 seeds · 3/9
  leechers*. Either figure alone misleads: 2 connected is a routing problem if
  300 exist and a dead release if 2 do. A total the tracker hasn't reported is
  left off rather than rendered as `-1` or faked as 0.
- **The tile carries the percentage, coloured by state** — blue transferring,
  green complete, yellow stalled or waiting on you, grey stopped, red errored.
  Colour is the *state*, not the number: 90% stopped and 90% downloading are the
  same figure and completely different situations. The percentage floors rather
  than rounds, so 99.7% never reads as finished.
- **Actions are hover overlay buttons**: ▶ Play, ⏵ Start, ⏸ Stop, 📂 Contents,
  🗑 Remove. Double-click opens the contents — for a container that is what "open
  it" means. Multi-select works: Start / Stop / Remove take the whole selection,
  and Remove asks once, naming the count rather than pasting twelve release names
  into a dialog.
- **No separate Pause, deliberately.** qBittorrent has Start and Stop and nothing
  between them — WebAPI 2.11 renamed pause/resume to stop/start precisely because
  they were one pair — so two buttons posting to the same endpoint would be a lie
  about what the client can do.
- **Contents replace the list instead of expanding the row.** A file list nested
  inside a row of another list left no way to tell where the torrent ended. The
  panel carries the torrent's name, its buttons, a ← Back, and everything that
  doesn't fit in a row's overlay tray: the file-selection hold, *Download only
  the audio*, and *Add to library*. It survives its torrent being removed
  underneath it rather than rendering an empty page.
- **Each file states whether it is selected for download, then its progress** —
  *Not selected for download* / *Downloading · 45%* / *Downloaded*, and the same
  on its tile as a grey `skip`, a blue percentage or a green `100%`. A row that
  only said "45%" left "is this one even coming?" unanswered, which is the
  question the contents list exists to settle. The `⊘`/`◌` name prefixes are gone
  — a third copy of the same fact glued to the front of every filename.

**One torrent list instead of three tabs.**

`Downloading`, `Completed` and `All` were three filtered views of the same rows,
filtered on a fact each row already printed. Worse, the filter moved things: a
torrent that finished vanished from the tab you had been watching it in and
reappeared in another one, which reads as "it disappeared".

They are now a single **Torrents** tab, and status does the work the tabs were
doing:

- **Each row leads with its status** on its own line — *Downloading*, *Seeding*,
  *Paused*, *Complete*, *Fetching metadata*, *Waiting for you*, *Error* — rather
  than as the first grey item in a run of sizes and speeds.
- **The order is triage.** Torrents waiting on a decision first (they are the
  only rows that stop making progress until touched), then errors, then anything
  transferring, then queued/stalled, then paused, then finished. Most recently
  added breaks ties, as before.
- **The count lives on the tab.** (An *Active* / *Finished* / speeds / free-space
  stats row above the list was tried and removed — the per-row status and tile
  already carry the same facts, and a server-wide summary is not what you open a
  torrent list to read.)
- **Start all / Stop all** now act on the whole visible list rather than on
  whichever tab happened to be open — still bounded by the category filter.

## 0.16.0

**One way of showing a torrent's contents, and it's the one that works.**

`View contents` used to try qBittorrent's `torrents/fetchMetadata` first and fall
back to adding the torrent paused. That path is gone: it never passed the
`downloader` parameter, so for the page-style links most indexers return it
failed exactly the way adding used to — and it only exists on very recent
qBittorrent builds anyway.

Now **View contents always adds the torrent paused** and shows the file list as
it arrives. Nothing downloads until you press Start download, and Discard removes
it again. Verified against a live qBittorrent: added paused at 0.00% with no
transfer, 53 files listed, discarded cleanly.

## 0.15.0

**Adding a search result actually works now.** Verified end to end against a live
qBittorrent: search → add → downloading.

- **Results whose link is a description page now resolve.** Most indexers return
  an HTML page rather than a `.torrent`, and qBittorrent can turn one into the
  other — but only if it is told which search plugin produced the result. It
  wasn't, so qBittorrent fetched the page, failed to parse it as a torrent
  (`expected value … in bencoded string`) and discarded it — *after* answering
  "Ok." to the add. Hence "Added to qBittorrent" and nothing there.
- **An add that produces nothing now says so**, instead of reporting the
  acknowledgement as success, and points at qBittorrent's log for the reason.
- **A search plugin's own error rows are shown as warnings**, not as fake
  torrents. A misconfigured indexer (a Jackett API-key error, say) reports its
  failure as a result row complete with a "download" link; offering that as a
  torrent was nonsense, and hiding it entirely would leave the indexer silently
  missing from every search.

## 0.14.2

**Fixes clicking a search result doing nothing.** Each result is now its own
block with **Add to qBittorrent** and **View contents** buttons that are always
visible.

They used to be rows in a compact list whose buttons appeared only on hover — and
in that list a plain click does *nothing at all*: the host treats it as selecting
the row, and fires the row's action only on double-click. So a click on a result
genuinely did nothing, which is what it looked like. Introduced in 0.6.0, by the
change meant to *give* results a visible button.

## 0.14.1

- The required qBittorrent version is **5.2.3**, not 5.2.4.
- **A download link.** "Update qBittorrent" isn't an instruction anyone can act
  on without going off to find the download, so the setup steps now carry a
  **Get qBittorrent** button — promoted to a prominent **Download qBittorrent
  5.2.3 or newer** when the version is what's blocking you. If the browser can't
  be opened, the URL itself is shown, since that was the answer all along.

## 0.14.0

**Breaking: sign-in is now an API key only, and qBittorrent 5.2.4 or newer is
required.**

- **The username and password fields are gone.** An API key has no login round
  trip, no session to expire, no cookie whose name changes between versions (it
  did, in 5.2), and nothing the failed-login IP ban can lock you out of. Keeping
  both meant two auth paths and a session layer that existed only for the weaker
  one.
- **If you had credentials saved**, the plugin says so once and points you at
  Tools → Options → Web UI to create a key. Nothing else changes.
- **qBittorrent below 5.2.4 is now called out explicitly**, rather than letting
  you hunt for a key your build can't create.
- **A Settings tab in the Torrents view**, so the configuration is one click from
  the sidebar. There's no plugin API for opening the host's Settings page at a
  given panel, and sending you off to find it is the wrong answer when the view
  is where you already are. When nothing is configured the view also offers an
  **Open settings** button. Both surfaces render the same controls.
- "Bypass authentication for clients on localhost" still works with no key at
  all.

## 0.13.0

**Sign in with an API key** (qBittorrent 5.2+), as an alternative to a username
and password.

- New **API key** field in Settings → qBittorrent. Create one in qBittorrent
  under Tools → Options → Web UI and paste it in; it replaces the credentials.
- No login step at all — the key rides on every request — so there is no session
  to expire, no cookie whose name can change between versions, and nothing that
  qBittorrent's failed-login IP ban can lock you out of.
- A refused key says exactly that, rather than being reported as a bad password
  or as a lapsed session. There is no password to check and no login to retry, so
  it would have sent you to the wrong place.
- The Status panel shows which sign-in is in use.

## 0.12.1

**Fixes login failing on qBittorrent 5.2 and newer.**

5.2.0 renamed the WebUI session cookie from `SID` to `QBT_SID_<port>` (e.g.
`QBT_SID_8080`). The plugin looked for `SID`, found nothing, decided the server
was running without authentication, and sent no cookie on any request after the
login — so everything came back 403 and it looked like the username and password
had stopped working. Upgrading from 5.1 to 5.2 was enough to trigger it.

The cookie's name is now read from the response and sent back as given, so 4.x,
5.0, 5.1 and 5.2+ all work. If a future version renames it again and sets just
the one cookie, that is used too.

## 0.12.0

**A real download window**, like qBittorrent’s own add dialog: see what is
inside a torrent and choose files while *nothing has been added at all*.

- **View contents** now asks qBittorrent for the metadata without adding
  anything (`torrents/fetchMetadata`). You get the name, the size, the file
  list, per-file include/skip and an “Only the audio” shortcut — then **Add and
  start** adds it with your choices already applied, or **Cancel** leaves
  nothing behind.
- The size readout tracks your selection, so you can see what you are actually
  about to download versus the full torrent.
- **Falls back automatically.** `torrents/fetchMetadata` only exists on
  qBittorrent master — no release up to 5.2.3 has it — so on those the plugin
  says so and adds the torrent paused as before. The endpoint is probed once per
  session.

## 0.11.2

**Fixes “Added, but it couldn’t be matched to a torrent in the list.”**

- **The wait was too short.** Given an http link, qBittorrent answers “Ok.” on
  accepting the URL and then goes off to fetch the .torrent from the tracker.
  Eight seconds cut that off while it was still working; it now waits 25, with
  a counter and an explanation once it passes ten.
- **The torrent is now also matched by name**, not only by info hash or by
  spotting a new entry — which catches a torrent already in your list, and one
  the list diff missed.
- **The failure message no longer misleads.** For an http link, “Ok.” never
  meant a torrent was obtained, so telling you it was “paused, find it in the
  list” sent you looking for something that may not exist. It now names the
  usual cause — a private tracker that needs a login, or a link that is really a
  web page — and suggests the magnet instead.

## 0.11.1

**Says what it is doing while a torrent is being looked up.** The wait was
mostly blank, and briefly wrong.

- The seconds between adding and the torrent appearing now show *“Adding to
  qBittorrent — waiting for it to appear…”* instead of nothing. The toast that
  announced the add had already dismissed itself by then.
- While the file list is being fetched the row says *“Asking the swarm what’s in
  this torrent (12s) — nothing is downloading. A magnet can take a minute.”*
  The counter is what answers “is this still working?”.
- The file area shows a spinner during that wait. It used to be blank, under a
  banner already claiming “this is what’s inside”.
- **Start download** stays disabled and reads *“Waiting for the file list…”*
  until there is actually something to choose from.

## 0.11.0

- **View contents** button on every search result, beside Add. It shows what is
  inside a torrent before you commit to it: the file list opens, nothing
  downloads, and the row offers **Start download** or **Discard**.
- Works whether or not “Choose files before downloading” is on — pressing it is
  itself the request to look first.

qBittorrent has no way to read a torrent’s file list without adding it — the
metadata comes from the swarm or the .torrent itself — so View contents adds it
paused and Discard removes it again. Nothing is downloaded either way, and
Discard never deletes files from disk.

## 0.10.1

**Fixes clicking a search result doing nothing**, especially with “Choose files
before downloading” on. Three silent failures, all of which looked identical
from the outside:

- **The new torrent was looked for too early.** qBittorrent registers it a
  moment after answering the add, so the first look found nothing and gave up —
  leaving a paused torrent with no banner and no explanation. It now waits for
  it to appear.
- **Search rows were keyed by list position.** Results stream in and re-sort by
  seeders on every poll, so a click during a live search could hit a different
  result or nothing at all. Rows are keyed by URL now.
- **A result with no download link did nothing at all.** It now says so, and
  opens the result’s page if it has one.
- If qBittorrent puts the torrent outside your category, that is now called out
  rather than leaving it invisible in the very list holding the Start button.

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
