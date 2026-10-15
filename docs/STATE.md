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
| An APK | `README.md` → Development build |
| `node_modules/` | `npm ci` — **never** `npm install`, and never `expo install --fix` |

## What is actually verified, and by what

This matters more than anything else in this file. There are two tiers of
test, and they cover very different ground.

**1. Node unit tests — `npm test`, ~300 cases, run in CI.**
Pure logic only: grouping, identity, merge rules, the sound maths, note
arithmetic, export, autosave, and the database migrations against `node:sqlite`.
Fast, trustworthy, and the right place for anything that can live there.

**2. A Pixel with a real USB drive and a real library.** Everything the unit
tests cannot reach: the Storage Access Framework, audio hardware, Android
power management, and whether any of it behaves on hundreds of real books
with names no generator would invent. Done by hand, and recorded below.

There used to be a third tier — scripted suites A1–A14, run from a Settings
button against a generated fixture library. They were removed on 15 October
2026. The library they tested was synthetic, the real one was by then good
enough to test against directly, and the button sat one tap away in a release
build while doing destructive things to app storage. `git log` has them if
they are ever wanted back.

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

### Still never verified on real hardware

Treat these as open questions, not as working features:

- **The backup-frequency fix (`b0ffc11`) is in no APK.** The build on the phone
  still writes a generation every few seconds of playback. Correct, just
  wasteful; a rebuild is what proves the fix.
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

## Known, and deliberately not fixed

Do not report these as findings. Report them as findings only with new
evidence that the reasoning was wrong.

- **No next/previous chapter on the lock screen, and no configurable skip
  interval.** `expo-audio` removes `COMMAND_SEEK_TO_NEXT` and
  `COMMAND_SEEK_TO_PREVIOUS` in `AudioMediaSessionCallback.onConnect`, and
  hardcodes a 10 s interval. Fixing it means forking the module's Kotlin and
  carrying that fork across every SDK upgrade.
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

1. **The backup-frequency fix needs a build to reach the phone.** `b0ffc11` is
   committed and unit-tested but not in any APK. What proves it is watching the
   generation number advance about once per ten minutes of listening instead of
   every few seconds.
2. **Four Expo patch bumps and a missing `expo-asset` peer.** `expo-doctor`
   reports 19/21 for these two reasons. Deliberately deferred to a branch,
   because the one time the advice was taken it broke the dependency tree.
3. **Conflicted copies need a prior sync to fire.** The first-ever merge
   between two phones is last-write-wins, so one side's edit to a note can be
   lost. Deliberate — the alternative litters the margins with copies — but it
   is the weakest point in the sync design, and the one part of sync no
   hardware has exercised.
4. **Reconnect questions are transient.** Held in the store, not a table. An
   unanswered question is re-asked on the next scan, which is self-healing but
   does not survive a force-stop.

## Traps

Things that have already cost a day each.

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
