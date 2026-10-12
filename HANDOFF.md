# Audiobook Shelf: build handoff

A phone app for managing a large audiobook library that lives on a USB drive. The whole point: keep phone storage low by carrying only a few books at a time, and make moving books between USB and phone feel effortless.

The `design/` folder holds four mockup screens (`Main`, `Book`, `Player`, `Drawer`). They are written in a design-tool format (`.dc.html` with `<x-dc>`, `<sc-for>`, `<sc-if>` tags and a small logic class). **Treat them as the visual reference only**: copy the colors, type, spacing, shadows and layout, but do not port the runtime or tag syntax. The logic classes inside `Main.dc.html` and `Player.dc.html` show the intended behavior (packing, budget refusal, scrubbing, speed and sleep cycling).

## Vocabulary (use it in code and UI copy)

- **The Stacks**: the full library on the USB drive.
- **The Bag**: books copied to the phone. Has a storage budget the user sets (default 4 GB).
- **Pack** a book: copy it from USB to phone. **Put back**: delete the local copy (keep progress).
- **The Drawer**: the USB connection. Plugged in = drawer open.
- **Library card**: per-book history of checkouts (packed date) and returns.

## Recommended stack

React Native with Expo (development build, not Expo Go), TypeScript.

- Playback: `react-native-track-player` (background audio, lock screen and notification controls, speed).
- Storage: SQLite (`expo-sqlite`) for the index; local files in the app's document directory.
- File access to USB: needs a small native module or a library wrapping the platform pickers (see Platform notes).
- Metadata and cover art: parse ID3 / MP4 tags. Evaluate `music-metadata` or a native tag reader; test on real `.m4b` files early.

Ask the user before changing the stack.

## Design tokens

| Token | Value | Use |
|---|---|---|
| ground | `#1b1410` | app background |
| ground-deep | `#120d0a` | behind app |
| bag-panel | `#2a1e15` | Bag section, buttons |
| line | `#3a2a1e` | dividers |
| border | `#5a4330` | outlines, dashed Bag top edge |
| wood | `#6a4529` / highlight `#8f6039` | shelf ledges |
| paper | `#efe3cc` | primary text |
| paper-card | `#e9dcc0` / `#ece0c4` | shelf labels, library card |
| muted | `#b9a88c` | secondary text |
| faint | `#9c8b70` | tertiary text |
| accent (lamp) | `#e8a23a` | play button, IN BAG tag, ruler fill |
| ribbon / warning | `#c8402f` / `#d0553e` | bookmark ribbons, "won't fit", ruler over 85% |
| stamp ink | `#5b3a8a`, `#a8352a` | library card stamps |

Fonts (Google Fonts): **Young Serif** for titles and the play button label, **IBM Plex Mono** for all numbers, metadata, chips and labels, **Instrument Sans** for body text.

Character rules: small deliberate rotations (−3° to 3°) on tags, stamps, Bag covers and the play button; dashed top border on the Bag; no gradients except the lamp glow behind the player cover and the page-edge stripes; touch targets at least 44 px.

## Components

- **Book cover**: real cover art from metadata, with a slight inset shadow on the left (spine crease) and a drop shadow. Fallback when there is no art: solid color with the title in Young Serif (see mockup covers).
- **Page edge**: striped block to the right of a cover, width = `round(3 + hours / 5)` px. Long books look thick.
- **Shelf**: row of face-out covers resting on a wooden ledge, with a paper label card below. Shelf labels depend on sort (by length: Doorstoppers 40h+, Long haul, Commute sized, Short trips).
- **Ribbon**: red bookmark hanging below a cover when the book is in progress; also the playhead on the player scrubber.
- **IN BAG tag**: amber tag on covers that have a local copy.
- **Bag**: fanned small covers that overlap more as the budget fills; ruler with GB ticks below.

## Screens

1. **Stacks + Bag (Main)**: header with title, book count and total listening time, Drawer status button, sort chips (length, author, color, gathering dust). Scrollable shelves. Bag pinned at the bottom.
   - Tap a book in the Stacks: pack it, or put it back if already packed. (Real app: tapping opens the Book screen; packing could be a long-press or a button. Decide with the user.)
   - If it would exceed the budget, do not copy; show the "WON'T FIT" slip with how much space is short.
2. **Book (library card)**: big cover, duration and size, progress, library card of checkout and return dates, "Keep listening", "Put back in the stacks · frees X GB".
3. **Player**: chapter-level scrubber (minute ticks, ribbon playhead), ±30 s, play/pause, whole-book progress line with estimated finish time at current speed, bottom row: contents, speed (1, 1.1, 1.25, 1.5, 2), sleep timer ("lamp" icon: off, 15m, 30m, end of chapter), bookmark.
4. **Drawer shut**: USB not available. Stacks show a closed drawer and "last seen" time; the Bag keeps working.

## Data model (starting point)

```ts
type Book = {
  id: string;             // stable hash of relative path + size
  title: string; author: string; narrator?: string;
  durationSec: number; sizeBytes: number;
  sourceRelPath: string;  // path inside the USB library root
  files: string[];        // one .m4b, or many .mp3 parts in order
  chapters: { title: string; startSec: number }[];
  coverThumbPath?: string; // cached locally, small
  localPath?: string;      // set when packed
  progressSec: number; finishedAt?: string;
  checkouts: { out: string; back?: string }[];
  dominantColor?: string;  // for fallback covers and "by color" sort
};
```

## Core flows

- **Scan**: user picks the library folder on the USB once; persist access. Walk it, group files into books (one `.m4b`, or a folder of `.mp3` parts), read tags and chapters, extract cover, save a **small thumbnail locally** so the Stacks stay browsable when the drive is unplugged. Rescan incrementally (match by id).
- **Pack**: check free space against the budget and the device's real free space, copy with a progress indicator on the cover, verify size, set `localPath`, add a checkout entry. Must survive the app going to background or the drive being pulled (resume or clean up partial files).
- **Put back**: delete local files, keep progress and history, set `back` date.
- **Finish**: when a book finishes, offer to put it back.
- **Drawer state**: detect whether the library root is reachable; switch to the Drawer-shut view when not.

## Platform notes

- **Android**: USB-C / OTG drives through the Storage Access Framework (`ACTION_OPEN_DOCUMENT_TREE`, `takePersistableUriPermission`). Files are content URIs, not paths; copy via streams.
- **iOS**: external drives appear in the Files app; use a folder document picker and store a security-scoped bookmark to regain access. Access can be lost between sessions; handle that gracefully as "drawer shut".
- Test with a real drive and real files on both platforms early; this is the riskiest part of the project.

## Suggested build order

1. Project setup, theme tokens, fonts, cover + page-edge + shelf components with fake data (match `Main.dc.html`).
2. USB folder picking, scanning, metadata + cover extraction, SQLite index.
3. Pack / put back with budget checks and progress.
4. Player with track-player, chapters, speed, sleep timer, saved progress.
5. Book screen, library card history, Drawer-shut state, finish-and-return prompt.
6. Polish: sorting modes, empty states, animations.
