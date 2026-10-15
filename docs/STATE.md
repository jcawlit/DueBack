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
| `fixtures/`, `testlib/` | `npm run make:fixtures`, `npm run make:testlib` |
| `node_modules/` | `npm ci` — **never** `npm install`, and never `expo install --fix` |

## What is actually verified, and by what

This matters more than anything else in this file. The project has three tiers
of test and they cover very different ground.

**1. Node unit tests — `npm test`, ~300 cases, run in CI.**
Pure logic only: grouping, identity, merge rules, the sound maths, note
arithmetic, export, autosave, and the database migrations against `node:sqlite`.
Fast, trustworthy, and the right place for anything that can live there.

**2. On-device suites — `src/dev/suites.ts`, reached from Settings → Self-test.**
Real SQLite, real files. Suites A1–A14 cover scanning, check-out, holds,
imports, startup reconciliation, notes, identity and drive backup. They need a
generated fixture library on a filesystem path, so in practice they run on the
emulator (`docs/EMULATOR.md`). **Not in CI.** Known limitation: the suite is
not idempotent — two runs back to back are worse than one from a clean slate,
because checked-out books and imports survive. `wipeAppData()` exists in the
harness but is not run automatically.

**3. A Pixel with a real USB drive — `TESTING.md`.**
The only thing that can answer anything involving the Storage Access
Framework, audio hardware or Android power management.

### Never verified on real hardware

Treat these as open questions, not as working features:

- **Drive backup end to end** (`.dueback/` generations). Proven on a filesystem
  path by suite A14; no USB provider has ever been asked to create `.dueback`
  or its `gen-N` folders.
- **The Sound panel.** Built, typechecked and in an APK. Whether this Pixel's
  `LoudnessEnhancer` and `Equalizer` initialise at all, and with how many
  bands, is unknown — the panel reports it at runtime.
- **Headphone unplug pausing.** The receiver is registered; the broadcast has
  never been seen to arrive.
- **The incomplete-marker reclaim path.** A part-written push leaves a marked
  folder; scans skip it. A retry reclaiming that folder has never completed on
  a real drive.

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

1. **Nothing has been tested on the phone since the Sound panel landed.** The
   current APK contains three features — the card-stack UI, the Sound panel and
   the headphone handler — that have never been run on hardware.
2. **The device suite's lack of a reset step** makes every run after the first
   misleading. A `wipeAppData()` at the start would fix it.
3. **Four Expo patch bumps and a missing `expo-asset` peer.** `expo-doctor`
   reports 19/21 for these two reasons. Deliberately deferred to a branch,
   because the one time the advice was taken it broke the dependency tree.
4. **Conflicted copies need a prior sync to fire.** The first-ever merge
   between two phones is last-write-wins, so one side's edit to a note can be
   lost. Deliberate — the alternative litters the margins with copies — but it
   is the weakest point in the sync design.
5. **Reconnect questions are transient.** Held in the store, not a table. An
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

## Where everything else is

| For | Read |
|---|---|
| Standing rules for agents | `AGENTS.md` |
| Platform quirks and invariants | `npm run kb`, then `docs/KNOWLEDGE.md` |
| What changed and why, chronologically | `CHANGES.md` |
| Hardware checks a person must do | `TESTING.md` |
| Running the emulator suites | `docs/EMULATOR.md` |
| The sound feature, and iOS notes | `docs/SOUND.md` |
| Prompt shapes for delegated work | `docs/AGENT-WORKFLOW.md` |

`CHANGES.md` is 1,600 lines and chronological. Its older "Known, not fixed"
sections have been overtaken by later work — three of the six items listed
there are fixed. **This file is the current list; that one is history.**
