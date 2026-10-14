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

Driven by the List B findings written into `TESTING.md` against a real drive and
a real Pixel. Everything here is JavaScript; no rebuild is needed.

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
