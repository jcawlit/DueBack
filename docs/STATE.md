# Where this project actually is

For anyone — person or agent — arriving with only the repository, and
especially for anyone auditing it or deciding what to do next.

Read this before filing findings. Most of what follows is here to stop good
time being spent rediscovering things that are already known, already decided,
or impossible to check from a clone.

## What it is

An offline audiobook player for Android. The library lives on a USB drive
reached over OTG; books are **checked out** (copied to the phone), **returned**
(copy deleted, progress kept), or put **on hold** (queued until the drive is
back). There is no account, no network and no streaming. The drive is the
library; the phone is a bag you carry some of it in.

Expo SDK 57, React Native 0.86, TypeScript, Expo Router, zustand, expo-sqlite,
expo-audio. One local native module, `modules/dueback-audio`, for audio
effects and the headphone-unplug broadcast.

## What a clone does not contain

All correctly ignored, none of it missing by accident:

| Absent | How to get it |
|---|---|
| `android/` | `npx expo prebuild --platform android --clean` |
| An APK | `docs/DEVELOPMENT.md` → Development build |
| `node_modules/` | `npm ci` — **never** `npm install`, and never `expo install --fix` |

## What is actually verified, and by what

This matters more than anything else in this file. There are two tiers of
test, and they cover very different ground.

**1. Node unit tests — `npm test`, 760 cases, run in CI.**
Two kinds, and the second is new.

*Pure logic*: grouping, identity, merge rules, the sound maths, note
arithmetic, export, autosave, and the database migrations against
`node:sqlite`.

*The drive itself, and a whole scan, against a fake native layer.*
`tests/fakeDrive.ts` stands in for `expo-file-system`, `expo-sqlite` (by real
SQLite through `node:sqlite`) and `expo-image-manipulator`, so the production
`listTree`, `copyBookToDevice`, `swapIntoPlace`, `recoverInterruptedSwaps`,
`collectAudio`, `copyImportToDrive` and **`scanLibrary` itself** all run here
— against the real committed audio fixtures, so the parser, naming, grouping,
identity and missing sweep are the real ones too — including the failure paths that used to
need a real cable to provoke: a folder that will not list, a subtree past the
depth limit, a book deleted from the drive since the last scan, a phone with
no room, a cancel between parts, a resume after a kill, and a push that dies
half-written. Only the native leaf is replaced; nothing here reimplements the
code it tests. `npm run kb -- "node --test"` for the fidelity rules and, more
importantly, for what it deliberately does **not** model.

**2. A Pixel with a real USB drive and a real library.** What tier 1 cannot
reach, which is now a shorter and sharper list: real SAF behaviour (renaming
a file you asked it to create, descriptors going stale, permission revoked
between launches), audio hardware, Android power management, speed, and
whether any of it behaves on hundreds of real books with names no generator
would invent. Done by hand, and recorded below.

There used to be a third tier — scripted suites A1–A14, run from a Settings
button against a generated fixture library. They were removed on 15 October
2026. The library they tested was synthetic, the real one was by then good
enough to test against directly, and the button sat one tap away in a release
build while doing destructive things to app storage. `git log` has them if
they are ever wanted back.

### Passed on a Pixel with a real drive, 18 November 2026

The build was the APK at commit `fa097a9`. Everything below had accumulated
across five commits without ever running on hardware, and all of it passed.

- **Editing a book's details.** A correction survives a rescan, follows the
  book onto the shelves and into search, and a picked cover is not swept away
  by the next scan. `expo-image-picker` is a new native module, so this also
  proves the development build.
- **Migration 18** (`book_overrides`) against a real library, on first launch.
- **The lock screen's minute jumps**, in both directions — after the second
  attempt. The first reached the phone and changed nothing; see the entry under
  "deliberately not fixed" and `npm run kb -- "builds from source"`.
- **The lag after saving is gone**, and so is the periodic stutter a second or
  two after writing anything. Two separate causes: a whole-library reload for a
  one-book edit, and the drive backup blocking the JS thread with synchronous
  file calls. `npm run kb -- "blocks the JS thread"`.
- **The drive light and long-press on the source pill**, with an Audiobookshelf
  server configured, and **"Check again"** in Settings now answering.
- **A multi-disc folder through "Add a book folder"**, arriving in order.

### Passed on a Pixel with a real drive, 15 October 2026

The build was the APK at commit `1b9a3c5`. Everything below had never run on
hardware before that session, and all of it passed.

- **The uuid migration, against a real library.** Three migrations run on first
  launch, the largest rewriting every book id. All books present afterwards,
  progress intact, playback unaffected.
- **The Sound panel.** Opened over a playing book, presets and sliders worked,
  nothing reported wrong.
- **Pausing when headphones come out.** Wired unplug and Bluetooth walked out
  of range both paused rather than switching to the speaker. This had never
  worked in any earlier build.
- **Drive backup end to end.** A USB provider created `.dueback/`, and the
  generation folders hold readable JSON. This was the single biggest unknown:
  nothing but a real SAF provider can answer whether that folder can be made.
- **Notes.** The pencil bookmark, typing surviving a dismissed sheet, the Notes
  tab and `@` to tag a character.
- **Reconnecting a renamed folder.** A book's folder renamed on a computer,
  then rescanned: reconnected silently, with progress and notes intact and no
  prompt. The content sample matched, which is the whole point of identity.
- **Restore after clearing app data.** Reinstalled state, same folder picked,
  and the notes came back from the drive. This is the promise the backup
  exists to keep, and it is now kept on real hardware.

One thing was found by looking rather than by the app failing: the generation
number climbed several between two looks at the same folder. That was a real
bug — see "A position tick must never reach the drive" below, fixed in
`b0ffc11`.

### Waiting on a phone, as of 19 November 2026

The APK at commit `4641b48`. Two commits of screen work that has never run on
hardware — all of it is layout, which no test on this machine can judge:

- **The checked-out fan scrolling sideways.** It cut the tenth cover in half
  before. Ten books out is the case to reproduce.
- **The tray's group labels**, with a server connected: "Drive" and the
  server's name in 10pt over their own stacks, a rule between them, and the
  summary reduced to `12.1 of 32 GB`. Whether two stacks in one fan read as
  crowded is the open question — the fix would be per-group scrolling, which
  was deliberately not done without seeing it.
- **The Library header holding one height** across a source switch. It moved
  the divider and the sort chips before, because `FitText` shrank the line
  height along with the font. The arithmetic is pinned by tests and
  mutation-checked; what is unverified is that the header now *looks* right a
  tenth shorter, and that a long server library name still reads as a title at
  16pt.
- **Long-press on the source pill from a server's library.** The gesture was
  there with no handler behind it, so this has never worked at all.

Added on the same day, in a later build (`f6bf87f`):

- **The lock screen's chapter buttons, which have now failed to appear once.**
  Two attempts: secondary slots, which Android never places at all, and now the
  overflow. The overflow is drawn where there is room and omitted where there
  is not, so **this may still show nothing** — what is certain is that the
  minute-seek buttons are untouched, which was the point of choosing it. Try
  the expanded notification in the shade as well as the lock screen itself.
- **A Bluetooth or car "next track" button.** This is the part that does not
  depend on a button being drawn: the press arrives as a real skip command
  either way. If the lock screen shows nothing, a headset's skip button is
  still worth one press — it may be the whole feature working with no visible
  button attached to it.
- **Android 12 and below** uses explicit notification actions instead, patched
  separately and never exercised by anything. The Pixel does not test it.
- **The docked player shutting down to its play button.** Long press used to
  close playback outright; it now shuts the bar, the button stays exactly where
  it was, and the shelves reclaim the strip. Stopping moved to a long press on
  the small tab beside the shut button — deliberately harder to hit by
  accident, and the thing most likely to be in the wrong place.
### Still never verified on real hardware

Treat these as open questions, not as working features:

- **The backup frequency during playback.** The fix (`b0ffc11`) has shipped —
  it is in every build since — but nobody has watched the generation number to
  confirm it advances about once per ten minutes of listening rather than every
  few seconds. One number, observed once, closes this.
- **What the Sound panel printed for this device.** It works, but the line
  naming the band count and level range was not written down, so whether this
  Pixel's `Equalizer` gave five bands or ten is still unknown. Worth capturing
  the next time the panel is opened.
- **Effects across a part boundary, and TalkBack on the sliders.**
  `docs/SOUND.md` lists both; neither was done.
- **Two phones syncing with each other.** There is one phone. Every merge rule
  is unit-tested and the restore path is proven, but no two real devices have
  ever met over the same drive, so conflicted copies have never been seen in
  the wild.
- **Reclaiming an incomplete push on the current build.** An interrupted
  phone-to-drive push leaves a marked folder, and scans skipping it plus the
  re-prompt were seen on hardware in an earlier session. A retry reclaiming
  that folder has not been repeated since the chunked-write change.

### Audiobookshelf, which is mid-build and on `feat/pro`

A testing stage, not a feature. The app can connect to a server, sign in,
pick one of its book libraries, read that library's catalogue onto the
shelves with its covers, open a book to its real chapters, and download it
(`src/lib/abs/checkout.ts`, `src/lib/abs/download.ts`). **Nothing in the
download path has run on a phone** — see below.

Verified only against the Docker server in `tools/abs-test`, from Node —
login, refresh, authorize, libraries, paginated items, expanded items,
covers, per-file downloads with Range, the progress PATCH and the download
permission gate all answer correctly on 2.37.1. None of it has run on a
phone, against a real server, or over a real network.

**The download itself is the biggest untested thing.** `DownloadTask` is
native and cannot run off-device, so what is proved is the protocol around
it — the URLs, the sizes, the 206, the 404 — and not pause, resume or
cancel, which have only ever been reasoned about.

- **A remote book is its `(source_id, remote_id)` pair.** The local id is a
  uuid minted on first sight and never changes, so progress, notes,
  characters and history attach to it exactly as they do for a book on the
  drive. A refresh diffs on the server's own `updatedAt` and marks a
  vanished book missing rather than deleting it, mirroring what a USB scan
  does.
- **Shelves and search show one source at a time; the tray does not.**
  The tray has been both. Global first, then scoped to the active source,
  and scoping turned out worse: a book downloaded from a server that was
  later removed belonged to no library you could switch to, so it appeared
  nowhere while still holding gigabytes. It is global again, in labelled
  groups — the drive, each server, then a "Signed out" group for anything
  whose source has gone. The ruler is global with it, and so finally agrees
  with the fan above it. Shelves stay scoped, because mixing two libraries
  into one set of generated shelves really does produce a "6 hours or less"
  shelf full of books that cannot be reached.
  `npm run kb -- "global again"`; `tests/tray-scope.test.ts` pins the rule.
- **`src/app/abs/[id]` is now a diagnostics screen, not the book's screen.**
  It holds what only a tester wants — the remote id, when the record was
  cached, what the last progress push did — and is reached by the "server
  details" link on the Book screen. See the "one screen per book" entry
  below, which is the rule; this is the leftover of the old one, kept
  deliberately.
- **The position comes from `currentTime`**, and the newer of the two
  writes wins. Taking the server's shows "Picked up where you left off on
  another device".
- **One screen per book, whichever library it came from.** A server book
  opens on the Book screen like any other. It had its own plain screen
  while it was an inert catalogue entry with no audio; once it could be
  downloaded it was a book, and two screens for one thing trapped the
  player and the book in a loop. `src/app/abs/[id]` survives as the server
  view behind it — remote id, cached-at, last progress push — reached from
  a link on the Chapters tab.
- **The position is settled in `player.open`**, not when a screen appears.
  Every route to playback passes through there; a screen does not.
- **A server book checks out like a drive book.** Per-file downloads into
  the same local layout, through the same queue, with the same budget
  rules and the same `recordCheckoutComplete` afterwards — so returning,
  reconciliation and the checked-out tray needed no changes. Playing it
  works offline. Its place is pushed back with a throttled PATCH, and only
  when ours is the newer one.
- **Checkout is disabled for an account without download permission**,
  read from the authorize payload rather than discovered when the server
  answers 403.
- **Pause and resume work on a download** and not on a drive copy, because
  an HTTP transfer can be interrupted and keeps what it has, where one
  native file copy cannot. On the phone, losing the network mid-download
  behaves like a cancel — the part-downloaded file is discarded — so
  resume-after-interruption is not yet doing anything useful.
- **A book can also be streamed**, offered under "Download and play" on
  the Book screen and across from the library card. It takes no storage and is not checked out. Its listening is
  reported through its session and never also through a progress PATCH;
  checking a book out while it streams closes the session with its final
  sync first, then carries on from the local copy at the same second.
- **The transcode path has never run.** With MP3s the test server answers
  direct play, so the HLS branch is reasoned about and not exercised. A
  book in a format the server will not pass through is the case that
  would reach it.

- **`android.usesCleartextTraffic` is on, for the whole app — deliberately,
  and no longer a release blocker.** An Audiobookshelf server on a LAN is
  reached over plain http and Android blocks that by default, so without the
  flag a connect attempt dies at the socket with nothing useful to show.
  This entry used to say the flag had to become "a network security config
  that permits cleartext only for private address ranges" before release.
  **That cannot be written:** a network security config's `<domain>` takes a
  hostname or an IP literal and has no subnet syntax, so the rule cannot be
  expressed in the manifest for an address typed in at runtime.
  It is enforced in the app instead, at the single chokepoint every server
  request passes through: `isCleartextToPublicHost` in
  `src/lib/abs/client.ts` refuses any plain-http request to an address
  outside the private ranges, loopback and the LAN naming conventions,
  before it is sent — so it covers a server saved before the check existed,
  not just the connect form. `tests/abs-client.test.ts` pins the address
  classification.
- **The connect form is in Settings under "Audiobookshelf (testing)".**
  Plain fields and square buttons on purpose. It is not meant to survive
  into Settings looking like that. "Check again" there is what re-reads the
  catalogue.
- **The source pill is unchanged until a server exists.** With no
  Audiobookshelf source configured the Library header shows exactly the
  drive button it always has. The switcher only appears once there is
  something to switch to, so the USB path is untouched for anyone who never
  opens this.
- **One server, by decision rather than by omission.** Shelves and search show
  one source at a time, the budget is global because it is about the phone,
  and a second server multiplies both questions for a case nobody here has.
  Signing in replaces what is there; removing is how you leave. The Settings
  panel no longer says "(TESTING)" either — downloads, progress both ways and
  the catalogue have all run against a real server on a real phone.
- **No Pro gating yet**, deliberately, while it is being tested.

Secrets: the access and refresh tokens live in SecureStore keyed by the
source's id, never in SQLite — the database is copied to the drive by the
backup, so a token in it would be a token on a USB stick. The password is
never stored at all. That is also why a failed token refresh marks the
source "Sign in again" and stops: there is nothing to retry with, and a
client that keeps trying against a server that keeps refusing is how an
account gets locked.

## Known, and deliberately not fixed

Do not report these as findings. Report them as findings only with new
evidence that the reasoning was wrong.

- **Next/previous chapter on the lock screen is built but unverified.** It
  was listed here as not fixed for months; `plugins/withLockScreenChapters.js`
  now does it, by forwarding the press to the app rather than teaching the
  session what a chapter is — which it cannot be taught, because the target
  chapter may be in a different file. `npm run kb -- "chapter button"`. No
  phone has pressed one.

  The **skip interval is no longer among these**, and neither are the dead
  buttons. `plugins/withLockScreenSeek.js` rewrites three of the module's
  Kotlin files at prebuild: the buttons were custom session commands answered
  with `RESULT_ERROR_NOT_SUPPORTED`, so they drew and did nothing. They are
  now `COMMAND_SEEK_BACK`/`COMMAND_SEEK_FORWARD` at 60 s.

  **The first attempt reached the phone and changed nothing**, because
  expo-audio ships a prebuilt AAR and Gradle never compiled the patched
  Kotlin. `buildFromSource: ["expo-audio"]` in `package.json` is what makes
  the source the thing that gets built, and the plugin now refuses to run
  without it. `npm run kb -- "builds from source"`. Confirmed in a build;
  **not yet confirmed on a phone.**
- **Cancelling a copy cannot interrupt the part in flight.** One part is one
  native `copy()` call with no abort. The button is answered immediately — the
  book returns to the shelf and the bytes are discarded — but the drive keeps
  reading until that file finishes. Making it truly immediate means a chunked
  loop, which is slower for every copy and reintroduces the stale-descriptor
  problem. See `npm run kb -- "cannot be interrupted"`.
- **No versioned snapshots of audio on the drive.** A push never overwrites
  anything valid, so there is no previous version to keep, and a snapshot would
  mean a second copy of a multi-gigabyte book.
- **Mono and Night sound modes.** Deferred, not forgotten.
- **iOS.** Nothing here has ever been built for it. `docs/SOUND.md` describes
  what the audio effects would need.
- **"Hyperion" is filed under the author "Top 100 scifi books".** The tags say
  so. A naming question, not a bug.

## Open, and worth someone's attention

Roughly in the order I would take them.

1. **Pro gating does not exist**, on the branch named for it. What is free and
   what is not is a decision, not an implementation.
2. **The reconnection fix has not run on hardware.** A scan may now ask a
   question where it used to reconnect silently — when one new folder could be
   either of two missing books. Covered by `tests/scan-end-to-end.test.ts`
   and mutation-checked, but what proves it is a real library where a folder
   was renamed still reconnecting without a prompt.
   `npm run kb -- "both directions"`.
3. **Four Expo patch bumps and a missing `expo-asset` peer.** `expo-doctor`
   reports 19/21 for these two reasons. Deliberately deferred to a branch,
   because the one time the advice was taken it broke the dependency tree.
4. **Conflicted copies need a prior sync to fire.** The first-ever merge
   between two phones is last-write-wins, so one side's edit to a note can be
   lost. Deliberate — the alternative litters the margins with copies — but it
   is the weakest point in the sync design, and the one part of sync no
   hardware has exercised.
5. **Reconnect questions are transient.** Held in the store, not a table. An
   unanswered question is re-asked on the next scan, which is self-healing but
   does not survive a force-stop.

## Traps

Things that have already cost a day each.

- **Clearing a book's `source_id` hands it to the drive.** `DRIVE_BOOKS` is
  `source_id IS NULL`, so "unhooking" a removed server's books turned them
  into drive books: on the drive's shelf, stamped "not on drive" by the next
  scan, and offered up by "Forget missing books" beside real ones. It reached
  a phone. `npm run kb -- "means on the drive"`.

- **`npx expo install --fix` breaks the build here.** It nests
  `expo-modules-core` and `expo-audio` stops resolving it. `npm run kb -- "expo
  install"`.
- **A local native module is not linked unless `package.json` says where it
  lives.** No error, no warning — just a module that does not exist at runtime.
  `npm run kb -- "autolinking"`.
- **`move()` and `copy()` return promises; `delete()`, `write()` and `list()`
  do not.** Mixing them silently reported a copy as finished while it was still
  in flight. `npm run kb -- "asynchronous"`.
- **SAF renames the file you ask it to create.** `.dueback-incomplete` arrives
  as `.dueback-incomplete.txt`, and Windows hides the extension, so it looks
  correct while matching nothing. `npm run kb -- "drive renames"`.
- **A handle held on a `content://` URI dies mid-copy.** The descriptor is not
  retained by expo-file-system. `npm run kb -- "file handle"`.
- **A position tick must never reach the drive.** Progress is written every
  five seconds while a book plays. Anything that treats that like an edit —
  a backup, a sync, a rewrite — runs for the whole length of a book, and the
  generation pruning keeps the folder looking tidy while it happens.
  `npm run kb -- "position tick"`.

## Where everything else is

| For | Read |
|---|---|
| Standing rules for agents | `AGENTS.md` |
| Platform quirks and invariants | `npm run kb`, then `docs/KNOWLEDGE.md` |
| What changed and why, chronologically | `CHANGES.md` |
| The sound feature, and iOS notes | `docs/SOUND.md` |
| Prompt shapes for delegated work | `docs/AGENT-WORKFLOW.md` |

`CHANGES.md` is 1,800 lines and chronological. Its older "Known, not fixed"
sections have been overtaken by later work — three of the six items listed
there are fixed. **This file is the current list; that one is history.**
