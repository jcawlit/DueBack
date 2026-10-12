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
