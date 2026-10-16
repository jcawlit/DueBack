# Due Back

An audiobook app for a library that lives on a USB drive. Most of the collection
stays on the drive; only a few books at a time sit on the phone, so phone storage
stays low and moving books back and forth is one tap.

## Vocabulary

The whole app speaks plain library language, and so does the code.

| Term | Meaning |
|---|---|
| **Library** | the main screen |
| **On the shelf** | a book that exists only on the USB drive |
| **Checked out** | a book copied onto the phone |
| **Check out** | copy a book from the drive to the phone |
| **Return** | delete the local copy, keeping progress and history |
| **On hold** | queued to copy as soon as the drive is connected |
| **The drawer** | the USB connection — plugged in means the drawer is open |
| **Library card** | a book's history of checkouts and returns |

## Interactions

On a cover in the Library:

- **Tap** opens the Book screen. It never starts a copy, so a stray tap cannot
  pull 1.5 GB onto the phone.
- **The corner tab** checks the book out (`+`), or returns it (`✓`). This is the
  visible, discoverable control.
- **Long-press** does the same thing as the tab, as a shortcut. It is never the
  only way to do anything.

There is deliberately no multi-select. Packing several books for a trip is a
long-press each, which is quick enough, and a selection confirmed in one go
started every copy at once — five simultaneous reads off one USB stick, each
one's budget check blind to the other four.

## Rules worth knowing

- **Checking out needs the drive.** When the drawer is shut, covers still render
  from cached thumbnails and the check-out button puts the book **on hold**
  instead of failing. Holds copy automatically the next time the drive connects.
- **Returning works any time**, because the original is still on the USB.
- **Except** when a book is no longer on the drive — moved, renamed or deleted
  since the last scan. The phone then holds the only copy, so the app asks
  before returning it.
- **The budget** (4 GB by default) is measured against everything committed:
  what is on the phone plus what is on hold. Going over produces the "WON'T FIT"
  slip with the exact shortfall, and nothing is copied.

## Running it

```sh
npm install
npx expo start          # then press a for Android, i for iOS
npm run typecheck       # app + tests
npm run lint
npm test                # automated tests (Node's built-in runner)
npm run kb saf          # search the knowledge base
```

**Do not run `npx expo install --fix`** on this project — it leaves the build
broken. `npm run kb expo install` explains why.

Expo SDK 57, React Native 0.86, TypeScript, Expo Router (routes in `src/app/`),
SQLite via `expo-sqlite`.

Agent rules: [AGENTS.md](AGENTS.md). Optional
[task prompt templates](docs/AGENT-WORKFLOW.md) keep individual jobs focused.

## Development build

Expo Go is no longer enough: the app uses native modules it does not bundle.
You need a **development build** — your own debug app that loads JS from Metro.

Build it in the cloud (no local Android toolchain needed):

```sh
npx eas-cli login              # once
npx eas-cli build --profile development --platform android
```

That prints a QR code; scan it on the phone to install. Then `npx expo start`
and open the installed **Due Back** app rather than Expo Go.

Or build locally, which needs **JDK 17** and the Android SDK:

```sh
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=$LOCALAPPDATA/Android/Sdk
npx expo prebuild --platform android      # regenerate android/
cd android
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
# app/build/outputs/apk/debug/app-debug.apk
```

**Always pass `-PreactNativeArchitectures`.** The default builds all four CPU
architectures, compiling the native modules from source four times over: 22
minutes and a 282 MB APK, versus a few minutes and a much smaller one. Modern
phones — any recent Pixel — are `arm64-v8a`. Use `x86_64` for an emulator.

A release build — the kind that goes on the phone for real testing — is
`:app:assembleRelease` instead, and then:

```sh
npm run apk:publish
```

That copies it to `dueback.apk` at the repository root, and to the file
server as both `dueback-<sha>.apk` and `dueback.apk`. The sha-stamped name
is what makes "was this broken before that change?" answerable later; the
plain one is always the newest, so the phone's bookmark never moves. Set
`APK_SHARE` to point somewhere else, and the share is skipped rather than
failed when it cannot be reached.

Installing it on a phone over USB:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
npx expo start          # phone and computer on the same Wi-Fi
```

Then open **Due Back** on the phone; it connects to Metro over the network. A
debug build loads its JS from the dev server, so Metro needs to stay running.

`android/` is generated and git-ignored — never edit it by hand. Native
configuration lives in `app.json` and `plugins/`, and a change to either needs a
fresh build. Everything else is JS and reloads over Metro.

## Layout

```
src/
  app/                routes (Expo Router)
    _layout.tsx       fonts, splash, hydration, foreground drive checks
    index.tsx         Library
    book/[id].tsx     Book — the library card
    player/[id].tsx   Player
    settings.tsx      drawer status, rescan, change folder
    dev/metadata.tsx  scan report (timings, warnings, copy-to-clipboard)
  components/         covers, shelves, the tray, the ruler, slips
  db/                 schema.ts (the single source of truth), books.ts
  lib/
    files/            access.ts — the ONLY platform-specific file code
    metadata/         mp4.ts, mp3.ts, reader.ts — the byte-range parsers
    library/          grouping, name cleanup, ids, palette
    scan/scanner.ts   walk → group → read → write
  store/              library.ts, player.ts, scan.ts
  theme/tokens.ts     every colour, typeface and shadow
tests/                Node unit tests + synthetic fixtures
scripts/              fixture builders, the scan report, the kb search
docs/                 STATE.md (where it is), KNOWLEDGE.md (what we learned)
audiobooks/           real books for testing — git-ignored, never committed
design/               the four original mockups, visual reference only
```

## How scanning works

A scan **never copies audio**. It walks the library root, groups files into
books, reads each book's metadata through byte-range reads, caches a downscaled
cover thumbnail, and writes everything to SQLite. The shelves then work with the
drive unplugged.

- **Grouping**: one folder of audio = one book. Filename-based splitting is a
  fallback for a folder that clearly holds several works.
- **Part order**: natural filename order ("Part 2" before "Part 10"), unless
  every file has a distinct track tag — then tags win, and a disagreement is
  recorded as a warning on the book.
- **Names**: embedded metadata first. The folder name is used when metadata is
  missing, or when it is a tighter version of the embedded title (which turns an
  album tag of `15 - Hyperion - Dan Simmons - 1989` into `Hyperion`). Junk like
  `[Unabridged]`, `(2019)`, `64kbps`, underscores and leading series numbers is
  stripped. The dev screen shows the raw folder name beside the result.
- **Chapters**: best effort. Embedded when they parse; otherwise one chapter per
  file for a multi-part book; otherwise none.
- **Identity**: a book's id is a hash of its path relative to the root, so a
  rescan updates rows instead of duplicating them.
- **Incremental**: a book whose files all have the same size and mtime is
  skipped. Books that vanish are flagged missing, never deleted — their progress
  and library-card history survive a drive being unplugged. Settings offers
  "Forget N missing books" when you really do want them gone.
- **Formats**: `.m4b`, `.m4a`, `.mp3`. Other audio is counted and skipped;
  ebooks and other files are ignored silently. DRM files are marked unplayable.
- **Cost**: a 1 GB `.m4b` is **164 KB in 3 reads**. File size barely matters;
  only the number of seeks does.

The awkward parts — SAF document ids, what changing the root does to book
identity, how incremental fingerprints are keyed — are in the knowledge base:
`npm run kb scanning`.

## What is real, and what is not

Everything the app promises is implemented and has been run against a real
library on a real phone, off a USB drive over OTG.

- All four screens, matching `design/`.
- Folder picking, scanning, grouping, metadata, covers, SQLite, incremental
  rescan, missing-book handling, settings.
- **The copy is real.** It streams part by part into a staging folder, verifies
  each one's size, and only then moves the folder into place, so a half-copied
  book is never visible as a book. A cancel, a pulled drive or a failed read
  discards everything. A copy killed with the app survives as staged files and
  is resumed, part by verified part, the next time the book is checked out.
  Copies continue while the app is in the background.
- **Audio is real**, through `expo-audio` behind the `AudioEngine` interface in
  [src/lib/audio/engine.ts](src/lib/audio/engine.ts). One player for the whole
  book, whether that is one `.m4b` or a hundred and twenty-seven `.mp3` files:
  parts are a detail the engine hides, and everything above it is expressed in
  whole-book seconds. Background playback and lock-screen controls come from a
  media-playback foreground service. The next part is preloaded as the current
  one ends, so the seam is as short as the platform allows.
- Check out / return / hold, the budget and its refusals, the warning before
  returning a book that has left the drive, the drawer-shut state.
- Chapter scrubbing, ±30 s, speed, the sleep lamp, contents, saved progress.
- **Search**, forgiving about accents and word order, matching on word prefixes
  across title, author and narrator.
- **Duplicates.** Two copies of the same book are indexed separately, because
  they are different files in different places — but the Book screen says where
  the other one lives, so nobody checks out 1.5 GB twice by accident.
- **The DRM stamp.** An Audible or FairPlay file is listed, stamped on its
  cover and refused at check-out, with a note explaining why rather than a
  failure later.
- **Phone-local libraries.** Point the app at a folder on the phone itself and
  there is nothing to plug in and nothing to check out: no corner tabs, no
  select, "Play" instead of "Check out", and no book is ever stored twice.
- **Adding a book from the phone**, by folder or single file, with an offer to
  copy it onto the drive once that is connected — after which the scan
  recognises the folder as that same book rather than indexing it again.

Known gaps:

1. **iOS access across restarts** — `expo-file-system` calls
   `startAccessingSecurityScopedResource()` but never persists a bookmark, so a
   picked folder is lost on relaunch. Android persists its permission and is
   unaffected. Either re-pick each launch or add a small native module.
2. **No next/previous chapter on the lock screen.** `expo-audio` does not
   expose it, and the seek interval is hardcoded at 10 s, so ±30 s is not
   configurable there either. Both need a patch to the module's Kotlin.
3. The running list of smaller things lives at the end of
   [CHANGES.md](CHANGES.md).

## Where to look

| | |
|---|---|
| `docs/STATE.md` | where the project actually is: what is verified, what has never run on hardware, and what is deliberately not fixed |
| `docs/KNOWLEDGE.md` | platform quirks, invariants, and why odd-looking code is that way. Searchable with `npm run kb`. |
| `CHANGES.md` | what changed in each pass, and what is still open |
| `design/` | the four original mockups |
