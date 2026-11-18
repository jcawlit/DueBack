# Robustness pass — what changed

Everything below is JavaScript unless marked **native**. The one native change
is the x86\_64 build for the emulator, which does not affect the phone.

---

## Books added from the phone were destroyed on every relaunch

**The worst bug found.** An imported book is stored with
`local_status = 'checked-out'` and its audio in `imported/<id>/`. On launch,
`reconcileLocalCopies` checks that a checked-out book's files are really there —
but it only ever looked in `books/<id>/`. It therefore decided every imported
book had no files, reset it to "on the shelf" and cleared its part paths. The
audio stayed on disk, orphaned, and the book became unplayable.

Reconciliation now checks the paths each book actually recorded, so it is
correct wherever the files live. Covered by an on-device check that imports a
book and then runs reconciliation against it.

*`src/store/library.ts`, `src/db/books.ts` (`checkedOutLocalParts`)*

## A fresh import was stamped "NOT ON DRIVE" by the next scan

`markMissingExcept` began with `UPDATE books SET missing = 1` across the whole
table before clearing the books it had just seen. A book added from the phone
and not yet copied across was never on the drive, so a drive scan is no evidence
that it has gone from it — but it got swept up anyway, every single scan.

The sweep now skips phone-only imports.

*`src/db/books.ts`*

## Checking out certain books failed with "Illegal character in path"

`expo-file-system` builds every local file as `File(URI.create(uri))`, and
`java.net.URI` is the strict RFC 2396 parser: it rejects all non-ASCII and the
`` [ ] { } | ^ ` " < > `` set, while the JS side only percent-encodes spaces,
`%`, `?`, `#` and control characters. Any book whose filename carried an
accented letter, a curly apostrophe, an en dash or `[Unabridged]` failed the
entire copy.

Local copies are now named `0000.m4b`, `0001.mp3` — index plus extension, with
nothing carried over from the drive. Nothing read those names: ordering and
every displayed name live in the database, and the drive keeps the originals.
The same fix covers phone imports, which had it too.

*`src/lib/files/localNames.ts` (new), `copy.ts`, `import.ts`*

## Deleting a book from the drive, then trying to check it out

The drive being reachable says nothing about one book still being on it. A
folder deleted on a computer left the index pointing at files that had gone, and
the copy died partway through with a native error, leaving the book on the shelf
still offering a check-out that could never work.

A copy now verifies its source files before it starts. If they are gone it says
so plainly and marks the book as off the shelf immediately, rather than leaving
you to work out that a rescan was needed.

*`src/lib/files/copy.ts` (`source-missing`), `src/store/library.ts`*

## The app never noticed the drive's contents had changed

Plugging the drive in only ever confirmed the folder was readable. Nothing
re-read it, so anything added or deleted on a computer stayed wrong until
someone thought to rescan by hand.

The index now re-syncs whenever the drive appears. An incremental scan skips
every book whose files are unchanged, so it costs a tree walk; it runs behind
the existing progress bar and cancels from Settings like any other scan. It runs
once per connection, and a folder you pick yourself still gets the full forced
read rather than losing a race with it.

*`src/store/scan.ts` (`syncOnConnect`), `src/app/_layout.tsx` (`DriveSync`)*

## Two check-out paths with different rules

`checkOut` refused a book missing from the drive but allowed a DRM-protected
one. `checkOutAndPlay` did the opposite, and never re-proved the drive was
actually there. Each had a route that started a copy certain to fail.

Both now share one pre-flight — DRM, missing, budget, real free space — and both
prove the drive is readable before copying. Where `checkOut` falls back to a
hold, `checkOutAndPlay` says so out loud, because you asked to listen now.

*`src/store/library.ts` (`refusalFor`, `proveDriveReachable`)*

## Five held books started five simultaneous copies

Plugging in with several books on hold fired every copy at once, turning a
sequential read off one USB stick into thrashing and running a progress poller
per book. Holds are now copied one at a time, and the budget is measured against
what is already queued so a batch cannot overspend it.

*`src/store/library.ts` (`flushHolds`)*

## A library root without a trailing slash silently found nothing

`expo-file-system` treats a directory URI with no trailing slash as a file:
listing it throws, the scan records the root as unreadable, and you get zero
books with no error — an unreadable folder is not an error. The system picker
happens to return the slash, so this only bit a root arriving from anywhere
else. Root URIs are normalised now, and a folder that cannot be listed records
*why* instead of just its path.

*`src/lib/files/access.ts` (`asDirectoryUri`)*

---

## Grouping, round two — what the device suite found

### One book per folder; the filename heuristic is gone

`groupIntoBooks` used to split a folder whenever its filenames varied once
digits and part markers were stripped. It was wrong in both directions. It
shattered a self-recorded book into one book per recording, turned
`00 - Intro`, `01`…`10`, `99 - Credits` into three books, and split a book
whose parts were named `01 Prologue`, `02 Chapter 1` because "Chapter 1"
stripped to nothing and "Prologue" did not — while *also* leaving two unrelated
single files merged, because it demanded more files than distinct keys.

Album tags are now the only evidence used to split a folder, and that decision
happens in the scanner where the tags have been read. A folder with no tags at
all is one book.

The library root is the exception: it is not a book folder, so audio sitting
loose at the top of the drive is one book per file, identified by its own path.

### A file with nothing in it is not a part

A zero-length file, one the parser cannot open, and one that yields no duration
are all unplayable. They used to be laid into the timeline anyway, giving a book
phantom parts that produced silence and threw the whole-book position out. They
are no longer parts. A book left with no parts is still listed and flagged, and
refuses check-out with an explanation rather than copying nothing and failing to
play later.

### Chapter data is cleaned once, at scan time

Real chapter marks arrive out of order, duplicated, past the end of the audio,
and with no titles. Everything downstream assumes a sorted list — `chapterAt`
walks it in order, the scrubber measures against it, previous/next steps through
it — so `sanitiseChapters` now sorts, drops marks at or past the end, collapses
marks sharing a start, and names blank titles `Chapter N` so the lock screen
never shows an empty line.

### Two writers, one database

The worst bug in this pass, and the hardest to see. Plugging the drive in does
two things from the same event: it starts a re-sync scan, and it flushes any
holds. So a scan writing a few hundred rows and a check-out recording where it
put its files reached SQLite at the same moment, and one of them lost —
first with `cannot start a transaction within a transaction`, and then, once
the transactions were made exclusive, with `database is locked`.

The book was left pinned at `copying` with its files already on disk. Nothing
ever resets that state, and because `copying` is deliberately never written to
the database, not even a relaunch could clear it.

Fixed in three places, because it needed all three:

- Every write in `books.ts` uses `withExclusiveTransactionAsync`. The
  `expo-sqlite` docs say plainly that `withTransactionAsync` is not safe when
  calls can interleave, which here they always could.
- `PRAGMA busy_timeout = 8000`. There was none, so a locked database failed on
  the spot instead of waiting a few milliseconds. WAL was already on; the
  timeout was the missing half.
- Holds wait for a running scan to finish before copying, via a small flag in
  its own module — the scan store already imports the library store, so the
  reverse would be a cycle.

Two supporting fixes came out of the same hunt. A copy that throws now returns
the book to the shelf and says why, rather than stranding it; and only one copy
per book can run at a time, because `checkDrive` flushes holds and is called
from the foreground handler, the Settings button and the drive watcher, so two
overlapping calls could start two copies fighting over one staging folder.

### Returning a phone-only import removes it there and then

An earlier entry below claims returning the last copy of an import removes it
from the library. That was only half true: `returnBook` deleted the files and
marked the book "on the shelf", and the row was not dropped until the next
launch, when startup reconciliation noticed. In between, the library showed a
book with no copy anywhere that could never be checked out and never played.
The device suite caught it (IM-D). `returnBook` now removes the row itself and
says so — "was only on this phone, so it has been removed from the library".

### Startup removes orphaned copies

Folders under `books/` that no checked-out book claims are deleted on launch.
They occupied real space while being invisible to the storage ruler.

---

## A review pass, and the five things it found

A read-through of the codebase raised seventeen questions. Five were real
bugs, and two of those were a tap away from doing visible damage.

### Pressing Rescan with the drive unplugged marked the whole library missing

The worst of them. `rescan()` only checked that a folder had been *chosen*,
never that it could be *read*, and both Settings rescan buttons are enabled
whenever a folder is chosen. `listTree` does not throw when the root has gone —
it records an unreadable folder and returns an empty listing — so the scan
"saw" nothing, and reconciliation duly stamped every book NOT ON DRIVE.

There are now two defences. `rescan` refuses outright when the root is not
reachable and says so, which is what the user meets. Behind it, the scanner
reports whether the root was readable at all and declines to reconcile when it
was not. `listTree` establishes that by asking whether the folder exists rather
than by waiting for an error that never comes — the detail that hid this.

*`src/store/scan.ts`, `src/lib/scan/scanner.ts`, `src/lib/files/access.ts`*

### Cancelling a scan marked everything it had not reached yet

The same reconciliation, the same mistake from the other direction: cancelling
broke out of the read loop and then ran the sweep anyway, with only the books
read so far counted as seen. Cancel at ten per cent and the other ninety were
flagged. A scan that was stopped is not evidence about what is on the drive, so
it no longer reconciles, and it no longer counts as "last scanned".

### Copying a book to the drive could leave half of it there

Copying *onto the phone* has always staged in a temp folder and moved the
result into place; copying an imported book *onto the drive* wrote straight
into the destination. A failure partway left a folder holding half a book,
indistinguishable from a real one to the next scan — on the drive, which is
the one place nothing else holds a copy of.

It now stages and moves, and it never writes over a folder that is already
there: a name that is taken gets a numbered suffix, the way a desktop would,
because the existing folder may be a different book that happens to share a
name.

Writing the test for this turned up two more faults in the same function, both
invisible by reading. The destination file was created before being copied
onto, and `copy` refuses to write over an existing file — so copying an import
to the drive could not have worked at all. And `move` updates the instance it
is called on to point at the new location, so the tidy-up afterwards was
deleting the book it had just put in place.

*`src/lib/files/import.ts`*

### Imported books kept files with no audio in them

The drive scanner has always refused to make a part out of a zero-length or
unreadable file. The import path laid them into the timeline with a duration of
zero, giving a book phantom parts that played silence and pushed every later
part out of step with the real audio. Imports now apply the same test, and an
import with nothing playable in it is refused with a plain message rather than
saved as an unplayable row. Only the parts that survived are recorded as the
book's local files.

*`src/lib/scan/importBook.ts`, `src/store/library.ts`*

### Phone-only audio and Android backup

`imported/` was not excluded from backup, which was an open question rather
than a bug. It is now excluded from **cloud backup** and kept in **device
transfer**. Cloud backup allows about 25 MB per app, which no audiobook fits
inside, so including it there would only burn the quota and fail. Device
transfer has no such cap, and phone-only audio is by definition the only copy
there is — exactly the case where losing it would hurt.

*`plugins/withBackupExclusion.js`*

---

## Finding a book, and knowing what you are looking at

Three gaps that only show up once a library is big enough to be real.

**Search.** With several hundred books, scrolling is not a way to find
anything. The Library header now has a search field that looks at titles,
authors and narrators at once. It is deliberately forgiving rather than clever:
accents and punctuation are folded away, so "les miserables" finds
*Les Misérables* and "hitch hikers" finds *Hitch-Hiker's*; the words can come
in any order, so "simmons hyperion" and "hyperion simmons" are the same
search. Matching is on word beginnings, not fragments anywhere in the text —
"sim" finding Simmons is what someone typing three letters wanted, while "son"
finding it is noise. A search that matches nothing says so, quotes the query
back and offers one tap to clear it, rather than showing empty shelves. While
searching, the header counts "3 of 412".

*`src/lib/library/search.ts`, `src/components/NoSearchResults.tsx`,
`src/components/LibraryHeader.tsx`, `src/app/index.tsx`*

**The same book in two places.** A library that has been copied between drives
for years ends up with the same book in two or three folders. The scanner is
right to index each separately — they are different files in different places,
and one may be kept deliberately — but there was no way to find out, so a book
could be checked out, stored and listened to while its twin sat on the next
shelf taking the same space again. The Book screen now lists the other copies
by folder path, with "on your phone" against any that are checked out, and each
one is tappable. Nothing is deduplicated automatically. Matching is on title
and author folded the same way search folds them, and deliberately *not* on
duration or byte size: an abridged edition beside the full one is exactly the
pair worth pointing out.

*`src/lib/library/duplicates.ts`, `src/app/book/[id].tsx`*

**The DRM stamp.** A DRM-protected book was refused at check-out with a
message, which is too late — the whole point is to stop someone trying. The
flag now carries a rubber stamp struck across the cover itself, so a dozen
Audible downloads are visible from the shelf, and the Book screen explains in
plain English what the file is and why nothing can play it. The stamp scales
from the cover's width, so it reads the same on a 56px tray thumbnail as on the
hero cover, and a screen reader hears it too.

*`src/components/CoverBadges.tsx` (`DrmStamp`), `src/components/BookCover.tsx`,
`src/components/NoteCard.tsx`, `src/app/book/[id].tsx`*

## The phone running out of room, for real this time

Three cases in the test plan could not be run, because filling an emulator's
userdata image to within a gigabyte of full takes minutes and risks taking the
test run down with it. They are now driven by a fault-injection hook that
substitutes the two facts the filesystem reports — how much space is free, and
whether a write succeeds — and leaves every line of the recovery path alone.

Running them found a real defect. A disk that fills *partway through* a copy
surfaces as a native `ENOSPC`, which fell into the generic catch and showed the
user "ENOSPC: No space left on device, write. Nothing was saved." That is not a
sentence to show anyone, and it was classified as a failure to retry rather
than what it is — the phone is full. It now returns the same `no-space`
outcome as the up-front check, with "The phone ran out of room partway
through." The up-front check genuinely cannot catch this case: another app can
take the room while the copy is running.

*`src/dev/faults.ts`, `src/lib/files/copy.ts`*

---

## Library grouping

### CD and disc subfolders are one book

`Dune/CD 1` and `Dune/CD 2` were two books, which is wrong for almost every CD
rip. A folder whose name is a disc marker is now filed under its parent, so
every disc of a set lands on one book.

The matching is deliberately narrow — `CD 1`, `Disc 2`, `Disk_03`, `CD 1 of 3`.
`Part 1` is excluded: a folder called that is as likely to be the first book of
a series as the first half of one, and wrongly merging two books is much harder
to notice than wrongly splitting one.

Ordering had to change with it. Both discs number their tracks from 1 and both
contain a `Track 01.mp3`, so sorting on the filename interleaved them. Parts
now sort by path.

### A folder of different albums splits into separate books

A folder of short works — children's stories being the usual case — gives every
file its own album tag. Where every file carries one and they name different
works, the folder is treated as a shelf and each album becomes a book.

Disc markers are stripped before albums are compared, so a rip tagged
*Dune, CD 1* and *Dune, CD 2* stays one book; without that, this would have
undone the disc merging above.

This needed the scanner restructured: album tags are not known until after the
metadata read, so a folder now yields one *or more* books. The incremental
rescan is keyed on the folder rather than on a book id, because the decision to
re-read has to be made before the number of books in it is known — and a
skipped folder takes its book ids from the database, so its books are not swept
up as missing.

### "Various Artists" is not an author

Placeholder tags — `Various Artists`, `Unknown Artist`, `VA`, `N/A` and friends
— are treated as absent. They filled the author line with a word that is not a
name, and stopped the folder, which often carries the real author, from being
consulted at all.

### A parent folder's cover is inherited

A book with no artwork of its own now looks outwards through its parent
folders. The search stops before the library root: a stray image at the top of
a drive is usually a logo or an unrelated download, and stamping it on every
coverless book would be worse than the generated covers they already get.

### Hidden and system junk is invisible

`._AppleDouble` siblings, `.DS_Store`, `Thumbs.db` and `desktop.ini` are
dropped during the tree walk, so they are never books, never parts, never
counted as skipped files, and never offered as cover art. Counting them as
"skipped" was technically true and completely useless.

---

## Earlier in this pass

- **Library scrolling.** 400 books were mounted at once in a `ScrollView`;
  now virtualized, with memoised shelves.
- **Lock screen.** The chapter was written to `albumTitle`, which Android's
  media controls do not display — it now goes in `artist`, the visible second
  line. `setActiveForLockScreen` releases and rebuilds the MediaSession, and was
  being called on every chapter change; it is now called once per book, with
  `updateLockScreenMetadata` for text. That was the half-second flicker.
- **`chapterAt` crash.** Indexed into an empty `chapters` array, so a book with
  no chapter marks took the player down. It now falls back to one chapter
  spanning the book.
- **Import feedback.** The slip was mounted only on the Library screen, so every
  message raised from Settings — success *and* failure — was written and never
  drawn. It is now a `GlobalSlip` at the root, and the Settings row reports
  `Copying 3 of 7…` while staging.
- **SAF names on folder import.** `dir.list()` returns document ids, so
  `primary:Download/My Book/01.mp3` was being used as a filename and ending up
  in titles and chapter names.
- **By-author sort crash.** A book with no readable author crashed the sort
  outright; non-Latin surnames were filed under T–Z by code point. Both fixed,
  with tests.
- **Stale file handles.** A few reads off USB failed on the first seek with
  `Bad file descriptor`; a retry with a fresh handle now covers it.
- **Scan reporting.** Per-file read failures lived only in a book's warnings, so
  a scan that could not read two files still reported "0 errors".

---

## Known, not fixed

> **Overtaken.** This list was accurate when it was written and is not now:
> the root-level fingerprint ambiguity, the headphone-unplug pause and the
> `status.playing || true` part-boundary bug have all since been fixed. The
> current list of what is open and what is deliberately left alone is
> `docs/STATE.md`. This section is kept as it was, because a changelog that
> edits its own history is no use for working out when something changed.

- **No next/previous chapter on the lock screen.** Not available from
  `expo-audio`: `AudioLockScreenOptions` has no such flag, and
  `AudioMediaSessionCallback.onConnect` explicitly removes
  `COMMAND_SEEK_TO_NEXT` and `COMMAND_SEEK_TO_PREVIOUS`. `SEEK_INTERVAL_MS` is
  hardcoded at 10 s, so ±30 s is not configurable either. Both need a patch to
  the module's Kotlin, which means carrying a fork across SDK upgrades.
- **Hyperion's author** is recorded as "Top 100 scifi books" — a naming
  question, not a crash.
- **`status.playing || true` in the audio engine** is always true, so a part
  ending while paused starts the next one playing on its own. The instantaneous
  flag is the wrong thing to read at `didJustFinish`; it needs a tracked
  intent. Left alone deliberately, so the audio engine is not disturbed in the
  same pass as the library fixes.
- **Root-level files and incremental rescans.** `existingFingerprints()` is
  keyed by folder, but a file sitting directly in the library root is a book in
  its own right — so every root-level book shares the one `''` key, with a
  combined fingerprint and a shared list of ids. That ambiguity is wrong on its
  own terms. It is the likeliest explanation for M-04 intermittently leaving
  one root-level book flagged missing after a reconnect, but that chain is not
  yet proven.
- **The device suite is not idempotent.** Two runs back to back give a worse
  result than one run from a clean slate, because checked-out books, holds and
  imports survive into the next run. Every clean figure quoted here was taken
  after resetting the app's data. A reset step at the start of a run would fix
  it.
- **Pausing when headphones are unplugged.** Android's `ACTION_AUDIO_BECOMING_NOISY`
  is not exposed by `expo-audio`, so this needs native work and a rebuild. It is
  batched with the background-copy foreground service for a single rebuild.

---

# Hardware pass — what changed

Driven by the List B findings from the first hardware round, against a real
drive and a real Pixel. They were written up at the time in `TESTING.md`, a
file since deleted as outdated and recoverable from git history. Everything
here is JavaScript; no rebuild is needed.

Settled by the phone and needing nothing: a copy survives switching apps and the
screen going off (check 2), playback is clean for an hour (4), unplugging
headphones pauses rather than blaring (5), Android remembers the drive across a
reboot (7), and search feels right at real scale (10).

---

## Every cover in a v2.2-tagged rip was noise or blank

The Black Company came out as static and Shadows Linger as a plain orange panel,
while other players showed both. Both are tagged **ID3v2.2**, where the picture
frame is `PIC` and names its format with three bare characters — `JPG`, `PNG` —
and no terminator. The parser only knew the v2.3/v2.4 `APIC` layout, whose
format *is* a null-terminated MIME string, so it went hunting for that
terminator inside the image data: it landed five bytes into the JPEG and nine
into the PNG, and returned a JPEG with no SOI marker and a PNG with no
signature. Android draws noise for one and nothing for the other.

Both layouts are now read properly, and the bytes are trimmed back to the
image's own magic number as a backstop for the tags nobody predicted. Verified
against both books: 414×671 JPEG and 362×600 PNG, decoding cleanly. Covered by
four unit tests that build v2.2 tags from scratch.

*`src/lib/metadata/mp3.ts`, `tests/parser.test.ts`, `tests/helpers.ts`*

## A full rescan deleted every checked-out book's audio

`upsertBook` deletes and re-inserts a book's parts on every re-read, and for a
checked-out book those rows hold the only record of where its copy on the phone
lives. `local_rel_path` was not carried across. The book stayed marked checked
out with nothing behind it: the Player refused to open it — "not on your phone
yet" — while the files sat there, and the next launch's reconciliation deleted
the copy and put the book back on the shelf. No warning, and one tap away the
whole time, because Settings offers a full rescan.

The paths are now carried across, keyed on `rel_path` so they survive parts
being reordered by a changed track tag, and deliberately dropped when a part's
size has changed — the copy is then a copy of something else, and reconciliation
should fetch it again. Covered on device by I-12, which checks out a book,
forces a rescan, and then runs reconciliation against it.

*`src/db/books.ts`, `src/dev/suites.ts`*

## Copying an import to the drive could not work at all

Every push reported "could not copy", stamped WON'T FIT, with no reason given.
Two separate faults.

**The stamp and the silence.** `pushImportsToDrive` collected only which books
failed, not why, and passed no stamp — which the slip renders as its default,
"WON'T FIT", the budget refusal. A drive rejecting a write looked like a drive
with no room on it, and the one piece of information that identified the problem
was thrown away.

**The copy itself.** The path staged into a hidden folder and moved it into
place at the end, the way copying onto the phone does. That does not survive
contact with a USB volume. The Storage Access Framework has no rename and no
cheap move; `move()` on a `content://` directory falls back to copying every
byte a second time; a child path built by joining strings is not a document the
provider knows about; and `File.create` says outright that it does not work for
SAF. `Directory.createFile` is the one supported way to make a named document
on the drive, so the files are now created that way and the bytes streamed
through a file handle in 4 MB chunks — which also means a push can report
progress, where before it was a frozen Settings row.

The folder is created under its final name and written into directly, and any
failure deletes the whole folder. The narrow exposure that buys is named in the
code: if the app is killed mid-push, a folder of part of a book is left behind
and the next scan indexes it as a short book. The import stays on the phone and
is not marked as on the drive, so nothing is lost.

*`src/lib/files/import.ts`, `src/store/library.ts`, `src/app/settings.tsx`*

## A pushed import came back as a second book

Fixing the copy exposed this. A book's identity is a hash of its path under the
library root, so the folder a push had just created was read back as a brand new
book — and `markMissingExcept` stamped the original NOT ON DRIVE, since a scan
of the drive had not seen it. Two of everything, with the listening history on
the one that looked broken, and the scary "only copy left" warning on a book
that had just been backed up.

A push now records the folder it wrote in `drive_rel_path`, and the scan treats
a folder an existing book claims as that book rather than hashing a new id. The
audio stays in `imported/<id>/` — the book is still checked out, and moving the
files it may be playing from would be a gratuitous risk. Covered on device by
IM-H.

While here: the on-drive URIs were paired with the parts index by index, in
whatever order `list()` answered. The files are now read back by display name in
part order, which is the only order that means anything.

*`src/db/schema.ts` (migration 5), `src/db/books.ts`, `src/lib/scan/scanner.ts`*

## The play button span for ever on a book that had just been opened

Opening a checked-out book sometimes left the play button buffering, and the
cure was to play a different book and come back. `open` returns early when the
book asked for is already the current one — but the id is set at the top of the
function, before the database read, the audio session and the engine load, so a
load that failed or never settled left the id in place with nothing behind it.
Early-returning on that made the state permanent for the rest of the session;
only opening another book made the id differ.

The shortcut now requires that the engine genuinely holds the book. Alongside
that: a 20-second timeout, so a load that never settles becomes an error rather
than a spinner; a token, so a slower `open` can no longer write its book's
state over a newer one's; `buffering` no longer latched by a player reporting
`isLoaded: false` while idle; pressing play with nothing loaded retries the load
instead of claiming to play in silence; and a "try again" in the error card.

*`src/store/player.ts`, `src/app/player/[id].tsx`*

## Unplugging mid-copy reported "a call to function error", and once took the app with it

Expo wraps a native failure as `Call to function 'FileSystemFile.copy' has been
rejected. → Caused by: …`, and that whole string went into the slip. A pulled
drive now says so in plain English, the detail goes to the log, and the test for
it is whether the file is still there rather than what the error text says. A
pulled drive is told apart from a deleted book by asking whether the root is
reachable — marking a book NOT ON DRIVE because someone unplugged the drive is a
lie that outlives the moment, blocking the next check-out and dressing the book
up as the only copy left. Any failure now also re-checks the drive, so the
header stops claiming it is connected.

The crash is not explained by this and cannot be from JavaScript: if it happens
again, `adb logcat` at the moment it quits is the thing that would name it.

*`src/lib/files/copy.ts`, `src/store/library.ts`*

## "Your drive isn't connected" for the whole of the first scan

Books are only loaded once a scan finishes, so the shelves are genuinely empty
throughout — and the empty state shown there was the disconnected-drive screen,
under a running progress bar, for several minutes. It was the first thing a new
library said and it was the opposite of the truth. It now says what is actually
happening, with the file and book counts as they come in.

*`src/app/index.tsx`, `src/components/FirstRun.tsx`*

## Nothing happened for seconds after choosing the folder

Picking a folder saves it and proves it is readable before the scan proper
starts, and on a real drive those steps take seconds that nothing reported. The
scan is now announced the instant the picker closes.

Worse, the walk itself was invisible: `Directory.list()` and the size and
modification-time reads behind it are all synchronous, so a walk of a real
library ran start to finish inside one JavaScript turn. Progress was reported
faithfully all the way through and not one of those messages could be painted
until the walk had already finished — a frozen app holding a progress bar that
never moves. The walk now yields between folders.

*`src/store/scan.ts`, `src/lib/files/access.ts`, `src/app/settings.tsx`*

## The header and the select bar took a third of the screen

The four sort chips plus settings and select did not fit a phone, so the row
wrapped to two lines. They now scroll sideways in one row, with smaller chips, a
smaller title and tighter padding. The select bar's serif headline said
"5 books · 3.2 GB" directly above a button reading "Check out 5 books · 3.2 GB";
the headline is gone and what remains is the one fact the button does not carry,
how much of the budget is left.

The disconnected-drive banner above the shelves is gone too. It restated what
the drive button and the subtitle already say, in four lines of prose, and the
drive being unplugged is the app's normal condition rather than news. The held
count moved into the subtitle, which was the only part of it the user could not
already see.

*`src/components/LibraryHeader.tsx`, `src/components/SelectBar.tsx`,
`src/app/index.tsx`, `src/components/DriveNotConnectedBanner.tsx` (deleted)*

## The drive button looked like a verdict, not a button

An unlit lamp is honest and inert: nothing suggested the thing could be pressed
to look again. The lamp is now a circular arrow whenever the drive is not
connected, and it turns while the drive is being looked for. Looking is a single
directory listing and usually finishes in a few milliseconds, so the answer
appeared to arrive before the tap had landed — the checking state is now held
long enough for the arrow to turn once.

*`src/components/LibraryHeader.tsx`, `src/components/icons.tsx`,
`src/app/index.tsx`*

## Finishing a book, and what the tray says about it

No prompt to return, by decision: returning is the listener's call and their
timing. What was missing was any acknowledgement at all. The tray now stamps a
finished book **DONE** in place of the "OUT" tag that said nothing — everything
in the tray is checked out — and draws how far through each book you are up the
cover's left edge, filling from the bottom like a bookmark climbing the spine.

Two bits of copy on the Book screen promised an offer to return that was never
built, and now never will be; they say what actually happens instead. And
"Listen again" on a finished book loaded the last second of the last part and
sat there, so pressing play did nothing and the only way back to the start was
to drag the scrubber the whole way. A finished book now opens at the beginning;
the library card keeps the date it was finished.

*`src/components/CoverBadges.tsx`, `src/components/BookCover.tsx`,
`src/components/CheckedOutTray.tsx`, `src/app/book/[id].tsx`,
`src/store/player.ts`*

---

## Still open after this pass

Everything in this list was taken in the two passes below.


---

# Follow-up pass — what changed

Four items off the open list, in the order they were asked for.

---

## Multi-select is gone

Not fixed — removed. `checkOutSelected` looped over the selection and sent each
book straight to a copy, so choosing five started five simultaneous reads off
one USB stick: slower than five in a row as well as noisier, with each book's
budget check blind to the other four and the guard that waits for a running scan
skipped entirely. `flushHolds` goes to real trouble to serialise held books for
exactly that reason.

The call was that a long-press per book is quick enough, and it is: the same
move, the same confirmation, one book at a time, through the one path that was
already careful. Gone with it: the select chip in the header, the select bar,
the tick badge, the dimming of unchosen covers, and four store actions. The
budget rule no longer has a second home in a UI component that had to remember
to enforce it.

*`src/store/library.ts`, `src/app/index.tsx`, `src/components/LibraryHeader.tsx`,
`src/components/Shelf.tsx`, `src/components/BookCover.tsx`,
`src/components/CoverBadges.tsx`, `src/components/SelectBar.tsx` (deleted),
`README.md`*

## The drive is looked for while you are watching

The drive was only re-checked when the app came to the foreground or when the
button was tapped, so plugging it in with the Library on screen did nothing at
all — and holds going out the moment the drive is back is the one thing the app
promises about them.

A poll every four seconds, and deliberately cheap: one existence check on the
root, not the directory listing `isReachable` uses to earn its certainty. That
weaker test is never treated as the answer — a change in it is a reason to go
and ask properly. Nothing happens unless the answer changes, and the expensive
part (listing the root, recording the sighting, flushing holds, offering imports
to the drive, and the re-sync scan that follows from the connected flag) runs
once per arrival rather than once per look. Keyed on the change in presence
rather than on a mismatch with `driveConnected`, so a stale permission that
leaves the root present but unreadable cannot make it re-list every four
seconds. Foreground only: in the background there is nobody to show a change
to.

*`src/lib/files/access.ts` (`isPresent`), `src/store/library.ts` (`pollDrive`),
`src/app/_layout.tsx` (`DriveWatcher`)*

## The sleep timer is a deadline, not a countdown

It was a one-second `setInterval` on the Library's clock decrementing a counter
— the least reliable mechanism on the phone, for the one feature whose whole
purpose is to work with the screen off and the phone in a pocket. The comment
claimed the interval stopped when the app was backgrounded; nothing cancelled
it.

It is now a wall-clock timestamp, checked in the engine's status callback, which
the native player drives every 500 ms including in the background. A deadline
needs nothing to keep it: it is simply true or not yet true whenever anything
thinks to look. "Off in 30m" now means in thirty minutes, so time spent paused
counts. The remaining seconds are kept only as the Player's label, and written
only when the displayed second changes. End of chapter is untouched — it was
already measured against the position rather than the clock.

*`src/store/player.ts`, `src/app/_layout.tsx`*

## A copy killed mid-flight resumes

The background-copy check passed on the phone, so no foreground service is
needed and interrupts keep discarding as before: a cancel, a pulled drive, a
short read or any failure still deletes the staging folder and leaves the book
on the shelf. What changes is the one case where no code was left to discard
anything — Android killing the app mid-copy. A gigabyte that had already landed
was deleted on the next launch and fetched again from the start.

Those files are kept now, on terms that cannot be wrong. A part counts as done
only when its size matches the source exactly; a short file is the tail of a cut
write and is deleted. The folder is trusted at all only if a manifest proves it
was staged for precisely these parts in this order — staged files are named by
index, so without that, two parts that had swapped places on the drive would be
read back under each other's names, and if they were the same length even the
size check would pass. A half-copied book is still never visible as a book: only
a folder with every part accounted for is moved into `books/`.

Startup no longer deletes the staging folder outright. It keeps what belongs to
a book that still exists and is less than a week old, and sweeps the rest. And a
resume is charged only for the bytes still to come, rather than for the whole
book — asking for the whole book would have refused the resume exactly when it
had the least left to do.

Covered on device by ST-01 (kept for a known book, swept for an unknown one) and
ST-05, which stages a first part of exactly the right size with recognisable
contents and then proves those bytes, and not a fresh copy, are what ended up in
the final folder.

*`src/lib/files/copy.ts`, `src/store/library.ts`, `src/dev/suites.ts`*


---

# Tidying pass — before the next build

The smaller items off the open list, plus what looking at the dependency tree
turned up.

---

## The dependency "fix" that breaks the bundle — do not repeat it

`npx expo-doctor` reports two things: `expo-asset` missing as a peer dependency
of `expo-audio`, and four packages a patch version behind (`expo`,
`expo-dev-client`, `expo-router`, `expo-splash-screen`). Taking its advice —
`npx expo install expo-asset` followed by `npx expo install --fix` — leaves the
project unbuildable, and the reason is worth writing down.

**What was observed.** After those two commands, npm placed
`expo-modules-core` at `node_modules/expo/node_modules/expo-modules-core`
rather than hoisting it, and `npm run typecheck` failed with `Property
'addListener' does not exist on type 'AudioPlayer'` — `expo-audio` resolves
`SharedObject` from `expo-modules-core`, and from `node_modules/expo-audio/`
that package is no longer reachable. A clean `rm -rf node_modules && npm
install` and an `npm dedupe` both reproduced the layout. Only `expo` requires
the package, at a single version, so this was not a version conflict.

**What was inferred, not tested.** That the bundler would fail too.
`expo-audio` imports `expo-modules-core` at runtime as well as for types
(`requireNativeModule`, `useReleasingSharedObject`), and Node resolution from
`node_modules/expo-audio/` never looks inside `node_modules/expo/node_modules`
— but Metro was not run against the broken tree to confirm it.

**Scope of the claim.** This was the layout npm produced for *this* dependency
set at *this* npm version. It is not a general statement about `expo@57.0.28`,
and a later npm or a different set may hoist correctly — which is why the
check below is a check rather than a rule.

Reverted: `package.json` and `package-lock.json` are unchanged, restored with
`npm ci`, and `expo-modules-core` is hoisted again. The two doctor warnings
stand, knowingly:

- **`expo-asset`** is a peer of `expo-audio` for playing assets bundled with
  `require()`. Every source this app plays is a `file://` or `content://` URI,
  so nothing reaches that code path — which matches the device, where audio has
  worked for days without it.
- **The four patch bumps** can wait for a version of `expo` whose tree hoists
  correctly. Re-check with `npx expo-doctor` before a later build, and verify
  `node_modules/expo-modules-core` exists at the top level afterwards.

## The microphone permission is gone

`recordAudioAndroid: false` on the `expo-audio` plugin. `RECORD_AUDIO` is added
by default and an audiobook player has no business asking for it. **Native —
takes effect at the next build**, which is the only item here that does.

*`app.json`*

## Saving a position no longer rebuilds every shelf

The Library derives the search result, the shelves and the list's data from the
`books` array, and `recordProgress` replaced that array every five seconds for
as long as anything was playing, whether or not the Library was on screen.

The database is still written every time — nothing is at risk, and a relaunch
or any `refresh` reads the current figure. What waits is the copy the screens
render from, committed when playback pauses, stops, finishes or the app goes to
the background. The Player already reads its position from the engine, and the
Book screen now prefers that too while a book is playing, so the one screen
that could have shown the gap does not.

*`src/store/library.ts`, `src/store/player.ts`, `src/app/book/[id].tsx`*

## Search folds each book once, not once per keystroke

Folding is a Unicode normalisation and two regexes per book, and it ran over
the whole library on every keystroke: at four hundred books, twelve hundred
passes between one letter and the next, over text that had not changed. The
folded words are now remembered in a `WeakMap` keyed on the book object — which
is exactly the thing that is replaced when the library reloads, so the cache
invalidates itself and nothing has to remember to clear it. The query is folded
once for the whole library rather than once per book.

*`src/lib/library/search.ts`*

## The position written to the database is the clamped one

It was clamped in memory and written raw, so a seek past the end could store a
position beyond the book's own duration — and that is the figure a relaunch
reads back.

*`src/store/library.ts`*

## A corrected cover actually appears

Thumbnails were stored at one fixed path per book, and Android's image pipeline
caches by URI without consulting the file's timestamp — so a cover that had
been *fixed* went on rendering from the old bitmap for the rest of the session,
which is precisely what would have happened to the two Glen Cook books after
their rescan. The name now carries a short signature of the artwork, so
different art is a different URI. A name that changes *only* with the artwork
means a rescan finding the same picture does not churn the file or the row, and
a book's older thumbnails are swept when a new one is stored.

Not a `?v=` query on the URI, which is the obvious move: a query string on a
`file://` URI is not reliably carried through the platform image loaders.

*`src/lib/files/covers.ts`, `src/lib/files/access.ts`*

## The missing-book sweep states its evidence

`markMissingExcept` is the most destructive write in the app — it stamps every
book the scan did not see, which blocks check-out and dresses a book up as the
only copy left. It is only meaningful after a scan that walked the whole of a
readable root, and that condition lived in the caller, one `if` away from being
forgotten. It is now an argument the function refuses to act without.

The `WHERE` clause itself needed nothing: `NOT (imported AND NOT on_drive)` is
already "library-sourced, or an import that has reached the drive", which is
exactly the set a drive scan is evidence about.

*`src/db/books.ts`, `src/lib/scan/scanner.ts`*

## The README describes the app that exists

It still said the copy "fakes progress on a timer" and that audio "advances a
counter" pending `react-native-track-player`. Both have been real for weeks.
Rewritten around what is actually there — the real copy with its staging,
verification and resume, `expo-audio` behind the engine interface, search,
duplicates, the DRM stamp, phone-local libraries and importing from the phone —
with the genuine gaps (iOS bookmarks, lock-screen chapter buttons) kept. Two
comments in `src/store/library.ts` claiming the copy was simulated went the
same way.

*`README.md`, `src/store/library.ts`*

---

# Cleanup pass — the knowledge base

Comments had become archaeology: a quarter to two fifths of the core files, much
of it the history of how something broke rather than what the rule is. The fix
is not to delete the knowledge but to move it somewhere it can be found.

---

## `docs/KNOWLEDGE.md`, searchable

Thirty-eight entries covering what cost time to learn: platform behaviour that
contradicts the documentation, invariants the code depends on, and decisions
that look wrong until you know why. Grouped by area — files and SAF, metadata,
identity and scanning, the database, audio, screens, build and dependencies.

```sh
npm run kb                # list every entry
npm run kb saf cover      # read the entries matching those words
```

`scripts/kb.ts` parses the headings and ranks a heading match above a body
match, so a half-remembered word finds the entry.

The rule that keeps it alive is in `AGENTS.md`, where it is read every session:
check it before debugging, update it in the same change that teaches something,
and **comments state the rule while the knowledge base keeps the story**.

## Comments cut to the rule

Every long comment block in the core files, rewritten to say what the
invariant is and why it is not obvious — with the account of how it was
discovered moved to the knowledge base, and a `npm run kb <term>` pointer where
the full story is worth having.

| | before | after |
|---|---|---|
| `src/store/library.ts` | 279 comment lines | 202 |
| `src/lib/files/copy.ts` | 151 | 119 |
| `src/lib/files/access.ts` | 133 | 97 |
| `src/db/books.ts` | 131 | 107 |

Also gone: a header comment still describing select mode, and two in
`src/store/library.ts` still describing the copy as simulated.

## Dead code removed

`restoreAccess`, `checkedOutBookIds`, `clearLibrary`, `matchesSearch`,
`isOnHold`, `isCopying` and `remainingSec` — all unreferenced, several of them
left behind by the features that replaced them.

## The README does one job

The 80-line emulator runbook moved to `docs/EMULATOR.md`. The scanning section
lost the parts the knowledge base now holds. A **Where to look** table at the
end points at the knowledge base, this file, the hardware checklist, the
runbook and the mockups. 288 lines down to 233.

`HANDOFF.md` — the brief the project was built from — is marked historical. It
still taught the pre-rename vocabulary ("The Stacks", "The Bag", "pack", "put
back") and recommended `react-native-track-player`, so anyone reading it for
guidance was being misled by it.

---

# Drive pass — what the first real push found

## Pushing a book to the drive failed with "bad file descriptor"

Reported from a real drive: a push interrupted by a force-stop left the
part-written folder and its `.dueback-incomplete` marker exactly as designed —
the scan skipped it, nothing appeared in the library — but the retry died at
once with

> could not be copied: call to function 'FileSystemFileHandle:writeBytes' has
> been rejected — unable to write to a file handle: bad file descriptor

Not the retry, and not the marker. `FileSystemFileHandle.forContentURI` opens a
`ParcelFileDescriptor`, wraps its `fileDescriptor` in a `FileOutputStream`
channel and keeps only the channel. Nothing holds the descriptor, so it is
collectable the instant `open()` returns, and its finalizer closes the fd out
from under the channel. The next `writeBytes` gets `EBADF`.

That makes it a race, not a bug in the reclaim: the first attempt survived long
enough to write part of a file, the retry did not. The `await` between chunks —
there so the progress bar can paint — is what gives the collector its chance.
Expo's own `copyFileViaChannel` keeps both descriptors in `use {}` blocks for
the whole transfer, which is why ordinary `copy()` never shows this.

The same fault was already known on the read side: `isStaleHandleError` in
`src/lib/files/access.ts` retries a scan read that comes back "Bad file
descriptor", with the comment "USB hands back dead descriptors now and then".
A retry is the right answer there and the wrong one here, because half the
bytes have already landed.

So the destination is no longer held open. Each chunk goes through
`write(bytes, { append })`, which opens and closes its own stream inside a
single native call — nothing survives to be collected. The first chunk is
written without `append`, so it truncates whatever an earlier attempt left
under that name. The source stays on a handle: it is a real path in app
storage, where `RandomAccessFile` is used and there is no descriptor to lose.

*`src/lib/files/import.ts`, `docs/KNOWLEDGE.md`*

## Opening Contents on a book with no chapters killed the app

From a real crash log:

```
FATAL EXCEPTION: mqt_v_native
Invariant Violation: scrollToIndex out of range: item length 0 but minimum is 1
```

`ContentsSheet` scrolls to the chapter you are in when it opens. `rows` is
built straight from `book.chapters`, and the target was clamped with
`Math.max(0, Math.min(rows.length - 1, currentIndex))` — which is `0` for an
empty list, and index 0 is still out of range when there are no items. In a
debug build an invariant violation is a red screen; in a release build it is a
fatal exception.

The guard is now on the length, not the index, and the sheet says "This book
has no chapters" instead of opening blank.

Worth being clear about the blast radius: this was found on a part-written
file, but it is not about damaged books. Any rip whose tags carry no chapters
reaches it — the Player handles that case by standing in a single chapter
through `chapterAt`, and the contents sheet never did.

*`src/components/ContentsSheet.tsx`*

## The drive renamed the marker, so the scan indexed half a book

A push of "The Last Kingdom" was force-stopped part way. The folder and its
marker were still on the drive, and the next scan indexed the partial file as
a book anyway:

```
-- The Last Kingdom - CD 01
   raw folder : BERNARD CORNWELL ~ [Warrior Chronicles 01] - The Last Kingdom - Mine
   1 part(s) · 8m 36s · 4.0 MB · 0 chapters
```

`Directory.createFile(name, mime)` is a request, not an instruction. The name
goes to `DocumentsContract.createDocument`, and the provider puts it through
`FileUtils.buildUniqueFile`, which appends an extension matching the MIME type
when the name has none it recognises. `.dueback-incomplete` as `text/plain`
therefore lands as `.dueback-incomplete.txt`.

Every test for it compared the exact string, so nothing recognised it: the
scan treated it as an ordinary dotfile and dropped it as junk, grouping never
saw a marker, and `isIncompleteFolder` could not reclaim the folder on the
retry — which is why that attempt took a numbered name and left the original
wreckage in place.

The tests were not wrong so much as asking the wrong layer. They fed
`groupIntoBooks` a file called `.dueback-incomplete`, which is the name the
code asks for and not the name the drive gives back. `copyImportToDrive`
already knew this about audio files and reads `created.name` back after
creating each one; the marker was the one place that trusted the request.

Matching is now by prefix — `isIncompleteMarker` — which covers
`.dueback-incomplete.txt`, a numbered duplicate, and any other suffix a
provider decides to add. Three tests cover the renamed forms, and the near
misses that must not match.

Worth recording why it was convincing: from a computer the marker looked
exactly right, because Windows hides known extensions.

*`src/lib/library/grouping.ts`, `src/lib/files/import.ts`, `tests/grouping.test.ts`*

---

# Hands-on pass — five faults from a day's use

## "Listen again" started at the end

`open()` returns early when the engine already holds the book asked for, so
that leaving the Player and coming back does not reload it. The book that has
just finished is exactly that book, parked on its last second — so "Listen
again" hit the shortcut and handed back the end. The rewind was already
written, three lines below the early return it never reached. It now happens
before.

*`src/store/player.ts`*

## Two slips for one message

`GlobalSlip` is mounted at the root precisely so a message raised anywhere is
drawn once, and its own comment says so. The Book and Player screens each
rendered a second `Slip` as well, so "frees 1.2 GB" and "on hold" appeared
twice, stacked.

*`src/app/book/[id].tsx`, `src/app/player/[id].tsx`*

## Cancel waited for the file to finish

Cancel was only noticed between parts, and one part is a single native
`copy()` call that cannot be aborted — so cancelling a one-file m4b did
nothing visible until the whole file had copied.

The button is answered where it is pressed: the book goes back on the shelf
and the slip appears at once. The bytes are still discarded when the part
finishes, and the drive keeps reading until then, because there is no API to
stop it. What changed is that the app no longer pretends to be busy.

A copy cancelled while still waiting its turn is now dropped before it starts
— `runCopy` clears the cancelled flag on entry, so the queue would otherwise
have copied it anyway.

*`src/store/library.ts`*

## Returning a book left it playing

Returning deletes the audio. Nothing told the player, which carried on from
files that were no longer there. It now stops before the deletion: paused
first, then unloaded, so there is no gap where sound comes from a deleted
file.

The library cannot import the player, because the player imports the library.
The player registers a callback instead, when it loads — which the root layout
guarantees happens at startup.

*`src/store/library.ts`, `src/store/player.ts`*

## Three check-outs at once lost books

Reported as books hanging at 100%, vanishing, and one outright error.

`flushHolds` has always copied strictly one at a time, with a comment
explaining that the drive is the bottleneck and a queue is faster than
parallel reads off one stick. The check-out buttons did not: they called
`startCopy` directly, and `copiesInFlight` only stops the *same* book being
copied twice. Three buttons meant three concurrent copies finishing together
and writing their parts and their checked-out state to SQLite in the same
moment.

Every route now goes through `queueCopy`. A book waiting its turn shows
"Checking out… 0%", which is honest but not informative; a queued state of its
own would read better and is not in this change.

*`src/store/library.ts`*

## Confirmed working

Pushing an import to the drive, tested across repeated force-quits: the
part-written folder is skipped every time and the book is offered again.

---

# Queue pass — check-out stops blocking the app

Serialising copies stopped books being lost, and made the cost obvious: with
the drive connected, checking out one book and then asking for another left
the app unresponsive, taps landing minutes later when the first copy finished.
With the drive unplugged the same five books queue instantly and read well in
the tray. The two paths should not have felt different.

## A tap no longer touches the drive

`checkOut` proved the drive reachable before starting a copy —
`proveDriveReachable`, which is a synchronous SAF `list()` of the library
root. Every file call blocks the JS thread, and a root being read by a copy in
flight answers slowly. So each tap froze the app until the drive got round to
answering, which is the lag: five taps, five freezes, and every other action
queued behind them.

The drive is now proved once per copy, inside the queue, where nothing is
waiting on the answer. The button writes state and returns.

`pollDrive` is paused for the same reason while a copy runs. It called
`isPresent` — another synchronous provider query — every four seconds, against
a drive already saturated. A copy in flight is better proof than the poll can
give, and the copy reports a drive that goes away.

## Check-out with the drive connected is a queue, like a hold

Both check-out buttons put the book on hold and kick `drainQueue`, rather than
starting a copy themselves. A queued book is in the tray from the moment it is
asked for, faded, exactly as it is when the drive is unplugged — which is the
behaviour that already read well.

`drainQueue` re-reads the store each time round rather than working from a
list captured at the start, so a book added while another is copying is picked
up with nothing having to remember it. The promise chain added in the last
pass is gone; it serialised correctly but was invisible.

"On hold" means two things now, so the Book screen says which: **In the
queue** with the drive connected, **Waiting for the drive** without it, and
the cancel beneath it reads **Leave the queue** or **Cancel the hold** to
match.

A "check out and play" asked for while something else copies parks its
callback until its turn comes, and says it is behind something rather than
appearing to do nothing.

A book taken out of the queue is skipped by the drain and put back on the
shelf as it is skipped — leaving it on hold would have `nextQueued` hand it
straight back, and the drain would spin on it.

*`src/store/library.ts`, `src/app/book/[id].tsx`*

## "Database is locked", and the book that reached 100% and vanished

Reported with the error: `call to function 'NativeStatement.finalizeAsync'
has been rejected — database is locked`.

The lock is our own. `withExclusiveTransactionAsync` does not lock the
connection it is called on; it opens one of its own through
`Transaction.createAsync`, and the expo-sqlite documentation says plainly what
that means — "As long as the transaction is converted into a write
transaction, the other async write queries will abort with `database is
locked` error."

`PRAGMA busy_timeout = 8000` is set in `getDb`, and a pragma is per
connection, so it was never covering the transaction's. The note in `getDb`
claiming the timeout handles two overlapping writers was wrong about the half
it could not reach.

Finishing a check-out was three separate writes — the parts' local paths, the
book's state, the checkout row — so three chances to lose the race. Losing on
the second or third threw an error that `startCopy` treats as a failed copy:
back on the shelf, part paths cleared, **local files deleted**. The audio was
on the phone and correct, and the app threw it away. That is the book that
reaches 100% and disappears.

Now one `recordCheckoutComplete` transaction on the main connection, retried
as a whole by `withLockRetry` — backing off to about six seconds, and only for
a lock, since a constraint failure would fail the same way for ever. By that
point the bytes are already on the phone, so giving up means copying them
again.

`setPartLocalPaths` is gone; it had no other callers.

## Progress is patched once per whole percent

Every `patch` rebuilds the books array and re-renders the shelves, and the
poll behind the copy's progress fires several times a second however large the
file. The reported progress is unchanged; the number on screen just stops
being rewritten when it has not moved.

*`src/db/books.ts`, `src/store/library.ts`, `src/db/schema.ts`*

---

# Atomic-write pass — what the audit asked for, and what it found

The brief: SAF cannot do temp-file-and-rename, so write versioned snapshots,
validate them, keep a previous valid copy, and never let an interrupted write
leave nothing recoverable.

Half of that was already true, for a different reason. The other half found
two places on *phone* storage — where rename does work — that were deleting
the old thing before writing the new one. And looking at them turned up
something worse than non-atomicity.

## The commit step was never awaited

`move` and `copy` are `AsyncFunction Coroutine` in the native module and
return promises. `create`, `delete`, `write`, `list` and `size` are plain
synchronous functions. The copy's commit mixed them:

```ts
removeQuietly(finalDir);
staging.move(finalDir);     // a promise, dropped on the floor
return { ok: true, localRelPaths: [...] };
```

So `copyBookToDevice` reported success while the audio was still in flight.
`recordCheckoutComplete` then wrote `local_rel_path` for files that might not
have arrived, and a move that failed did so as an unhandled rejection — no
error, no slip, just a book the database believed in. This is a second and
entirely sufficient cause of a book reaching 100% and disappearing, alongside
the locked-database one fixed in the pass above.

`covers.ts` had the same mistake: the finished thumbnail was moved into place
unawaited and `target.size` read immediately after, which records a cover of
no bytes.

Lint cannot see this. `no-floating-promises` needs type-aware linting, which
this config does not run.

## Replacing audio is now a swap

```ts
const previous = new Directory(booksDir(), `${bookId}.previous`);
removeQuietly(previous);
if (finalDir.exists) await finalDir.move(previous);
await staging.move(finalDir);
removeQuietly(previous);
```

There is no longer a moment when neither copy is on disk, and
`recoverInterruptedSwaps` runs at launch, before anything asks what audio is
on the phone: if `books/<id>` is missing and `books/<id>.previous` is there,
the old copy goes back. Two directory entries, not a second copy of the audio.

## Covers are written beside their name and moved over it

`writeCoverBytes` deleted the existing file, created an empty one, and then
wrote the bytes — three steps with the old cover already gone. It now writes
`<name>.part`, checks the size matches what it was given, and moves that over
the target. Nothing is destroyed until the replacement is whole.

## What was already right, and why snapshots do not fit the drive

Pushing a book to the drive does not overwrite anything valid, so there is no
previous version to keep:

- a folder whose name is taken gets a numbered suffix, so an existing book is
  never written over;
- the only folder ever deleted is one already carrying the incomplete marker,
  which is by definition not a valid copy;
- the source stays on the phone, whole, until the push commits.

An interrupted push therefore already leaves two recoverable things: the
complete original in app storage, and a marked partial folder that every scan
skips and the next attempt reclaims. A versioned snapshot would mean a second
copy of a multi-gigabyte book on a drive the user chose for its capacity, to
protect a write that cannot destroy anything.

The gap that remains is the one named when the marker was built: dying between
the last verified byte and the marker's deletion leaves a complete book that
scans ignore until a retry reclaims it. Nothing is lost, and closing it needs
a rename SAF does not have.

*`src/lib/files/copy.ts`, `src/lib/files/access.ts`, `src/lib/files/covers.ts`,
`src/dev/harness.ts`, `src/dev/suites.ts`, `src/store/library.ts`*

---

# Margins pass — notes, bookmarks and a character index

JS and SQLite only. No native work, and nothing here needs a rebuild beyond
shipping the new JavaScript.

## What a note is

A row in `notes` with a position, a chapter, some text and a soft delete. A
note with empty text **is** a bookmark — there is no second type and no flag,
so a bookmark typed into becomes a note and a note emptied back out becomes a
bookmark, with no state to migrate across the line and one set of code paths
rather than two.

`characters` and `note_characters` sit beside it, also soft-deleted. These
three tables are the only part of the database a listener authored: every
other table is rebuildable by rescanning the drive, and these are not. That is
why `deleted_at` is everywhere — a later sync has to tell a row that was
deleted from one that never existed — and why deleting a character tombstones
its tags and never its notes.

## The pencil saves before it asks

The player's bottom row gains a pencil. Tapping it writes a bookmark at the
current position **minus ten seconds**, clamped at zero, with the chapter
derived from where it lands rather than where the tap happened. By the time
someone reaches for the button the thing worth marking has been said; near a
chapter boundary, deriving from the tap would file the note under the wrong
chapter.

The bookmark exists before the sheet opens. Swiping the sheet away, being
interrupted, or the app being killed all leave the mark in place.

**The keyboard does not come up with it.** Most taps are "mark this spot", not
"write an essay", and half a screen of keyboard for a finished gesture is in
the way. Tapping the field asks for it. Dictation is the keyboard's own, so
speaking a note needs no microphone permission — and the app asks for none.

"Bookmark saved · Undo" sits at the top of the sheet for a few seconds.

## Typing is saved on a pause, and on every way out

The debounce decides *when* a note is written, never *whether*. Closing the
sheet flushes; the app going to the background flushes, beside the playback
position that already did. A write that fails puts its text back rather than
dropping it.

The debounce is `createAutosave`, deliberately outside the store so it can be
tested without a database — which is where five of the new tests live.

## @ to tag someone

The typed text is the only record of who a note is about: `note_characters` is
rewritten from it on every save, which is what makes "delete the @mention and
the tag goes" true with no second gesture to learn.

Names contain spaces, so a mention cannot be read as "@ up to the next space".
Matching is against the names this book already knows, longest first, so
`@Logen Ninefingers` beats `@Logen` when both exist, and aliases count as
names. An `@` inside a word is not a mention, so an email address in a note is
left alone.

The suggestion row offers matching characters and **+ New** with the name
already filled in, plus an optional one-line bio.

## The Book screen has tabs

**Chapters · Margins · Who's who.** Who's who is behind `isPro()`, which
returns true for everyone today and exists so there is one place to change
when it does not.

**Margins** groups notes by chapter. A note is a card: a time chip that plays
from there, the text, character chips, edit and delete. A bookmark is a
compact ribbon row, because it has nothing to read. Deleting offers Undo for
twelve seconds — in its own bar rather than a slip, since the slip has no
button and this is worth offering back for longer than a message stays up.

**Who's who** is index cards ordered by first heard, with the unheard last.
Turning one over gives the name, aliases, an editable bio, the first-heard
chip, and every tagged note in story order with "+ add to bio".

The bio is its own field and never the first note. A note is what someone
wrote at a moment in the story; a bio is what they know now, and conflating
them makes the first thing you ever wrote about a character their description
for ever.

## Ticks on the scrubber

Notes in the current chapter show as marks on the player's scrubber, and
tapping one seeks to it. They are the only children of that view that are not
`pointerEvents: none` — the pan responder claims a touch only if no child
wants it, which is what lets a tap land on the mark rather than scrubbing.

## Handwriting, and only for handwriting

Caveat, via `@expo-google-fonts/caveat`, in `NoteText` and the bio field and
nowhere else. Names, times, tags and controls keep the existing faces: the
point of the handwriting is that it marks what the app did not write, which
stops being true the moment the app writes in it too.

Settings → **Handwritten notes**, on by default. Off is a real preference, not
a cosmetic one.

## Export, always free

"share these notes" on the Book screen hands the system share sheet a
markdown page: title, author, notes by chapter with times and tags, then the
characters with their bios and first-heard. Built with React Native's own
`Share`, so no new dependency.

This is the listener's own writing. Notes, bookmarks, export and getting the
data back are free and stay free; only the character index sits behind the
flag.

## Forgetting a book now says what it would take

"Forget missing books" counts the notes and characters on those books first
and names them in the warning, and the destructive button reads "Delete my
notes too". If the count cannot be read it warns anyway — unknown is not the
same as none.

## The backup rules were already right

`plugins/withBackupExclusion.js` is an exclude list: `books/`, `books-tmp/`,
`covers/`, plus `imported/` from cloud backup only. expo-sqlite puts the
database at `filesDir/SQLite/dueback.db`, which nothing excludes, so notes and
characters are carried by both cloud backup and device transfer already.
**No change needed, and no native rebuild for it.**

## Tests

44 new unit tests in `tests/notes.test.ts`: the ten-second clamp, chapter
derivation at a boundary, bookmark-is-empty-note, mention parsing and
suggestion, tagging and untagging, first heard and its ordering, bio
appending, autosave and flush including a failed write, and the exported page.

Seven on-device cases in `src/dev/marginsSuite.ts` (A12) for what only a real
database can answer: the round trip, soft deletes staying deleted, undo
restoring a row, tags rewritten from text, a character deleted without its
notes, and the count behind the forget warning.

*`src/data/notes.ts`, `src/db/notes.ts`, `src/db/schema.ts`, `src/store/notes.ts`,
`src/store/ui.ts`, `src/lib/notes/*`, `src/lib/pro.ts`, `src/components/NoteSheet.tsx`,
`src/components/NoteText.tsx`, `src/components/BookTabs.tsx`, `src/components/WhosWho.tsx`,
`src/components/ChapterScrubber.tsx`, `src/app/player/[id].tsx`, `src/app/book/[id].tsx`,
`src/app/settings.tsx`, `src/app/_layout.tsx`, `src/dev/marginsSuite.ts`*

---

# Identity pass — a book stops being its path

## The problem, stated plainly

A book's id was a hash of its folder path. Rename the folder, move it into a
series folder, or reach the same drive through a different mount, and the app
made a stranger of a book someone was halfway through — their place, their
library-card history and everything they wrote in the margins stayed attached
to an id nothing pointed at any more.

## Identity is a uuid; the path is a lookup

Migration 7 rewrites every book id to a uuid in one transaction, moving
`parts`, `chapters`, `checkouts`, `notes` and `characters` with it, and keeps
the old hash as `path_key` — which is exactly what it was, a record of where
the book was found. A folder with no matching key is a new book; whether it is
*really* a book that moved is decided separately.

Each library has an id too, kept in `.dueback/library.json` at the root. The
drive's answer always wins, and is never overwritten: two phones that each
minted an id for one drive would otherwise take turns renaming it, and every
book would change libraries on every scan. Path keys are matched within one
library, because a path key is only a path and two libraries can both hold
`A Book/01.mp3`.

## Shape finds candidates; only content reconnects

Books now record their part count, the size of each part, and a content sample
— 64 KB from each end of up to four parts, chosen deterministically, with the
part sizes folded in. Four parts rather than all of them because a 148-part
book would otherwise mean 19 MB of USB reading on every first index, to guard
against a case the part-size list already all but rules out.

The rule the feature turns on: **reconnect without asking only when there is
exactly one candidate and its content sample matches.** Everything else asks.

## Where the app asks instead of deciding

- **One candidate, content unproven** — the shapes match exactly but the
  sample does not, or either side was never sampled. "I couldn't read enough
  of it to be sure."
- **Two or more candidates of the same shape** — even if exactly one matches
  by content. The usual cause is the same rip in two folders, and which one
  someone meant is not something a hash can answer.

Both arrive as `ReconnectSheet`, one at a time, with "Keep them separate"
always available and nothing lost by choosing it — the question is asked again
on the next scan.

Questions are only raised by a scan that **completed** and could **read the
root**. A cancelled scan or an unplugged drive has not shown that anything is
missing, and offering to merge books on that evidence would be inviting
someone to join two because a cable was loose.

## Reconnecting

The old identity keeps everything a scan cannot rebuild — progress, finished,
where the local copy is, checkout history, notes and characters — and takes on
everything the scan just learned. Local part paths move across **by index**:
the paths changed, the audio and its order did not, and that is what the
sample proved.

## Tests

28 new unit tests in `tests/identity.test.ts`: path keys for renames, splits
and loose root files; sample ranges, bounded part selection and hash
sensitivity; candidate matching including the two-second duration slack; every
branch of the reconnect decision; and the id migration against a recording
stand-in for the database, checking that every referencing table is renamed to
the same uuid and the old id survives as the path key.

Five on-device cases in `src/dev/identitySuite.ts` (A13) for what needs a real
database and a real folder: every book has a uuid distinct from its path key,
a scan records shape and sample, a rescan keeps the uuid, a renamed folder
keeps its place and its notes, and a reconnection moves the audio while
keeping everything written.

*`src/lib/library/identity.ts`, `src/lib/library/ids.ts`, `src/lib/scan/sample.ts`,
`src/lib/scan/scanner.ts`, `src/lib/sync/driveFolder.ts`, `src/db/identity.ts`,
`src/db/identityMigration.ts`, `src/db/schema.ts`, `src/db/books.ts`,
`src/store/library.ts`, `src/store/scan.ts`, `src/components/ReconnectSheet.tsx`,
`src/components/GlobalReconnect.tsx`, `src/dev/identitySuite.ts`*

---

# Drive backup pass — reading data that outlives the phone

## Generations, because SAF cannot rename

A write is usually made atomic by writing a temporary file and renaming it
into place. SAF has no rename, so the guarantee comes from never modifying
anything already on the drive.

Generation N is a complete set in `.dueback/gen-N/`: a manifest plus one file
per record type, each carrying the library id, the generation number, a schema
version and a checksum of its own contents. A backup writes a **new** folder,
reads the whole of it back off the drive, validates it, and only then prunes
anything older — and never prunes below two generations known to be good.

The manifest is written **last**, so a generation whose data files are still
arriving cannot validate. An interrupted write is indistinguishable from one
that never began, which is exactly right.

## Read and merge first, then write

A phone that has been away writes what it learned on top of what it brought.
Plugging in a drive can only add to it. What came back is applied even when
the write then fails: the read happened and the merge is correct, and throwing
away another phone's work because this drive would not take our half helps
nobody.

Returning a book never waits on any of this.

## How two copies are reconciled

`updated_at` decides. On an exact tie it goes to the higher writer device,
then the higher mutation id — arbitrary, but arbitrary in a way both phones
compute identically, so merging A into B gives the same answer as B into A.

- **Notes and characters** by uuid, **tags** by the pair they join, **history**
  by event uuid — which is why checkouts gained one, having been keyed by an
  autoincrement rowid that two phones would assign differently.
- **Progress** by book uuid, and the **latest** position wins rather than the
  furthest. Rewinding to hear something again is a decision; a sync that
  restored the furthest point would undo it every time.
- **Undo** is an ordinary write with a newer stamp, which is how it beats the
  deletion it reverses.
- **Tombstones** for every record type, and a deleted note or character
  suppresses its tags.

## A note edited on both sides keeps the loser

Last-write-wins is right for everything except a sentence somebody wrote. When
both copies have moved on from the state they last agreed on — which is what
`base_updated_at` records — the losing text becomes its own note, marked as a
conflicted copy, at the same position in the same book.

Its id is derived from the original note plus the losing mutation, so syncing
the same pair of edits again finds the copy already there. Tested by merging
three times over and asserting there are still two notes.

With no recorded agreement there is no conflict: that means one side is simply
behind, and treating it as a conflict would litter the margins with copies.

## The identity manifest, which is what makes restore true

A phone that has never seen a library mints a fresh uuid for every folder it
scans, so notes keyed to the old uuids would have nothing to belong to. The
backup therefore carries who the books are — uuid, path key, shape, sample —
and a scan seeds its identity index from the drive before minting anything.
The phone's own record wins where both have one.

Without this the restore promise could not be kept, and it is the one piece of
Part B that had to reach back into Part A.

## A newer schema is left alone

A generation whose schema version is higher than this app's is not damage; it
is this app being behind. It is never written over, the user is told to
update, and the next generation number is counted from **every** folder
present rather than the newest that validated — so a newer app's number can
never be reused.

## What travels

Identity, notes, characters, tags, progress and library-card history. Nothing
else: titles, durations, covers and part lists are rebuildable by rescanning
the drive the backup sits on, so carrying them would be carrying a worse copy
of something already there. Records whose books this phone does not know stay
on the drive and arrive if the book ever does.

Settings → **Back up reading data to the drive**, on by default. A library
that lives on the phone skips it — the books and the writing are already in
one place, and the Android backup rules carry both. The Book screen says where
this book's writing is: "Saved on phone · drive backup pending" until the
drive has a current copy.

## Tests

37 new unit tests in `tests/sync.test.ts`: tie-breaking in both directions,
every record type's tombstone, undo beating a delete, a rewind beating a
further position, all of one book's checkouts surviving, tags suppressed by a
deleted note or character, the conflicted copy created once across repeated
syncs, validation refusing a missing part, a changed part, a self-inconsistent
manifest, a stale part from an older generation, another library's backup and
a newer schema, and pruning that never touches anything newer than the newest
good generation.

Five on-device cases in `src/dev/syncSuite.ts` (A14): a backup lands and reads
back, wiped notes come home, a truncated newest manifest falls back to the
previous generation, a newer-schema generation is left byte-for-byte alone,
and repeated syncs do not pile up folders.

*`src/lib/sync/records.ts`, `src/lib/sync/generations.ts`, `src/lib/sync/driveSync.ts`,
`src/lib/sync/driveFolder.ts`, `src/db/sync.ts`, `src/db/schema.ts`, `src/db/books.ts`,
`src/db/notes.ts`, `src/store/backup.ts`, `src/store/scan.ts`, `src/app/settings.tsx`,
`src/app/book/[id].tsx`, `src/app/_layout.tsx`, `src/dev/syncSuite.ts`*

---

# Card pass — the Book screen as a stack of paper

The margins shipped working but looking borrowed: the notes and characters
panes were their own thing, sharing neither the typeface nor the texture of
the library card above them.

## One stack, three cards

`CardStack.tsx` replaces `BookTabs.tsx`. The tabs are the top edges of cards in
a pile: the active one takes the paler paper and overlaps the body by a pixel
so the line between them disappears, and the ones behind sit at reduced opacity
in the darker stock. Nothing animates. A stack of index cards does not slide.

`PaperCard.tsx` became the shared surface — ruled lines at an exported
`RULE_PITCH` so a note's rows line up with the rules behind them instead of
drifting a little further out of step down the card.

*`src/components/CardStack.tsx`, `PaperCard.tsx`, `LibraryCard.tsx`*

## Naming, as asked

"Who's who" became **Characters** and "Margins" became **Notes**. The old names
were ours; these are what the thing is.

*`src/components/CharactersCard.tsx` (was `WhosWho.tsx`), `NotesCard.tsx`*

## The note sheet stopped fighting React

`NoteSheet.tsx` lost a third of its lines. It had been synchronising props into
state inside an effect, which `react-hooks/set-state-in-effect` is right to
object to: a save finishing could overwrite newer typing. The component is now
keyed on the note's id and initialises its state from props, so a different
note is a different component and the question never arises.

*`src/components/NoteSheet.tsx`*

---

# Sound pass — effects, and what happens when the headphones come out

**Native.** This one needed a rebuild.

## A local Expo module for the audio session

`modules/dueback-audio` takes expo-audio's `SharedRef<ExoPlayer>`, reads the
audio session id off it on the main thread, and attaches Android's
`LoudnessEnhancer` and `Equalizer` to it. It queries the real band count and
level ranges rather than assuming, and re-attaches when the session changes.

Whatever is missing hides its own sliders. Playback never depends on an effect
initialising — **Off** always works, with or without Pro, with or without
hardware support.

*`modules/dueback-audio/**`, `src/lib/audio/soundFx.ts`, `src/store/sound.ts`*

## Three presets and a Custom that appears by itself

Off, Clear voice, Quiet recording, built from Boost, Clarity and Warmth. Moving
any slider selects Custom; nothing has to be chosen first. Settings are per
book in SQLite, with "make this the default" and "use the all-books default"
for the override. Boost is capped at 12 dB by the app, which is our judgement
and not a hardware maximum.

*`src/lib/audio/sound.ts`, `src/components/SoundPanel.tsx`*

## Pulling the headphones out pauses

`ACTION_AUDIO_BECOMING_NOISY` is received natively, pauses there, and then
tells the JavaScript engine so its playback intent stops too. Pausing in only
one of those two places leaves the app believing it is still playing.

*`modules/dueback-audio`, `src/lib/audio/expoAudioEngine.ts`, `src/store/player.ts`*

## The module was not linked, and said nothing

The first build contained no `dueback-audio` at all. No error at build time, no
warning at runtime — just a module that was not there. A local module is only
autolinked if `package.json` says where to look:

```json
"expo": { "autolinking": { "nativeModulesDir": "./modules" } }
```

It was caught by checking the merged manifest and noticing that the one
permission present had come from expo-audio rather than from us.
`npm run kb -- "autolinking"`.

*`package.json`*

---

# Backup frequency — a position tick is not an edit

Found on a real drive rather than by a failing test: the generation numbers had
climbed four between two looks at the same folder.

Progress is written every five seconds while a book plays, and every write
scheduled a backup. The debounce was 1.5 seconds — shorter than the drip — so
each tick got its own full read-merge-write-validate cycle, in synchronous file
calls, for as long as a book played. The pruning keeps only two generations,
which is exactly why the folder looked tidy while the drive never stopped
working.

`readingDataChanged` now takes a kind. **Authored** changes — a note, a
character, a book going out or coming back — still go almost at once, with the
short debounce to collect a burst. **Progress** is capped at one backup per ten
minutes, because the phone already holds the position safely: the drive's copy
is insurance against losing the phone, not a live mirror, and every backup
writes the whole set, so the next note or scan carries the latest position
across anyway.

`cancelScheduledBackup()` was added with it, for a drive that goes away — and
because a ten-minute timer otherwise holds Node's event loop open and hangs the
test suite.

A regression test fires six progress ticks and asserts that none of them
reaches the drive, while the Book screen still reads "pending" throughout.

*`src/lib/sync/changes.ts`, `src/store/backup.ts`, `src/db/books.ts`,
`tests/audit-regressions.test.ts`*

---

# First full hardware pass — 15 October 2026

Not a change, but the thing the three passes above were waiting for. Seven
checks on a Pixel with a real USB drive: the uuid migration against a real
library, the Sound panel, the headphone pause, `.dueback/` created by a real
SAF provider, notes, a renamed folder reconnecting silently, and a full restore
after clearing app data. All passed. The backup-frequency bug above was the
only thing it turned up, and only by looking at the drive.

`docs/STATE.md` holds the detail, and what is still unverified.

---

# The self-test suites are gone

Fourteen scripted suites, about 280 cases, a harness, three fixture
generators and an emulator runbook. All removed.

They were built when there was nothing else to test against: no real library
indexed, no phone that could be trusted to hold one. That stopped being true.
The library on the drive is hundreds of real books with naming no generator
would invent, and testing against it by hand answers questions the fixtures
never could.

Three things decided it.

**The fixture library was the thing being tested.** Twenty synthetic books
with deliberately awkward names. Passing said the code handled the twenty
cases someone thought of, which the unit tests already cover more cheaply.

**The button was one tap away in a release build.** `Settings → Self-test`
shipped with no `__DEV__` guard, pointed at a hardcoded fixture path that
does not exist on a real phone. Running it re-pointed the library root at an
empty folder. A reset added the day before — `wipeAppData()` followed by
reconciliation — would have deleted every checked-out book and permanently
dropped any book imported from the phone and never pushed to the drive,
which exists in exactly one place. That change was never merged.

**Nobody was running them.** Not in CI, not on the Pixel, not for weeks.

`src/dev/faults.ts` stays. Its two readers are wired into `copy.ts` and the
library store, and both now report "nothing set", so the app asks the
filesystem as it always would. Tearing it out means editing the copy path to
no purpose.

What remains: `npm test`, `npm run lint`, `npm run typecheck` in CI on every
push, and a person with a Pixel and a USB drive. `docs/STATE.md` says which
answers which.

## And one thing CI was never running

`.gitignore` held a bare `fixtures/`, which git matches at any depth. It was
meant for the generated library at the repository root; it also matched
`tests/fixtures/`, the 644 KB of small audio files that
`tests/parser.test.ts` opens by name — a file whose own header says they are
"committed with the repo". They were not. CI had no way to pass that test.

The rule is now anchored, `/fixtures/`, and the seven files are committed.

`tests/fixtures-parse.test.ts` went with the generator: 12 cases against the
101 MB library covering a DRM-flagged file, a container truncated before its
`moov`, a megabyte of noise named `.mp3`, a zero-length file, and the
255-chapter Nero ceiling. They passed on a machine that had generated the
library and were skipped everywhere else, CI included.

*Removed: `src/dev/harness.ts`, `suites.ts`, `identitySuite.ts`,
`marginsSuite.ts`, `syncSuite.ts`, `src/app/dev/selftest.tsx`,
`scripts/make-fixtures.ts`, `make-testlib.ts`, `verify-testlib.ts`,
`docs/EMULATOR.md`, `tests/fixtures-parse.test.ts`*

## A front door, and a workshop behind it

The README was a build document with a vocabulary table on the front. It served
the two people who had the repository checked out and nobody else: a reader
arriving from a link met 249 lines whose third section was
`-PreactNativeArchitectures` and whose fourth was the Gradle cache.

It is now the front door. What the app is and why it exists, what it does, the
vocabulary, how a library gets made, then an **Engineering notes** section —
the byte-range reads, sampled identity, the atomic resumable copy, whole-book
seconds over many files, the serverless merge, derived palettes, the drag built
on `PanResponder` alone, and what 582 tests do and do not cover. Each one is
a constraint and what it cost, because that is the part worth reading.

Everything operational moved, unedited where it was still true, to
`docs/DEVELOPMENT.md`: the development build, the local Gradle invocation and
why it takes an architecture flag, the layout, how scanning works, the
feature-by-feature account of what is real, and the known gaps.

Two things were stale and are fixed in the move. The Interactions section still
described the `+` corner tab, removed four passes ago; it now describes
long-press and the drag grip, and says why the tab went. The layout tree
predated `theme/palettes.ts`, `lib/stats/`, `lib/sync/`, `db/listening.ts` and
four of the nine routes.

`LICENSE` is MIT, which `docs/STATE.md` had wanted for a while and the draft
README had carried as "no license has been added yet". The copyright line says
`jacawl`; a legal name belongs there before anyone reads it as a notice.

*`README.md`, `docs/DEVELOPMENT.md` (new), `LICENSE` (new), `CHANGES.md`,
`docs/STATE.md`, `HANDOFF.md`; removed `README_NEW.md`, a draft folded in*

## Three things the ear and the lock screen noticed

**A mark is not always a chapter.** A book cut into equal lengths with no
chapter marks of its own gets one mark per file, and the tenth file was
labelled "Ch. 10" while the listener was somewhere in chapter four. The scan
already knew: `chaptersFromParts` has been set and stored since the fallback
was written, so this is a wording change over data that is already right, and
an existing library says the correct thing without a rescan.

`src/lib/library/marks.ts` is the only place that reads the flag, and
everything that names a mark goes through it — the mini player, the book
screen, the player's heading, the contents sheet, the chapters tab and its
gutter, the character sheet, the note chips, the tab label, the server screen.
The word is spelled out. "Section 10", never "Sec. 10", which sitting beside
`1:23:45` reads as ten seconds; "Part" was the other candidate and is already
the app's word for one file of a book.

**The lock screen's skip buttons did nothing, and ten seconds was wrong
anyway.** expo-audio 57 builds them as custom session commands and then
answers `RESULT_ERROR_NOT_SUPPORTED`, which a controller is entitled to act on
by ignoring the button — so they rendered and nothing happened. Wired to
`COMMAND_SEEK_BACK`/`COMMAND_SEEK_FORWARD` instead, media3 does the seeking
itself, using the increments the player was built with. Those are hardcoded in
two files, and the `_10` icons draw the number, so all of it moves together: a
minute, on plain icons.

`plugins/withLockScreenSeek.js` applies it at prebuild rather than through
patch-package, which would need a `postinstall` hook. `android/` is generated
and never committed here, so prebuild runs before every native build, locally
and on EAS: the edits land exactly when they can matter. Every rewrite is a
literal string that must match, and a miss **fails the build** — on an upgrade
that silently reformats one of those lines, the alternative is an app whose
lock screen is quietly broken again.

**The first half-second after a rewind was warped.** `preservesPitch` is true,
so above 1× audio runs through Sonic, ExoPlayer's time-stretcher, and a seek
flushes the pipeline it has to re-prime in. An MP3 with no seek table can also
land mid-frame. Two causes, one shape — a short burst of wrong audio at a known
instant — so the engine covers the instant rather than chasing either: volume
to zero, seek, a 220 ms ramp back. Status arrives twice a second and restores a
volume left below full, because a book stuck silent would be far worse than the
artefact the fade exists to hide.

**And `npm run kb` had been answering "nothing" for everything.** The parser
split on `\n`, `core.autocrlf` is on, and `/^## (.+)$/` cannot match a line
ending in a carriage return: `.` stops before it and `$` finds a character
still to come. Every heading failed, so the knowledge base parsed to zero
entries and every query came back "Nothing for <term>" — indistinguishable
from a knowledge base with nothing to say, while `AGENTS.md` tells everyone to
search it before debugging. It splits on either ending now, and finds its 105
entries.

*`src/lib/library/marks.ts` (new), `plugins/withLockScreenSeek.js` (new),
`src/lib/audio/expoAudioEngine.ts`, `scripts/kb.ts`, `app.json`, nine screens
and components, `tests/marks.test.ts` (new), `docs/KNOWLEDGE.md`,
`docs/DEVELOPMENT.md`*

## What a scan is entitled to conclude, and two other refusals

An audit found four things. All four were real; three needed work.

**A partial scan could mark present books missing.** `markMissingExcept` marks
every drive book missing and then un-marks the ones the scan found, so absence
from `seenIds` is the entire evidence. Three things put a book that is
physically on the drive outside that set: a subfolder that would not list, a
subtree past the walk's depth limit, and a group that threw while being read.
None was visible to the sweep, and the depth limit was visible to nobody — it
returned silently, so a library nested deeper than eight folders lost books
with nothing anywhere to say so.

Nothing was destroyed on the spot; a wrongly-missing book keeps its progress
and its library-card history. The cost arrives one step later, when Settings
offers to "Forget N missing books" and the offer looks entirely reasonable.

The protection is **per folder**, not per scan. Treating any unreadable folder
as making the whole scan inconclusive was the recommendation and it is wrong: a
drive with one permanently unreadable folder — a `System Volume Information`, a
trashed folder, a broken permission — would then never mark anything missing
again, and a book really deleted would sit on the shelf forever. Narrowing it
to the subtrees that were not read keeps the answer right everywhere else.
Protection means *unchanged*, not *present*, so a book already known missing
stays missing. The reconnect pass is filtered the same way: offering to merge a
book with an unrelated one because its subfolder would not list is the same
mistake as doing it because the cable was loose.

**Plain http to a public address is now refused, not warned about.** The note
in `app.json` promised that release would scope cleartext to private address
ranges with a network security config. **That cannot be written.**
`usesCleartextTraffic` is all or nothing, and a config's `<domain>` takes a
hostname or an IP literal — there is no subnet syntax — so the rule cannot be
expressed in the manifest for an address typed in at runtime. It is enforced in
`request` instead, the one place every server call passes through, so it covers
a source saved before the check existed and covers streams, covers and progress
reports rather than only the connect form. `isCleartextToPublicHost` already
classified addresses for a warning; the client refuses on it now, before
anything is sent, and the test asserts the fetch count is zero. The flag
staying on is deliberate rather than deferred, and `docs/STATE.md` says so
instead of calling it a blocker.

**A folder import descends now.** It listed the picked folder's immediate files
only, so a book arranged as `Disc 1/` and `Disc 2/` yielded no audio and was
refused as if it held none — while the scanner had always handled disc folders.
Two rules came with fixing it. Parts order by path rather than filename, or two
discs numbering from one interleave and the book plays 1, 1, 2, 2. And a part
out of a subfolder is renamed to carry it — `Disc 1 - 01.mp3` — because that
name is what a later push to the drive calls the file, in one flat folder: two
`01.mp3` files would have meant the second landing on top of the first.

**And the sort picker said "Custom" over shelves in length order.** The
fallback computed the sort it rendered with and then handed the header the
saved one. The saved preference is deliberately still left alone: custom is
where the listener put themselves, and writing it back would turn a bad scan
into a lost choice.

*`src/lib/scan/coverage.ts` (new), `src/lib/library/importOrder.ts` (new),
`src/db/books.ts`, `src/lib/files/access.ts`, `src/lib/files/import.ts`,
`src/lib/scan/scanner.ts`, `src/lib/abs/client.ts`, `src/lib/abs/errors.ts`,
`src/components/AbsTesting.tsx`, `src/app/index.tsx`, `app.json`,
`plugins/withCleartextTraffic.js`, `tests/coverage.test.ts` (new),
`tests/import-parts.test.ts` (new), `tests/abs-client.test.ts`,
`docs/KNOWLEDGE.md`, `docs/STATE.md`*

## A book can be told what it actually is

Metadata comes from the files, and files lie. "Hyperion" sits in the library
filed under the author **"Top 100 scifi books"** because that is what its tags
say, and no amount of better parsing fixes it: the tag is not malformed, it is
wrong. Title, author, narrator, series, number in the series and the cover can
now all be corrected, from an "edit details" link on the Book screen.

**The correction is a layer, not an edit.** `upsertBook` sets
`title = excluded.title` unconditionally, so anything written into that row
survives until the drive is next plugged in — a silent loss, days later,
looking exactly like the app having ignored the edit. Corrections live in their
own table and `loadBooks` lays them over the scan, which also keeps the file's
own answer so "put it back the way the files describe it" is possible at all.

**Layered in one place, on purpose.** Shelves, the letter bands, the series
ledges, search and every sort read `Book.title`, `Book.author` and
`Book.series`, so one layering at the read makes all of them follow a
correction. Fixing it in the UI would have renamed a book on its own screen
and left it filed under the old name on the shelf.

**Empty is a correction.** `null` means "not corrected"; `''` means
"corrected to nothing". The honest fix for that bogus author is no author
rather than another guess, and collapsing the two would make the one field
anybody wants to clear the one field they cannot. The number in a series is a
text column for the same reason: a number has nowhere to put "deliberately
none".

Two things that would have been bugs and are now rules with tests on them. An
**unchanged save stores nothing** — open the editor, change nothing, press
Save, and no correction is written, because recording one would freeze that
field against every future rescan with nobody aware of it. And a correction is
**per field**, so choosing a picture cannot quietly revert a title typed a
moment earlier.

Corrections travel on the drive, keyed by book, newest write winning. They
have to: a rescan on the other phone would give the *wrong* answer back, since
the tags that prompted the fix are still in the files and still wrong. A revert
travels as a tombstone rather than an absent row — an absent row reads as
"nothing to say", and the other side's surviving correction would win by
default and put the old value back.

**A picked cover would have been deleted by the next scan.** `deleteCoversFor`
clears a book's thumbnails by prefix, which is how new artwork replaces old
without knowing its name, and a picked cover sits under that same prefix. It
is now marked in its file name and survives the sweep, except when the book is
being forgotten. The rule is pure and tested, because when it breaks the
symptom is a blank cover days later with no error anywhere.

**And `CoverFace` had no `onError`.** Any thumbnail that would not load
rendered as a blank rectangle in the book's colour instead of falling back to
the drawn cover — reachable without any of this, since "Clear storage" empties
that directory. The fallback is keyed to the failed URI rather than a flag,
because a thumbnail's name changes with its artwork and a flag would outlive
the file it was about and hide the next cover picked.

The picker is `expo-image-picker`, whose config plugin adds `CAMERA` and
`RECORD_AUDIO` by default. Both are **blocked** in `app.json` rather than
merely omitted, so no other package can add them back: an offline audiobook
player asking for a camera and a microphone to fix a cover is alarming to read
and more to declare on a store listing.

`withLockRetry` moved from `src/db/books.ts` to `src/db/schema.ts` on the way
through. It is a generic retry around a locked database and had nothing to do
with books; leaving it there would have put the corrections module in an import
cycle with the one that reads them.

*`src/lib/library/overrides.ts` (new), `src/db/overrides.ts` (new),
`src/lib/files/coverNames.ts` (new), `src/components/BookDetailsSheet.tsx`
(new), `src/db/migrations.ts`, `src/db/books.ts`, `src/db/schema.ts`,
`src/db/sync.ts`, `src/lib/sync/records.ts`, `src/lib/files/access.ts`,
`src/lib/files/covers.ts`, `src/components/CoverFace.tsx`,
`src/app/book/[id].tsx`, `src/data/types.ts`, `app.json`,
`tests/overrides.test.ts` (new), `tests/overrides-db.test.ts` (new),
`tests/cover-names.test.ts` (new), `tests/sync.test.ts`, `docs/KNOWLEDGE.md`,
`docs/STATE.md`*

## The drive can be read, copied and written without a phone

`listTree`, `copyBookToDevice`, `swapIntoPlace`, `recoverInterruptedSwaps`,
`collectAudio` and `copyImportToDrive` are around 2,200 lines that had no unit
tests at all, because every one of them reaches `expo-file-system` and would
not load in Node. They are the lines that read the library, fill the phone and
write into the only copy of anything — so they were simultaneously the riskiest
code here and the least covered.

`tests/fakeDrive.ts` stands in for `expo-file-system` through `registerHooks`
from `node:module`, and **only** for that. The walk, the copy and the import
are the real ones; nothing here is a second implementation to compare against,
which would prove nothing. 57 new cases, and most of them are failure paths
that used to need a cable to provoke: a folder that will not list, a subtree
past the depth limit, a book deleted from the drive since the last scan, a
phone with no room, a cancel between parts, a resume after a kill, two
same-sized parts that swapped places, and a push that dies half-written.

**The fidelity rules are the point, not the plumbing.** A model of the Storage
Access Framework is not SAF, and most of the expensive bugs in this repository
were ones a model would have got wrong. Three rules have already earned their
place. `File` and `Directory` have to be **unrelated classes**, because the
real ones are, and `listTree` branches on `instanceof Directory` while
`localPathsFor` branches on `instanceof File` — with one extending the other, a
`.previous` folder reads as audio. `copy` and `move` have to be **async** while
`delete`, `write`, `create` and `list` are **not**, or the fake would have let
`npm run kb -- "asynchronous"` straight through. And `entry.name` has to be
able to return a **SAF document id**, or nothing proves `safDisplayName` is
still applied.

What it does not model is written down beside it, so nothing is mistaken for
covered: SAF renaming a file you asked it to create, descriptors going stale,
permission revoked between launches, and speed. Those stay device checks, and
`docs/STATE.md` now says so.

**`copy` and `move` do not land where the docs suggest.** The rule is not
documented; it is in `CopyMoveStrategy.prepareAsDestination` in
expo-file-system's Android source, and it is conditional: a directory moved
onto a directory that **exists** lands *inside* it, and only renames when the
destination does not exist. That is why `swapIntoPlace` moves the old copy
aside *before* moving the new one in — reverse the order and the staged book
lands at `books/<id>/<id>/`, one folder too deep, where the player, the part
paths and `deleteLocalCopy` all miss it. A checked-out book with invisible
audio and no error anywhere. The fake implements the real rule, so the test
asserts the behaviour rather than a guess.

Two things found while writing it, both in the tests rather than the app. A
test for the staging manifest passed for the wrong reason — a malformed
manifest takes the same "start over" path as a mismatched one, so it would
have passed with the check deleted. It now uses the case the manifest actually
exists for and the size check cannot catch: two parts of equal length that
swapped places on the drive, which without the manifest would be read back
under each other's names and play the book's halves in the wrong order. That
one was verified by breaking `stagingIsFor` on purpose and watching it go red.
And a test asserting a marked folder is invisible to a scan was removed rather
than fixed: `tests/grouping.test.ts` already pins that rule, and a second copy
of it is a second thing to keep true.

*`tests/fakeDrive.ts` (new), `tests/drive-read.test.ts` (new),
`tests/checkout-copy.test.ts` (new), `tests/import-drive.test.ts` (new),
`docs/KNOWLEDGE.md`, `docs/STATE.md`*

## The lock-screen fix was never in the app, and the lag has two causes

**The lock screen patch reached the phone and did nothing.** Three Kotlin
files rewritten at prebuild, every literal matched, every assertion passed,
`grep` confirming `60000` and `COMMAND_SEEK_BACK` in the patched source — and
the buttons still jumped ten seconds on the device.

expo-audio **ships a prebuilt AAR**, declared as a `publication` in its
`expo-module.config.json`, so autolinking links that artifact and Gradle never
compiles the Kotlin being patched. Verifying the source verified nothing, which
is why the fault survived a build, a publish and a device session. The local
module under `./modules` has no publication, which is why patching *that* has
always worked and nothing had ever caught this.

`buildFromSource: ["expo-audio"]` in `package.json` makes the source the thing
that gets built, and `assertBuiltFromSource` in the plugin now refuses to run
without it — a patch that silently does nothing is worse than no patch. The
signal that it took is `node_modules/expo-audio/android/build/` existing after
a build; the patched `.kt` file proves nothing either way.

**The lag after saving has two separate causes, and both were real.**

The first is that correcting one field reloaded the whole library. `refresh()`
re-reads every book, part, chapter, checkout and correction and rebuilds every
object, on the JS thread — right after Save, which is exactly when the screen
should be answering taps. `loadBook(id)` and the store's `refreshBook` are for
edits that touched one book, and they share `loadBooks` so a book loaded alone
cannot drift from the same book loaded with the rest.

The second explains the lag that turns up "periodically, after doing
something", which is the harder one to attribute. Every filesystem call in
`src/lib/sync/` is **synchronous** — `list()`, `textSync()` and `write()` all
are — so a backup was one unbroken block of JavaScript: write the generation,
then read all of it back off the drive to validate. An authored change of any
kind schedules that 1.5 seconds later, so the freeze arrives detached from
whatever caused it. `readGeneration`, `readDrive` and `writeGeneration` now
yield between files, exactly as `listTree` does. That does not make a backup
faster; it turns one long freeze into many short ones. Making it faster would
mean not reading the generation back, and that read-back is the only thing
that makes a backup trustworthy.

**"Check again" in Settings said nothing at all.** It called `checkDrive()`
and fired and forgot, so when the answer did not change — which is always,
when the drive really is unplugged — pressing it was indistinguishable from
the app ignoring the press. The Library header had the right behaviour already,
including a deliberate 650 ms floor so the answer cannot appear to arrive
before the tap landed. That behaviour is now one store action, `lookForDrive`,
used by both; Settings had none of it and the header had a private copy.

**The drive light, and a way to look for the drive once a server exists.**
With an Audiobookshelf source configured the header's button becomes a source
switcher, whose tap is spent on switching — leaving no way to ask "is the
drive there?" from the one place that shows whether it is. Long-press now
looks, and a small dot shows the answer: the palette's own olive and red
rather than signal colours, hollow while a look is in flight. Both are hidden
when the active source is a server, because a light beside a server's name
would be read as saying something about the server, which this knows nothing
about.

One stray character fixed on the way past: a drive-identity error read "this
library?s identity".

*`package.json`, `plugins/withLockScreenSeek.js`, `src/lib/sync/driveSync.ts`,
`src/lib/sync/libraryIdentity.ts`, `src/db/books.ts`, `src/db/overrides.ts`,
`src/store/library.ts`, `src/app/book/[id].tsx`, `src/app/index.tsx`,
`src/app/settings.tsx`, `src/components/LibraryHeader.tsx`,
`tests/audit-regressions.test.ts`, `docs/KNOWLEDGE.md`, `docs/STATE.md`*

## A whole scan, in a test — and what it found on the first run

`scanLibrary` is the largest thing here and the one that decides what a library
*is*. Its helpers were well covered; the orchestration joining them had no
tests at all. It does now: `tests/scan-end-to-end.test.ts` runs a scan from
files on a drive to rows in a database, 19 cases.

Three natives are stood in for and nothing else is. The filesystem is the
in-memory drive; the database is **real** SQLite through `node:sqlite`, so the
production migrations and every production statement run for real; the image
manipulator stores without resizing. The audio is real too — the committed
fixtures carry genuine ID3 tags, chapters, cover art and a Xing duration
header — so the parser, naming, grouping, identity and sweep are all the real
ones. A book now arrives in the test titled "The Count of Monte Cristo" by
Alexandre Dumas with five chapters and a cover, because that is what is in the
file.

**It found a silent data-loss bug on the first run.** `planReconnection`
refuses to guess when one missing book matches several new folders — "which one
someone meant is not ours to guess". It could not see the mirror image. Several
missing books matching **one** new folder is the same ambiguity with the same
cost, and the loop gave the folder to whichever vanished book it reached first,
reporting a clean reconnect and raising no question.

The way it bites: two copies of one rip, `Hyperion` with three hours of
progress and twenty notes and `Hyperion copy` untouched. Delete the copy on a
computer and rename the one you listen to. The next scan sees two vanished
books and one new folder, and could move the renamed folder onto the *copy's*
identity — leaving the progress and every note stranded on a book now marked
missing, with no undo and nothing on screen to explain it.

Fixed by running the same rule backwards rather than writing a second one: the
new folder as the thing that went, the still-missing books as its candidates.
More than one match and nobody is reconnected without being asked, and both
matching books raise their own question so the listener hears about every book
the folder might be. Two identical books plus one new folder is three lines to
set up and had never once been tried by hand.

Two of my own tests were wrong in ways worth recording. One asserted the book
id matched a uuid pattern; `newUuid` deliberately mints a timestamp-and-random
id, not an RFC uuid, and the code was right. The other claimed to test the
depth limit and tested nothing: the limit is fixed at eight and not a scan
option, so a plausible-looking end-to-end version passes whether or not the
protection works — nest the library deeper and the old shallow path is simply
gone from a readable root, which *should* mark it missing. It was removed with
a note saying why, since `tests/coverage.test.ts` pins that rule directly.

An early version of the suite also scanned zero-filled files, which are not
audio: they produce a book with no parts and "Nothing in this folder could be
read as audio". Correct behaviour, now tested deliberately rather than by
accident.

The reconnection guard and the depth-limit regression were both
mutation-checked — the production code broken on purpose to confirm the tests
go red.

*`src/lib/scan/scanner.ts`, `tests/scan-end-to-end.test.ts` (new),
`tests/fakeDrive.ts`, `docs/KNOWLEDGE.md`, `docs/STATE.md`*

## A removed server took its books to the drive

Reported from a real phone: remove an Audiobookshelf source, sign back in, and
some server books — a mix of checked-out and not — are sitting in the USB
library stamped "the last scan couldn't find this one on the drive", with a
second, live copy of each beside them.

One statement did all of it. `removeSource` kept books holding a place or a
note, on the reasoning that those are the listener's and outlive the server.
The reasoning is right. The statement was:

```sql
UPDATE books SET source_id = NULL, remote_id = NULL, missing = 1
 WHERE source_id = ?
```

and `DRIVE_BOOKS` is literally `source_id IS NULL`. So every kept book became
a book on the drive. It appeared on the drive's shelf unplayable; the next
scan's sweep stamped it missing; `forgetMissingBooks` — which selects exactly
`missing = 1 AND source_id IS NULL` — offered to delete it beside genuinely
missing books with nothing distinguishing them. Clearing `remote_id` then
destroyed the only link by which signing in again could have recognised the
book, so a fresh row was made beside it. Only books holding something survived
to become ghosts, which is why the symptom was "some of them, a mix of
checked-out and not": precisely the ones worth keeping.

A source is tombstoned now rather than deleted. Its books keep `source_id` and
`remote_id` and are left entirely alone, and `addSource` revives the row when
the same server and account are signed into again — matched on the server URL
and username rather than the label, which is only a name. Everything comes
back attached to it with its place, its notes and its card history, and nothing
duplicates. Books holding nothing of the listener's are still deleted outright,
since there is nothing in them to protect.

The rule worth remembering: a book's `source_id` is its identity, not a link
to tidy up. Clearing it does not detach a book from a server — it hands the
book to the drive.

**It had a passing test that blessed it.** `tests/sources-migration.test.ts`
contained a case called "unhooks a removed source from its books instead of
deleting them" which hand-copied the statement above and asserted `source_id`
came out null, as though that were the contract. It executed its own copy
rather than calling `removeSource`, so it could not fail when `removeSource`
was wrong; it only ever agreed with itself. That is the failure mode
`tests/fakeDrive.ts` was written to avoid, found in the wild in the same
afternoon. It is gone, with a note in its place saying what it did.

`tests/sources-removal.test.ts` replaces it: twelve cases calling the real
`removeSource`, `addSource`, `listSources` and `forgetMissingBooks` against
real SQLite. Putting the old statement back fails five of them, including the
duplicate on re-add — checked by doing exactly that.

Migration 19 cleans up the books already orphaned on the phone. The signature
is exact and cannot catch a book that came off a drive: a drive scan never
writes `remote_updated_at`, so `source_id IS NULL` together with one can only
be a book cut loose by the old code. Their parts and checkouts go with them;
notes are kept, as all housekeeping here keeps them, and the audio left in
`books/<id>/` is swept on the next launch by the reconciliation that already
removes any folder no checked-out book claims.

*`src/db/sources.ts`, `src/db/migrations.ts`, `docs/KNOWLEDGE.md`,
`docs/STATE.md`, `tests/sources-removal.test.ts` (new),
`tests/sources-migration.test.ts`*
