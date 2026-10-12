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
- **Select** in the header starts multi-select, for packing before a trip:
  choose several covers, then confirm with "Check out 5 books · 3.2 GB". The bar
  keeps a running total and refuses a selection that will not fit, up front.

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
npm test                # parser unit tests (Node's built-in runner)
```

Expo SDK 57, React Native 0.86, TypeScript, Expo Router (routes in `src/app/`),
SQLite via `expo-sqlite`.

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
- **Names on a USB volume**: SAF reports an entry's name as its document id,
  `BC72-B058:Some Folder`. `safDisplayName` strips that prefix. Note that book
  ids hash the path relative to the root, so changing the root — or anything
  that changes those paths — re-indexes every book and leaves the old rows
  flagged missing.
- **Formats**: `.m4b`, `.m4a`, `.mp3`. Other audio is counted and skipped;
  ebooks and other files are ignored silently. DRM files are marked unplayable.

### What it costs

Measured on a 1 GB m4b: **164 KB read, 3 reads**. File size barely matters —
only the number of seeks does. Reads are cached in 16 KB blocks
(`DEFAULT_BLOCK_SIZE` in `src/lib/metadata/reader.ts`); the dev screen reports
the block size so it can be retuned against real USB latency.

## What is real, and what is not

Built and behaving correctly:

- All four screens, matching `design/`.
- Folder picking, scanning, grouping, metadata, covers, SQLite, incremental
  rescan, missing-book handling, settings.
- Check out / return / hold, the budget and its refusals, the warning before
  returning a book that has left the drive, select mode, the drawer-shut state.
- Chapter scrubbing, ±30 s, speed, sleep timer, bookmarks, contents, saved
  progress.

Still stubbed:

1. **The copy** — `startCopy` in [src/store/library.ts](src/store/library.ts)
   fakes progress on a timer. The real one streams, verifies size, and survives
   backgrounding and the drive being pulled mid-copy.
2. **Audio** — `tick` in [src/store/player.ts](src/store/player.ts) advances a
   counter. `react-native-track-player` replaces it, and needs a development
   build rather than Expo Go.
3. **iOS access across restarts** — `expo-file-system` calls
   `startAccessingSecurityScopedResource()` but never persists a bookmark, so a
   picked folder is lost on relaunch. Android persists its permission and is
   unaffected. Either re-pick each launch or add a small native module.

## Running the emulator suite

An API 34 x86_64 AVD called `dueback34` is set up for this. Two things differ
from the phone and are worth knowing before you trust a result.

The system folder picker cannot be driven from a script, so the self-test takes
a plain filesystem path as its library root rather than a picked folder. That
means it exercises everything downstream of the root — scanning, copying,
importing, reconciliation — but not the SAF-specific code paths that only a real
USB drive goes through. SAF bugs still need the phone.

The emulator also cannot run the phone's APK: that one is `arm64-v8a` only.

```bash
SDK="$LOCALAPPDATA/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"

# 1. Boot it.
"$SDK/emulator/emulator.exe" -avd dueback34 -no-boot-anim &

# 2. Build and install an x86_64 debug APK.
#    JAVA_TOOL_OPTIONS is required: the bundled JBR is JDK 25, and
#    react-native-worklets' CMake task trips JDK 24+'s native-access
#    restriction without it. It must reach the forked JVMs, so passing it
#    through -Dorg.gradle.jvmargs is not enough.
cd android
JAVA_TOOL_OPTIONS="--enable-native-access=ALL-UNNAMED" \
  JAVA_HOME="/c/Program Files/Android/Android Studio1/jbr" \
  ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64
cd ..
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk

# 3. Put a test drive where the app can actually read it.
#    Not /sdcard/Android/data/<pkg>: adb writes there as shell:ext_data_rw and
#    the app's uid cannot traverse it. App-internal storage needs root, which
#    this google_apis image allows.
"$ADB" root
"$ADB" push testdrive /data/local/tmp/testdrive
"$ADB" shell "cp -r /data/local/tmp/testdrive /data/data/com.dueback.app/files/testdrive"
"$ADB" shell "chown -R u0_a183:u0_a183 /data/data/com.dueback.app/files/testdrive"

# 4. adb root restarts adbd and drops port forwards, so redo this after it.
"$ADB" reverse tcp:8081 tcp:8081

# 5. Point the dev client at Metro.
#    This intent is only honoured by an already-running process. Sent to a
#    cold app it opens MainActivity, fails to connect and leaves a blank white
#    screen with nothing in logcat, so start the app first and send it second.
"$ADB" shell "am start -n com.dueback.app/.MainActivity"
"$ADB" shell "am start -a android.intent.action.VIEW \
  -d 'dueback://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'"
# Wait for the bundle before doing anything else:
#   until "$ADB" logcat -d -s ReactNativeJS:V | grep -q 'Running "main"'; do sleep 4; done

# 6. Run the suite. The trailing slash on the root matters.
#    Change the nonce to re-run without navigating away first.
"$ADB" shell am start -a android.intent.action.VIEW \
  -d "'dueback://dev/selftest?root=/data/data/com.dueback.app/files/testdrive/&run=1&nonce=1'"
"$ADB" logcat -d -s ReactNativeJS:V | grep selftest
```

The suite is `src/app/dev/selftest.tsx`, also reachable by hand from
Settings → Developer → Self-test. Reset between runs by deleting `testdrive`, `books` and
`imported` under `/data/data/com.dueback.app/files/`.
