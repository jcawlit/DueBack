# Knowledge base

Things that cost time to learn and would cost it again. Platform behaviour that
contradicts the documentation, invariants the code depends on, and decisions
that look wrong until you know why.

**Check here first** when something behaves oddly, before reading code.

```sh
npm run kb saf          # entries matching "saf"
npm run kb cover id3    # entries matching either word
npm run kb              # list every heading
```

**Keep it current.** Any change that teaches something — a platform quirk, a
fixed bug whose cause was not obvious, an invariant — gets an entry here in the
same change. Code comments should state the rule and point here for the story,
rather than carrying the story themselves.

---

## Files, SAF and the drive

### SAF names are document ids, not display names

On a USB volume `entry.name` is `BC72-B058:Some Folder`, and nested it is
`BC72-B058:Some Folder/Disc 1`. Always pass it through `safDisplayName` before
showing it or treating it as a filename. Untrimmed, the volume prefix ends up in
book titles and chapter names. Splitting on `/` alone is not enough.

*`src/lib/files/safNames.ts`*

### A directory URI must end in a slash

`expo-file-system` treats a `Directory` URI without a trailing slash as a file:
listing one throws, the scan reports the root unreadable and finds nothing —
silently, because an unreadable folder is only a warning. The system picker
happens to return the slash, so this only bites a root from anywhere else. Use
`asDirectoryUri`.

*`src/lib/files/access.ts`*

### A missing root looks exactly like an empty one

`Directory.list()` does not throw for a folder that has gone; it returns
nothing. `exists` alone is not enough either, because it can be true for a stale
SAF permission. Prove a root by checking `exists` **and** listing it — that is
`isReachable`. Anything that marks books missing must know the difference, or an
unplugged drive wipes the shelf.

*`src/lib/files/access.ts`, `src/lib/scan/scanner.ts`*

### Local file names must be ASCII and tame

`expo-file-system` builds every local file as `File(URI.create(uri))`, and
`java.net.URI` is the strict RFC 2396 parser: it rejects non-ASCII and the whole
`` [ ] { } | ^ ` " < > `` set, while the JS side only percent-encodes spaces,
`%`, `?`, `#` and control characters. An accented letter or a curly apostrophe —
commonplace in audiobook filenames — fails the entire copy with "Illegal
character in path at index N". Everything written into app storage is numbered
instead: `safeLocalName`. The readable name lives in the database.

*`src/lib/files/localNames.ts`*

### SAF cannot rename, move cheaply, or be copied to by name

The limits that shaped `copyImportToDrive`, none of them documented:

- `File.create()` refuses `content://` URIs outright — "use `Directory.createFile` instead".
- `copy()` to a *named* SAF destination cannot work: the destination either
  already exists (refused) or is a synthetic path the provider never made (no
  output stream). Only copying **into an existing directory** works, and the
  destination is then named after the source file.
- `move()` on a `content://` directory falls back to copying every byte and
  deleting, because `DocumentsContract.moveDocument` needs a destination parent
  that exists and `DocumentFile.fromTreeUri` returns no parent.
- `FileMode.ReadWrite` is unsupported. `WriteOnly` is accepted, but a handle
  held over a `content://` URI dies partway through a long copy — see **A file
  handle on a content:// URI goes dead on its own**.

So: `Directory.createFile(name, mime)` to make a named document, then put the
bytes through it a chunk at a time with `write(bytes, { append })`. There is no
atomic commit on a drive — write into the final folder and delete it on
failure.

*`src/lib/files/import.ts`*

### Metadata and direct byte calls block the JS thread

`Directory.list()`, `size`, `modificationTime`, `readBytes`, `writeBytes` — all
of these are synchronous; `move()` and `copy()` are asynchronous (see below).
A tree walk or a chunked copy therefore runs to completion inside one
JavaScript turn unless it yields: progress is reported faithfully and nothing
can paint until the work has already finished. Both the walk and the drive copy
`await` a zero timeout periodically for exactly this reason.

*`src/lib/files/access.ts`, `src/lib/files/import.ts`*

### The drive renames the file you asked it to create

`Directory.createFile(name, mime)` is a request. It reaches
`DocumentsContract.createDocument`, and the provider runs the name through
`FileUtils.buildUniqueFile`, which appends an extension matching the MIME type
when the name has none it recognises. A marker asked for as
`.dueback-incomplete` with `text/plain` lands as `.dueback-incomplete.txt`.

This is why `copyImportToDrive` already reads `created.name` back rather than
trusting the name it asked for. The incomplete marker did not, and matching
the exact string recognised nothing: a half-written book was indexed as a
short one, and the retry could not reclaim its folder. It looked right from a
computer, too — Windows hides known extensions, so the file still reads as
`.dueback-incomplete` in Explorer.

Anything that recognises a file this app created on a drive matches by
prefix — `isIncompleteMarker` — not by equality.

*`src/lib/library/grouping.ts`, `src/lib/files/import.ts`*

### move() and copy() are asynchronous; delete() and write() are not

`File`/`Directory` `move` and `copy` are `AsyncFunction Coroutine` in the
native module and return promises. `create`, `delete`, `write`, `list`, `size`
and `modificationTime` are plain `Function`s and run on the JS thread.

Mixing the two silently is easy and was done in three places. The commit step
of a check-out called `staging.move(finalDir)` without awaiting it, then
returned success — so the database recorded `local_rel_path` for files that
might not have arrived, and a move that failed did so as an unhandled
rejection. Cover storage moved the finished thumbnail into place unawaited and
then read `target.size`, which is why covers were recorded with a size of
nothing.

Lint will not catch this: `no-floating-promises` needs type-aware linting,
which this config does not run.

*`src/lib/files/copy.ts`, `src/lib/files/covers.ts`, `src/dev/harness.ts`*

### Replacing files on the phone is a swap, never a clear-and-refill

SAF cannot rename, so a book written to the drive goes straight into its final
folder and is protected by a marker. App storage *can* rename, so nothing
there has that excuse, and two places were deleting the old thing before
writing the new one:

- a check-out's commit deleted `books/<id>` and then moved the staging folder
  in — a window with neither on disk;
- `writeCoverBytes` deleted the cover, created an empty file, and then wrote
  the bytes.

Both now build the replacement in full, under another name, and swap. The
check-out moves the old copy to `books/<id>.previous` and deletes it only once
the new one has landed; `recoverInterruptedSwaps` runs at launch and puts it
back if the app died in between. Covers are written to `<name>.part`,
size-checked, and moved over the top.

The cost is two directory entries, not a second copy of the audio — which is
why this is worth doing here and a versioned snapshot of a multi-gigabyte book
would not be.

*`src/lib/files/copy.ts`, `src/lib/files/access.ts`*

### A file handle on a content:// URI goes dead on its own

`FileSystemFileHandle.forContentURI` opens a `ParcelFileDescriptor`, wraps its
`fileDescriptor` in a channel, and **keeps only the channel**:

```kotlin
val pfd = contentResolver.openFileDescriptor(uri, mode.descriptor) ?: throw …
val channel = FileOutputStream(pfd.fileDescriptor).channel
return FileSystemFileHandle(channel, mode)   // nothing holds pfd
```

The `ParcelFileDescriptor` is unreachable the moment that returns, and its
finalizer closes the fd underneath the channel. So any handle held across a
garbage collection can fail with `bad file descriptor` — and the longer it is
held, the likelier that is. Expo's own `copyFileViaChannel` keeps both
descriptors in `use {}` blocks for the whole transfer, which is why `copy()`
never shows this.

Two consequences, and they want different answers:

- **Reads** (scanning). Short-lived, and a failed read can simply be redone:
  551 files off a drive produced a few `Bad file descriptor` failures on the
  first seek, for files that read perfectly in isolation. One retry with a
  fresh handle covers it. Narrowed to that error class deliberately — a corrupt
  container should be parsed once and reported, not read twice.
- **Writes** (pushing a book to the drive). Held for the length of a whole
  audio file, with a yield between chunks that gives the collector its chance,
  and a retry is no use because half the bytes have already landed. So the
  destination is not held open at all: each chunk goes through
  `write(bytes, { append })`, which opens and closes its own stream inside one
  native call. The first chunk is written without `append`, so it truncates
  anything an earlier attempt left.

*`src/lib/files/access.ts` (`isStaleHandleError`), `src/lib/files/import.ts`
(`streamOntoDrive`)*

### Copying is staged and verified, and resumed only after a kill

Parts are copied into `books-tmp/<id>/`, each verified by exact size, and the
folder is moved into `books/<id>/` only when every part is accounted for — so a
half-copied book is never visible as a book. Any interrupt (cancel, pulled
drive, short read, failure) discards the staging folder.

The exception is the app being killed, where no code runs to discard anything.
Those files are kept and the copy resumes from them, but only if a
`manifest.json` proves the
folder was staged for exactly these parts in this order — staged files are named
by index, so without it two parts that swapped places on the drive would be read
back under each other's names.

*`src/lib/files/copy.ts`*

### A part-written book on the drive carries a marker

SAF has no rename, so an imported book cannot be assembled under a temporary
name and moved into place — it is written straight into its final folder. The
protection is `.dueback-incomplete`, created inside that folder before any
audio and deleted once every file has landed and been verified. A scan skips
any folder holding it, and everything beneath.

Three things about it are deliberate:

- `isJunkFile` makes an exception for this one dotfile. Every other hidden
  file is dropped during the walk, so without the exception the scan would
  never see the marker and the skip would silently never happen.
- A marker loose in the **library root** is ignored. The app only ever writes
  one inside a book's own folder, and honouring a stray one would hide every
  book on the drive at once.
- A push that finds its wanted name taken by a *marked* folder deletes it and
  reuses the name. Without that, a retry after a crash would take the next
  free number and leave the wreckage on the drive for ever — invisible from
  inside the app, because the scan skips it.

The residual window is tiny and worth knowing: dying between the last verified
byte and the marker's deletion leaves a complete book that scans ignore. The
marker is therefore removed first, before the result is even assembled, and a
later retry reclaims the folder.

*`src/lib/library/grouping.ts`, `src/lib/files/import.ts`, tests in
`tests/grouping.test.ts`*

### Unplugging mid-copy arrives as noise

Expo wraps native failures as `Call to function 'FileSystemFile.copy' has been
rejected. → Caused by: …`, which is not a sentence to show anyone. The error
text is also no way to identify a pulled drive. The honest test is whether the
source file still exists; the caller then asks whether the *root* is reachable
to tell a pulled drive from a deleted book. Marking a book NOT ON DRIVE because
someone unplugged the drive is a lie that outlives the moment.

*`src/lib/files/copy.ts`, `src/store/library.ts`*

---

## Metadata

### ID3v2.2 uses `PIC`, with a three-character format field

`APIC` (v2.3/2.4) names its format with a null-terminated MIME string. `PIC`
(v2.2) uses three bare characters — `JPG`, `PNG` — with no terminator. Parsing
one as the other sends the search for that terminator into the image data: it
lands 5 bytes into a JPEG and 9 into a PNG, returning a JPEG with no SOI marker
and a PNG with no signature. Android draws noise for one and nothing for the
other, for every book in the rip, because every part carries the same tag. Two
real Glen Cook rips in the library are tagged this way.

There is also a guard that trims anything before the image's own magic number,
for the tag layouts nobody predicted.

*`src/lib/metadata/mp3.ts`, tests in `tests/parser.test.ts`*

### Reads are byte-ranged and cached in 16 KB blocks

A 1 GB `.m4b` costs **164 KB in 3 reads**. File size barely matters; only the
number of seeks does. The block size is `DEFAULT_BLOCK_SIZE` in
`src/lib/metadata/reader.ts` and is reported on the dev screen so it can be
retuned against real USB latency. A multi-part book reads artwork from its first
file only — reading all of them turns a 127-part book into tens of megabytes.

### Duration comes from Xing/VBRI, or an estimate

An MP3 with no Xing or VBRI header is estimated from the first frame's bitrate,
which drifts on a variable-bitrate file with no header. Both real Cook rips are
in this category and play correctly, so the estimate is good enough in practice.

*`src/lib/metadata/mp3.ts` (`durationFromFirstFrame`)*

---

## Identity and scanning

### A folder the app created is claimed, not re-indexed

Pushing an imported book to the drive must preserve its uuid. The push records
the folder in `books.drive_rel_path`, and scanning claims it for the existing
book instead of creating a duplicate. See "A path locates a book; it does not
identify one" for path keys and reconnection rules.

*`src/db/books.ts` (`markImportOnDrive`, `claimedDriveFolders`)*

### Incremental rescans are keyed by folder, not by book

A folder can hold several books (a shelf of short works splits by album tag) and
the decision to re-read has to be made before any tags are read. The fingerprint
is `relPath:size:mtime` for every file in the folder. A file sitting directly in
the library root is the exception: those are keyed by their own path, because
keying them by folder files every one of them under the same empty string.

*`src/lib/library/grouping.ts` (`fingerprintKey`), `src/db/books.ts`*

### Only a complete scan of a readable root is evidence

`markMissingExcept` stamps every book the scan did not see, which blocks
check-out and dresses a book up as the only copy left. A cancelled scan is not
evidence of anything and an unreadable root is not an empty library, so the
evidence is an argument the function refuses to act without.

*`src/db/books.ts`, `src/lib/scan/scanner.ts`*

### Folders are split by album tag only

An earlier rule split a folder whenever its filenames varied once digits and
part markers were stripped. It was wrong in both directions — it shattered
self-recorded books and left unrelated files merged. Album tags are the only
evidence used, and that happens in the scanner where the tags have been read.
Disc folders (`CD 1`, `Disc 2`) merge into their parent.

*`src/lib/library/grouping.ts`, `src/lib/scan/scanner.ts` (`partitionByAlbum`)*

---

## Database

### The open is memoised as a promise, not a handle

Callers routinely ask for the database concurrently — `hydrate` alone fires five
queries through `Promise.all`. Caching the resolved handle instead lets every
one of those see `null`, open its own connection and run the migration, which
SQLite answers with a null-pointer failure from `prepareAsync`.

*`src/db/schema.ts`*

### Writers contend, so there is a busy timeout and a scan flag

`PRAGMA busy_timeout = 8000`, because `withExclusiveTransactionAsync` runs on
its own connection and a scan indexing books while a check-out records its files
would otherwise fail outright. On top of that, copies wait for a running scan
via `src/lib/scanBusy.ts` — plugging the drive in starts a re-sync scan and
flushes holds from the same event.

### A rescan must not lose where the local copy lives

`upsertBook` deletes and re-inserts a book's parts, and for a checked-out book
those rows hold the only record of its copy on the phone. The paths are carried
across by `rel_path`, and deliberately dropped when a part's size has changed.
Losing them left the book marked checked out with nothing behind it, and the
next launch's reconciliation deleted the copy.

*`src/db/books.ts` (`upsertBook`)*

### `copying` is never written to the database

It lives only in memory, so a copy interrupted by the app dying cannot come back
looking like a finished one. Two consequences: `refresh` has to preserve a copy
in flight rather than overwriting it with what the database last said, and the
orphan sweep must not delete the folder of a copy that is running.

*`src/store/library.ts`*

---

### "Database is locked" comes from our own transactions

`withExclusiveTransactionAsync` does not take a lock on the connection it is
called on — it opens one of its own, through `Transaction.createAsync`. The
expo-sqlite documentation is explicit about what that costs: "As long as the
transaction is converted into a write transaction, **the other async write
queries will abort with `database is locked` error**."

So `PRAGMA busy_timeout = 8000`, set on the main connection in `getDb`, does
not help: the pragma is per connection, and the transaction's is not ours to
set. A scan indexing books while a check-out recorded where it put its files
was enough to lose one of them.

Two rules follow:

- **Group writes that belong together into one transaction**, on the main
  connection, so there is no window to lose. Checking a book out writes the
  parts' local paths, the book's state and the checkout row — three awaits
  that were three chances to fail, and failing on the second or third threw
  away a copy that was already on the phone.
- **Retry a lock, and only a lock.** `withLockRetry` backs off to about six
  seconds. A constraint failure would fail the same way for ever, so it is
  rethrown at once.

*`src/db/books.ts`, `src/db/schema.ts`*

### Copy progress is patched per whole percent

Every `patch` rebuilds the books array, and the poll behind the copy's
progress fires several times a second whatever the size of the file. Patching
each tick re-rendered the shelves two or three times a second for the length
of a copy. The progress reported is the same; the number on screen only
changes a hundred times.

*`src/store/library.ts`*

## Audio

### One player for the whole book, never a playlist

`setActiveForLockScreen` exists only on `AudioPlayer`, and without lock-screen
controls Android stops background audio after about three minutes. Parts are
switched with `replace()` + `seekTo()`, and the next part is `preload()`ed as the
current one nears its end.

*`src/lib/audio/expoAudioEngine.ts`*

### The lock screen's field names lie

Android's media controls render `title` as the first line and `artist` as the
second. `albumTitle` goes to the notification's `setSubText`, which the modern
lock screen does not show at all. The chapter therefore goes in `artist` and the
author takes the hidden field: while listening, where you are matters more than
who wrote it.

Claim the lock screen once per book — `setActiveForLockScreen` releases the
MediaSession and builds a new one, so calling it per chapter tears the
notification down and puts it back.

### At a part boundary, `status.playing` is already false

Playback has ended, so it cannot answer "should the next part start?". The
engine tracks `wantsToPlay` — whether the listener wants audio — separately from
whether audio is coming out right now.

### expo-audio handles audio focus but not becoming-noisy

There is no `ACTION_AUDIO_BECOMING_NOISY` receiver anywhere in the package and
the ExoPlayer is built with `handleAudioFocus = false`, though the module
requests focus itself (so calls and other apps do pause playback). By the source
alone, unplugging headphones should keep playing out of the phone speaker — but
**the Pixel pauses correctly**, so nothing was built for it. If it ever blares,
this is why.

### Not available from expo-audio

Next/previous chapter on the lock screen: `AudioLockScreenOptions` has no such
flag and `AudioMediaSessionCallback.onConnect` explicitly removes
`COMMAND_SEEK_TO_NEXT` and `COMMAND_SEEK_TO_PREVIOUS`. The seek interval is
hardcoded at 10 s, so ±30 s is not configurable either. Both need a patch to the
module's Kotlin, which means carrying a fork across SDK upgrades.

### The sleep timer is a deadline, not a countdown

A one-second JS interval is the least reliable mechanism on the phone, for the
one feature whose purpose is to work with the screen off. It is a wall-clock
timestamp checked in the engine's status callback, which the native player
drives every 500 ms including in the background. Time spent paused counts.

*`src/store/player.ts`*

### A load that fails leaves the book id set

`open` returns early when the book asked for is already current — but the id is
set before the database read, the audio session and the engine load. A load that
failed or never settled therefore left the play button spinning for the rest of
the session, curable only by opening another book. The shortcut now requires the
engine to actually hold the book, and the load has a 20 s timeout and a token so
a slow `open` cannot overwrite a newer one.

*`src/store/player.ts`*

---

## Identity

### A path locates a book; it does not identify one

A book's id used to be a hash of its folder path, so renaming the folder made
a stranger of a book someone was halfway through — taking their place, their
library-card history and everything they wrote in the margins with it.

Identity is now a uuid, minted once. The old hash survives as `path_key`,
which is how a scan finds the row for a folder it has just walked. A folder
with no matching key is a new book; whether it is *really* a book that moved
is `planReconnection`.

*`src/lib/library/ids.ts`, `src/lib/library/identity.ts`*

### Shape finds candidates; only content reconnects

Size, duration, part count and the list of part sizes narrow a vanished book
to candidates. That is all they do. Two files of the same length are the same
length, and nothing more follows from it.

The app reconnects on its own only when **there is exactly one candidate and
its content sample matches**. One candidate that cannot be proved asks. Two
candidates ask even if one matches, because the usual cause is the same rip in
two folders and which one was meant is not something a hash can answer.

Durations are compared with two seconds of slack — a duration is whatever the
tags claimed, and tools round it differently — while byte counts are compared
exactly.

*`src/lib/library/identity.ts` (`planReconnection`)*

### The content sample is bounded on purpose

Four parts at most, 64 KB from each end. Every part would mean 19 MB of USB
reading for a 148-part book on every first index, to guard against a case the
part-size list already all but rules out. Which four is deterministic, so the
same book always samples the same way, and the part sizes are folded into the
hash so parts that were never read still count.

Paid once: an incremental scan skips unchanged folders, and `upsertBook` keeps
an existing hash when a scan did not take one.

*`src/lib/scan/sample.ts`, `src/lib/library/identity.ts`*

### A drive knows which library it is

Library identity is recovered from complete `.dueback/gen-N/` generations.
The old `library.json` is a fallback for libraries without generations, never
required to recover a valid backup. A malformed latest generation falls back
to a complete older one; conflicting identities or no readable generations
stop identity assignment rather than minting replacement book ids.

A new root gets a new library id, with a per-root local mapping for read-only
providers. Path indexes, incremental fingerprints, claimed import folders and
outgoing backups are scoped to that library. The UUID migration binds older
unassigned rows to their configured root once.

*`src/lib/sync/libraryIdentity.ts`, `src/lib/sync/driveSync.ts`, `src/db/identity.ts`*


### Reconnecting carries local paths by index, not by path

The whole reason a reconnection is happening is that the paths changed. The
audio did not, and nor did its order — which is what the content sample
proved — so a checked-out book's local part paths move across by index.

*`src/db/identity.ts` (`reconnectBook`)*

## Drive backup

### Generations, because SAF cannot rename

A write is usually made atomic by writing a temporary file and renaming it
into place. SAF has no rename, so the guarantee has to come from somewhere
else — and it comes from never modifying anything already on the drive.

Generation N is a complete set in `.dueback/gen-N/`: a manifest plus one file
per record type, each carrying the library id, the generation number, a schema
version and a checksum of its own contents. A backup writes a **new** folder,
reads the whole of it back off the drive, and validates it. Only then is
anything older pruned.

The manifest is written **last**. Until it is there the generation cannot
validate, so a folder whose data files are still arriving is indistinguishable
from one that never began — which is exactly what should happen to a write
interrupted by a pulled cable.

Nothing older is ever removed until there are two generations known to be
good. Pruning to a single copy would leave nothing to fall back to, which is
what generations exist to prevent.

*`src/lib/sync/generations.ts`, `src/lib/sync/driveSync.ts`*

### A position tick must never reach the drive on its own

Progress is written every five seconds for as long as a book plays. A backup
is a full read-merge-write-validate cycle in synchronous file calls, so one
per tick means the USB drive never stops working for the length of a book —
and the pruning keeps only two generations, so the folder looks tidy the
whole time. The only visible sign was the generation number climbing several
at a time between two looks.

`readingDataChanged` therefore takes a kind. Authored changes — a note, a
character, a book going out or coming back — go almost at once, with a short
debounce to collect a burst. Progress is capped at one backup per ten
minutes, because the phone already holds the position safely: the drive's
copy is insurance against losing the phone, not a live mirror, and any other
backup carries the latest position across anyway.

*`src/lib/sync/changes.ts`, `src/store/backup.ts`, `src/db/books.ts`*

### Read and merge first, then write

A phone that has been away writes what it learned **on top of** what it
brought, never instead of it. Plugging a drive in can only ever add to what is
on it.

What came back is applied even when the write then fails. The read happened
and the merge is correct; throwing away another phone's work because this
drive would not take our half helps nobody.

*`src/lib/sync/driveSync.ts`, `src/store/backup.ts`*

### Last write wins, with the tie broken the same way on both phones

`updatedAt` decides. When two devices write in the same millisecond the clock
has nothing more to say, so the tie goes to the higher `writerDevice` and then
the higher `mutationId` — arbitrary, but arbitrary in a way both sides compute
identically, which is the whole requirement. Merging A into B gives the same
answer as merging B into A.

Progress is the **latest** position, not the furthest. Rewinding to hear
something again is a decision, and a sync that restored the furthest point
would undo it every time the drive was plugged in.

An undo is an ordinary write with a newer stamp, which is how it beats the
deletion it reverses.

*`src/lib/sync/records.ts`*

### A note edited on both sides keeps the loser

Last-write-wins is right for everything except a sentence someone wrote. When
both copies have moved on from the last state they agreed on — which is what
`base_updated_at` records — the losing text is kept as its own note, marked as
a conflicted copy, at the same position in the same book.

Its id is derived from the original note and the losing mutation, so syncing
the same pair of edits again finds the copy already there instead of making
another one every time the drive is plugged in.

Without a recorded agreement there is no conflict: a missing
`base_updated_at` means one side is simply behind, and treating that as a
conflict would litter the margins with copies.

*`src/lib/sync/records.ts` (`mergeNote`, `conflictedCopyId`)*

### The identity manifest is what makes a restore possible

A phone that has never seen a library mints a fresh uuid for every folder it
scans, so notes keyed to the old uuids would have nothing to belong to. The
backup therefore carries who the books are — uuid, path key, shape and sample
— and a scan seeds its identity index from the drive before minting anything.

The phone's own record wins where both have one: it has been scanning this
drive, and the manifest may predate a book moving.

*`src/lib/sync/records.ts`, `src/lib/scan/scanner.ts` (`seedIdentity`)*

### A newer schema makes the drive backup read-only

If any generation has a newer schema, syncing may read an older compatible
copy but must not create or prune generations. Advancing the generation number
alone is not protection: it would put the newer schema below the pruning
threshold and delete it. Agreement is recorded only after a complete successful
write, and only for the exact mutation that was written.

*`src/lib/sync/driveSync.ts`, `src/store/backup.ts`, `src/db/sync.ts`*


### Only authored data is backed up

Titles, durations, covers and part lists are all rebuildable by rescanning the
drive the backup sits on, so carrying them would be carrying a worse copy of
something already there. What travels is what cannot be rebuilt: notes,
characters, tags, progress and library-card history — and the identity
manifest that lets them find their books again.

Records whose books this phone does not know are left on the drive rather than
written in. They arrive if the book ever does.

*`src/db/sync.ts`*

## The margins

### A bookmark is a note with nothing in it

There is no second type and no flag. A bookmark typed into becomes a note; a
note emptied back out becomes a bookmark. Anything else means a state machine
between the two, a migration when someone crosses the line, and two places to
fix every bug.

*`src/data/notes.ts` (`isBookmark`)*

### Save is what writes a note, and nothing else is

Tapping the pencil opens a draft and writes nothing. **Save** commits it: with
nothing typed as a bookmark, with something typed as a note. The backdrop, the
back button and the screen moving on all keep nothing.

This is the reverse of how it worked, and the reversal was asked for. Writing
the bookmark first meant every sheet opened by accident left one behind, and
the only way to change your mind was to go and find the thing and delete it.
The cost of the new way is the one the old way was avoiding: a tap, an
interruption, and the mark is gone.

Ten seconds are subtracted first, and the chapter is derived from where it
lands rather than where the tap happened — by the time someone reaches for the
button the thing worth marking has been said, and near a chapter boundary that
difference files the note under the wrong chapter.

*`src/app/player/[id].tsx`, `src/data/notes.ts`*

### The keyboard does not come up with the sheet

`autoFocus` is deliberately off. Most taps are "mark this spot", not "write an
essay", and half a screen of keyboard for a gesture that is already complete
is in the way. Tapping the field is what asks for it.

Dictation is the keyboard's own, so speaking a note needs no microphone
permission and the app asks for none.

Once editing starts, keyboard avoidance wraps the entire modal on Android as
well as iOS. The paper card has a bounded, scrollable writing area and a separate
suggestion row above the keyboard. An unbounded sheet with Android avoidance
disabled hides both the draft and @ suggestions. Creating a character replaces
the writing area temporarily; it does not stack another form below the draft.

*`src/components/NoteSheet.tsx`*

### The text is the only record of who a note is about

`note_characters` rows are rewritten from the typed text on every save, which
is what makes "delete the @mention and the tag goes" true without a second
gesture to learn. Names contain spaces, so a mention cannot be read as "@ up
to the next space": matching is against the names this book already knows,
longest first, so `@Logen Ninefingers` beats `@Logen` when both exist.

*`src/lib/notes/mentions.ts`*

### Autosave decides when, never whether

The debounce exists so a sentence is one write rather than one per keystroke.
Every exit flushes — closing the sheet, and the app going to the background —
and a write that fails puts its text back rather than dropping it. Losing what
someone wrote is the one outcome worth extra code to avoid.

The debounce lives in `createAutosave`, apart from the store, so it can be
tested without a database.

*`src/lib/notes/autosave.ts`, `src/store/notes.ts`*

### Soft deletes, because this is the only authored data

Every other table can be rebuilt by rescanning the drive. Notes and characters
cannot. They carry `deleted_at` so a later sync can tell a row that was removed
from a row that never existed — and so undo has something to restore.

Deleting a character tombstones its tags and never its notes: the note is what
someone wrote, the tag is only an index into it.

*`src/db/notes.ts`*

### The handwriting face is only for handwriting

`font.hand` (Caveat) is allowed in `NoteText` and the bio field, and nowhere
else. Names, times, tags and controls keep the app's own faces, because the
point of the handwriting is that it marks what the app did not write — which
stops being true the moment the app writes in it too. Caveat sits small for its
point size, so `NoteText` scales it up against the same nominal size.

Switchable in Settings, and the preference is a real one rather than a
decoration: handwriting is harder to read for some people.

*`src/components/NoteText.tsx`, `src/store/ui.ts`*

### The database is backed up; the audio is not

`plugins/withBackupExclusion.js` is an *exclude* list — `books/`, `books-tmp/`
and `covers/`, plus `imported/` from cloud backup only. Everything else under
the app's files directory is included, and expo-sqlite puts the database at
`filesDir/SQLite/dueback.db`, so notes and characters are already carried by
both cloud backup and device transfer. Nothing needed changing when the
margins were added, and no native rebuild was required for them.

*`plugins/withBackupExclusion.js`, `src/db/schema.ts`*

## Screens

### The Book screen is a stack of cards, and only paper goes on paper

The library card, the notes and the characters are three faces of one thing:
*your* record of a book, as distinct from the book. They share one stock
(`paperCardAlt`), one ink (`inkOnPaper`, with `stampOut` and `stampFaded` for
anything secondary) and one set of rules, and they sit in `CardStack` with
tabs cut from the same paper — the active tab is the same colour as the body
and overlaps it by a pixel, which is the whole trick that makes it read as a
stack rather than a toolbar above a panel.

The lamp accent must never appear on paper. `#e8a23a` on `#ece0c4` is about
2:1, which is unreadable as well as wrong: the accent belongs to the dark
chrome, and a chip or a link on a card is ink.

*`src/components/CardStack.tsx`, `src/components/NotesCard.tsx`,
`src/components/CharactersCard.tsx`*

### Only one card leans

`LibraryCard` is rotated 0.8°, which reads as a card pasted into a cover. A
stack cannot be: tilted tabs are harder to hit, and Android resamples rotated
text, so Caveat at 20° off square goes soft. Inside the stack the library card
is drawn `bare` — the stack's paper *is* the card — so there is never a card
on a card.

*`src/components/LibraryCard.tsx`, `src/components/CardStack.tsx`*

### Ruled lines only where the rows are a fixed height

The library card earns its rules because every row is exactly `ROW_HEIGHT` and
carries one date stamp. The note editor earns them because its `TextInput`
takes its `lineHeight` from `RULE_PITCH` — the two are the same constant on
purpose, not the same number by luck.

Nothing else is ruled. A note card holds one to six lines of Caveat at a size
the reader can change in Settings, plus chips and a row of actions; ruling
behind that will never line up, and ruling that nearly lines up looks worse
than none at all.

*`src/components/PaperCard.tsx` (`RULE_PITCH`), `src/components/LibraryCard.tsx`*

### Chapters are listed in one place

The Book screen used to have a Chapters tab that was the same list as the
player's Contents sheet, reached a different way. It was dropped: four tabs
across a phone leaves none of them room to be read, and the three that remain
are all the listener's own record of the book, which is one idea rather than
three plus an odd one out.

*`src/app/book/[id].tsx`, `src/components/ContentsSheet.tsx`*

### What the user calls these things

**Chapters · Notes · Characters** are the Book screen's three sections, and
those are the words everywhere a person can read them: on the tabs, in
accessibility labels, in the exported page. Never "Margins", never "Who's
who". "Margins" survives in one database helper, `countMarginsFor`, where it
reads as a collective — and nowhere a user can see.

*`src/components/NotesCard.tsx`, `src/components/CharactersCard.tsx`,
`src/lib/notes/export.ts`*


### Only one slip, mounted at the root

A navigation stack keeps the screens beneath the current one mounted, so a
slip rendered per screen draws once per mounted screen — two at a time on the
Book screen, one above the other. `GlobalSlip` exists for this and is route
aware: it reads the path to sit above the checked-out tray and the mini
player. No screen renders `Slip` itself.

*`src/components/GlobalSlip.tsx`*

### A finished book is still the loaded book

`open()` returns early when the engine already holds the book asked for, so
that leaving the Player and coming back does not reload it. The book that has
just finished is exactly that book, sitting on its last second, so "Listen
again" lands on the shortcut — and has to rewind rather than hand back the
end. The rewind decision is made before the early return, not after it.

*`src/store/player.ts`*

### A copy in flight cannot be interrupted mid-part

One part is one native `copy()` call and there is no way to abort it. Cancel
is therefore only noticed between parts: for a single-file m4b that means the
whole file. So `cancelCopy` answers the button itself — the book goes back on
the shelf and the slip appears at once — and the bytes are discarded when the
part finishes. The drive keeps reading until then.

A copy cancelled while still queued is dropped in `startCopy`, because
`runCopy` clears the cancelled flag on entry.

*`src/store/library.ts`, `src/lib/files/copy.ts`*

### One queue, and no button ever starts a copy

Every route to a copy goes through `drainQueue`: the check-out buttons as much
as the holds flushed when a drive is plugged in. Two separate reasons.

**Copies must not overlap.** Three off one USB stick are slower than three in
a row, and running them together lost books — several finish at once and write
their parts and their checked-out state to SQLite in the same moment.

**A tap must not touch the drive.** `proveDriveReachable` is a synchronous SAF
`list()` of the library root, and while a copy has the drive busy it answers
slowly — so a tap that started a copy froze the whole app until it returned.
Five taps froze it five times. The drive is proved once per copy, inside the
drain, where nothing is waiting on the answer. For the same reason `pollDrive`
does nothing while a copy is in flight: a copy in progress is better proof
than the poll could offer, and it reports a drive that goes away.

The book is put on hold *before* the drain is kicked, so a queued book appears
in the tray the instant it is asked for, whether the drive is there or not.
`nextQueued` re-reads the store rather than capturing a list, so a book added
while another copies is picked up without anything having to remember it.

A book cancelled while queued must be taken off hold as it is skipped, or
`nextQueued` hands it straight back and the drain spins.

*`src/store/library.ts`*

### Deleting a book's audio has to stop the player first

Returning a book deletes its files. Nothing told the player, so it carried on
playing from files that no longer existed. The library cannot import the
player — the player imports the library — so the player registers a callback
through `onBookAudioRemoved` when it loads, which the root layout guarantees
happens at startup.

*`src/store/library.ts`, `src/store/player.ts`*

### scrollToIndex on an empty list kills the app

`FlatList.scrollToIndex` throws `Invariant Violation: scrollToIndex out of
range: item length 0 but minimum is 1` when `data` is empty — and an invariant
violation in a release build is a fatal exception, not a red screen. Clamping
the index is not enough, because index 0 is still out of range for an empty
list; the call has to be skipped entirely.

This reached a user through the contents sheet, which lists `book.chapters`
directly. A book whose tags carry no chapters is perfectly ordinary — the
Player stands in a single chapter for one, via `chapterAt` — so opening
Contents on a plain rip took the whole app down.

*`src/components/ContentsSheet.tsx`*


### zustand v5 selectors must return stable values

It is backed by `useSyncExternalStore`, which re-renders forever if a selector
builds a new array or object on every call. Anything needing a filtered list
takes `books` and derives it with `useMemo` in the component.

*`src/store/library.ts`*

### The shelves are virtualised, with two deliberate settings

No `getItemLayout`: shelf height varies with the label card's wrapping, and a
layout function that guesses wrong is worse than letting the list measure.
`removeClippedSubviews` stays **off**: status tags sit at `top: -9` and ribbons
at `bottom: -16`, outside their row's bounds, and clipping eats them.

*`src/app/index.tsx`*

### Saving a position does not rebuild the shelves

The Library derives everything from the `books` array, so replacing it every
five seconds while playing rebuilt the whole library's shelves. The database is
written every time; the in-memory copy is committed only on pause, stop, finish
or backgrounding. The Player reads its position from the engine, and the Book
screen prefers that too while a book is playing.

*`src/store/library.ts` (`recordProgress`), `src/store/player.ts`*

### Cover URIs carry a signature of the artwork

Android's image pipeline caches by URI without consulting the file's timestamp,
so a cover stored at a fixed path went on rendering the old bitmap for the rest
of the session even after it was corrected. Thumbnails are named
`<bookId>.<token>.jpg`; the same artwork keeps the same name, so a rescan does
not churn the file or the row. A `?v=` query on a `file://` URI is **not** a
reliable alternative — the platform image loaders do not carry it through.

*`src/lib/files/covers.ts`*

### Refs may not be read during render

`useRef(new Animated.Value(0)).current` is a lint error under
`react-hooks/refs`. Use `useState(() => new Animated.Value(0))`, as `Slip` does.

### There is no multi-select, deliberately

It sent every chosen book straight to a copy — five simultaneous reads off one
USB stick, each book's budget check blind to the others, bypassing the queue
`flushHolds` uses. A long-press per book is quick enough and goes through the
one careful path.

---

## Build and dependencies

### A local native module is not linked until you say where it lives

`modules/` is not scanned by default. Without
`expo.autolinking.nativeModulesDir` in `package.json`, autolinking never looks
there — and nothing fails: the Gradle build succeeds, no warning appears, and
the only symptom is `requireOptionalNativeModule` returning null at runtime
with every control reporting "not supported on this device".

Check it with `npx expo-modules-autolinking search --platform android` and
look for the module by name, or watch for `:dueback-audio:` tasks in the
Gradle log. A merged permission is not proof — `MODIFY_AUDIO_SETTINGS` comes
from expo-audio as well.

*`package.json`, `modules/dueback-audio/`*


### Do not run `expo install --fix` on this project

`expo-doctor` reports a missing `expo-asset` peer and four patch bumps.

**Observed:** running `npx expo install expo-asset` then `npx expo install
--fix` left npm placing `expo-modules-core` under
`node_modules/expo/node_modules/` instead of hoisting it, and `npm run
typecheck` then failed with `Property 'addListener' does not exist on type
'AudioPlayer'` — `expo-audio` resolves `SharedObject` from that package, and
from `node_modules/expo-audio/` it is no longer reachable. A clean install and
`npm dedupe` both reproduced the layout; only `expo` requires it, at one
version, so it is not a version conflict.

**Inferred:** that the bundler would fail too. `expo-audio` imports the package
at runtime, not only for types, and Node resolution never looks inside another
package's `node_modules` — but Metro was not run against the broken tree.

**Scope:** that was the layout npm produced for that dependency set at that npm
version, not a general fact about `expo@57.0.28`. Recover with `npm ci`, and
afterwards confirm `node_modules/expo-modules-core` exists at the **top
level** — check it rather than assuming either way.

The `expo-asset` warning is harmless here: it is only needed for `require()`d
audio assets, and every source this app plays is a `file://` or `content://`
URI. Never leave it in `app.json`'s plugins without the package, though — an
`expo install` once added it there, and the plugin resolved only because the
package happens to be hoisted as a transitive dependency of `expo`.

### Always pass `-PreactNativeArchitectures`

The default builds all four CPU architectures, compiling native modules from
source four times: 22 minutes and a 282 MB APK versus a few minutes and a much
smaller one. Phones are `arm64-v8a`; the emulator is `x86_64`.

### Native changes need a rebuild

`app.json`, `plugins/` and local native modules only take effect at build time.
The Sound build includes `recordAudioAndroid: false`, which drops the
`RECORD_AUDIO` permission `expo-audio` adds by default.

### Sound follows the native audio session, not the player screen

expo-audio's Android player is a `SharedRef<ExoPlayer>`. The local Sound module
uses that reference on the main queue and listens to `onAudioSessionIdChanged`:
a session can become available after initial attachment or change independently
of a JavaScript part switch. Effects are released and recreated for that session;
JavaScript recomputes levels from its actual bands. Native calls return promises.

Settings load through the playback store, not a screen effect. Database writes
are ordered, and delayed reads cannot replace newer edits. A noisy-audio broadcast
pauses natively even if JavaScript is suspended; the event also clears the engine's
playback intent. Device effects still require physical listening tests.

*`modules/dueback-audio`, `src/store/sound.ts`, `tests/sound-integration.test.ts`*

### Checked-out audio is excluded from backup

`books/`, `books-tmp/` and `covers/` are excluded from both cloud backup and
device transfer — they are copies of files that are still on the drive.
`imported/` is excluded from cloud backup only (its ~25 MB quota fits no
audiobook) but **kept** for device transfer, where it may be the only copy.

*`plugins/withBackupExclusion.js`*

### Migrations commit their schema version with their data

Each migration owns one transaction during database bootstrap. DDL, rewritten
book references and `user_version` commit together, so an interruption can be
retried without duplicate-column errors or half-rewritten identities. The last
player book setting is also an identity reference.

Audio paths stay where they are when ids change. Startup's orphan sweep derives
ownership from recorded part paths, and Return uses the recorded local folder;
neither may infer ownership from the new book UUID.

*`src/db/migrations.ts`, `src/db/identityMigration.ts`, `src/store/library.ts`*

### Restoring identity includes books not found at their old paths

A fresh install seeds missing book rows from the generation's identity records,
including shape and content sample, before scanning. That lets the normal
reconnection path recognise a renamed folder and restore writing to its original
UUID. A path-only map cannot do this because its old path is precisely what
has disappeared.

*`src/db/identity.ts`, `src/lib/scan/scanner.ts`*

### Save completion must not replace newer typing

An autosave completing only updates the visible note if its text still matches
the submitted draft. Reloading notes also preserves drafts changed while the
query was running. A serial writer alone protects disk order, not the input
field shown to a person who is still typing.

*`src/store/notes.ts`, `tests/audit-regressions.test.ts`*

### Backup pending is updated by authored writes

Notes, characters, progress and checkout history notify backup after a database
write. Draft typing marks pending too. Writes while connected schedule a debounced
backup; Return's history write uses the same path without waiting on the drive.
A backup's timestamp is bounded by its start, so changes made during the write
stay pending. Applying a collected snapshot must not overwrite a newer local
mutation. An explicit zero playback position is still progress and is exported.

*`src/lib/sync/changes.ts`, `src/store/backup.ts`, `src/db/sync.ts`*

### Different remembered agreements must not discard a conflicting draft

For legacy timestamp-based agreements, conflict detection uses the earlier of
the remembered bases on either side, symmetrically. This conservatively preserves
text when the devices disagree about their common revision. Failed drive writes
never advance that base. Conflict copies keep their deterministic ids.

*`src/lib/sync/records.ts`, `tests/audit-regressions.test.ts`*

## Testing against an Audiobookshelf server

### Git Bash path conversion is wanted everywhere except container paths

Git Bash rewrites Unix-looking arguments *and environment values* into Windows
paths on the way into a native binary. That is what makes `curl -o /dev/null`
work at all — it becomes `NUL` — and what lets ffmpeg open a `/c/Users/...`
path. Setting `MSYS_NO_PATHCONV=1` globally breaks both.

The exception is a path that belongs to a container rather than the host.
Telling Audiobookshelf to scan `/audiobooks` sends it
`/app/C:/Program Files/Git/audiobooks`; the scan then succeeds and finds
nothing, which reads exactly like a broken bind mount. Scope
`MSYS_NO_PATHCONV=1` to that one call.

Renaming the variable does not help — the conversion is on the value, not the
name. Nor does the mount need checking: `docker exec … ls /audiobooks` is
converted the same way, so it reports on a path that was never there.

*`tools/abs-test/lib.sh`, `tools/abs-test/seed.sh`*

### Audiobookshelf owns `progress`; a client owns `currentTime`

`PATCH /api/me/progress/:itemId` stores `currentTime` and `isFinished` and
ignores `progress` — sending it, sending it alone, or sending none of it all
leave the stored value where the last playback session put it. Only
`POST /api/session/:id/sync` and `/close` move it. A client that treats
`progress` as its own field reads back a number it did not write.

The server also decides `isFinished` for itself when little enough of a book
is left, setting `finishedAt` with it. Fixtures therefore have to be minutes
long: on a twenty-second book that rule covers most of the book, and a
progress check at the halfway mark fails for reasons that have nothing to do
with the client.

Verified against 2.37.1. `/api/status` does not exist on that version; the
public one is `/status`.

*`tools/abs-test/verify.sh`, `tools/abs-test/sample-item.json`*

### Covers come back as WebP, and a missing one is a 404

`GET /api/items/:id/cover?width=400` re-encodes, so the bytes are WebP
whatever the file on the server was. A plain cover compresses to a few
hundred bytes — rejecting a small response as "too small to be real" throws
away good artwork. A book the server has no cover for answers **404**, which
is the only signal needed.

The request carries the Authorization header like every other, and the bytes
go straight into the local cover cache. Audiobookshelf also accepts
`?token=`, and the app never uses it: a URL with a token in it ends up in
logs, in crash reports and in the image cache key, and `<Image source={{uri}}>`
cannot send a header anyway — so the only way to stay header-only is to fetch
the bytes and point the UI at a local file.

*`src/lib/abs/catalogue.ts`, `src/lib/files/covers.ts`*

### A minified list item has only the flattened metadata

`GET /api/libraries/:id/items?minified=1` carries `authorName`,
`narratorName` and `seriesName` — the last already formatted as
"Keepers #1". The structured `authors[]`, `narrators[]` and
`series[{name,sequence}]` appear only on an expanded item. `narrators[]` is
an array of plain strings where `authors[]` is an array of objects.

So the mapper reads both shapes through one set of functions, structured
first, and rebuilds the flattened series string from name and sequence — or
the catalogue and the book screen would disagree about the same book.

A multi-file book gets real chapters from the server, one per file, titled
from the ID3 tags rather than the file names. A single file with no chapter
marks gets none, and the app does not invent one spanning the whole book.

*`src/lib/abs/map.ts`, `tools/abs-test/sample-item-multi.json`*

### Check a book out file by file, never through the item's ZIP

`GET /api/items/:id/download` exists and answers 200 with
`application/zip` — the whole item, in one archive. It cannot be resumed,
cannot be played until it is complete, and would have to be unpacked. The
per-file route is `GET /api/items/:id/file/:ino/download`, and it honours
`Range` with a 206, which is what makes a transfer resumable.

**An ino is volatile.** It is the server's inode number and changes when a
file is rewritten or the library is rescanned, so one must never be stored
and reused — re-fetch the expanded item at checkout time. A stale ino
answers 404. Because it is not certain that `DownloadTask` rejects on a
non-2xx rather than writing the error body to the file, a downloaded file
whose size does not match the one the server reported is treated as a stale
ino: re-read the item, try once, then fail plainly.

`permissions.download` on the signed-in user says whether any of this is
allowed. With it off the server answers **403** on the file route, so the
gate is checked up front from the authorize payload rather than discovered
after a transfer starts.

*`src/lib/abs/download.ts`, `src/lib/abs/checkout.ts`*

### One channel per book for reporting a position

A downloaded book reports only through `PATCH /api/me/progress/:itemId`.
No playback session is opened for a local file and no session is uploaded
afterwards. Streaming, when it arrives, is the opposite rule: it reports
through its session and never through the PATCH. Two channels for one
position is how a position gets written twice and read back wrong.

Before sending, re-read the server's record and compare `lastUpdate` with
the local `progress_updated_at`. The re-read is not redundant: between the
last comparison and now the same account may have listened elsewhere, and a
blind PATCH overwrites a newer position with an older one — the one failure
here that loses something waiting cannot recover.

*`src/lib/abs/sync.ts`, `src/store/absProgress.ts`*

### A streaming session needs a stable device id, and dies easily

Sessions dedupe per (user, device). Without a stable `deviceInfo.deviceId`
every `/play` invents a new device on the server and leaves a session
nobody will ever close. One UUID per install, in SecureStore beside the
tokens — not in SQLite, because the database is copied to the drive and two
phones restoring one backup would claim to be the same device.

**A new `/play` from the same device closes the previous session**, even
for a different book. Verified against 2.37.1: the old session's next sync
answers 404.

Sessions live in the server's memory. A restart, a close, or that newer
`/play` ends one, so a **404 from sync is routine** and means "open
another", not "something is wrong". Verified by restarting the container
mid-session: reopening and syncing the current position recovers it
exactly. Never cache a `contentUrl` across app restarts.

`timeListened` is a **delta in seconds since the last successful sync**,
not a running total — the server sums it across every session row it has
ever held. So the counter resets on a 200 and on nothing else: a failed
sync carries its seconds into the next one, and seconds listened under a
session the server has forgotten are dropped rather than attributed to its
replacement. `close` takes the same body inline, so one final sync rides
the close and syncing first would report the tail twice.

With MP3s the server answers `playMethod: 0` — direct play, no transcode —
so the tracks are ordinary files that need the Authorization header. They
genuinely need it: an unauthenticated fetch of a track URL answers 401. The
HLS path (`playMethod: 2`) is the one address in the system with no
credential, because the session id in it is unguessable and dies with the
session.

Streaming does **not** need the download permission. An account with
`permissions.download` false opens a session and fetches its tracks (206)
quite happily — verified as `dueback-nodl`. Gating the Stream action on
that permission refuses somebody the server would have served.

*`src/lib/abs/session.ts`, `src/lib/abs/device.ts`, `src/store/player.ts`*

### `player.open` must not tear down a stream before its own shortcut

`open` returns early when it already holds the book asked for, so that
leaving the Player and coming back does not reload it. Anything that ends
a stream has to come **after** that check, not before: the Player screen
asks to open the book it can already see, so a teardown at the top of the
function killed the session a moment after Stream started it — leaving
audio playing with nothing reporting it, or falling through to local files
a streamed book does not have.

For the same reason the shortcut skips the progress reconcile. During a
stream the session's own sync has just written our position to the server,
so the server always reads as newer, and reconciling would pull the
listener back to wherever the last sync left them.

*`src/store/player.ts`*
