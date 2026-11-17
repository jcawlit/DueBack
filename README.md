<p align="center">
  <img src="assets/icon.png" alt="Due Back" width="120">
</p>

<h1 align="center">Due Back</h1>

<p align="center">
  <strong>An audiobook player for a collection that lives on a USB drive.</strong><br>
  Most of your books stay on the drive. A few ride along on the phone, and come
  back when you want the space.
</p>

<p align="center">
  <a href="#what-it-does">What it does</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#engineering-notes">Engineering notes</a> &middot;
  <a href="docs/DEVELOPMENT.md">Developing</a> &middot;
  <a href="docs/PRIVACY.md">Privacy</a>
</p>

---

A serious audiobook collection does not fit on a phone. One unabridged novel is
a gigabyte and a half, and the usual answer is to stream it from someone else's
server — which fails on a plane, in a basement, and on the day the service
drops the book you were halfway through.

Due Back takes the other answer. Keep the collection on a USB drive, plug the
drive into the phone when you want to swap books, and carry three or four at a
time. The library stays browsable whether the drive is connected or in a
drawer, and your place, your notes and your listening history live on your own
hardware.

It is for people who already have audiobook files. It does not sell, lend or
include audiobooks.

## What it does

- **Builds a library from a folder** of `.m4b`, `.m4a` or `.mp3` files —
  reading titles, authors, narrators, series, chapters and cover art out of the
  files themselves, without copying the audio.
- **Plays a book as one book**, whether that is a single `.m4b` or a hundred and
  twenty-seven loose `.mp3` files. Chapters, scrubbing, ±30 s, speed, a sleep
  timer, lock-screen controls, and playback that keeps going in your pocket.
- **Checks books out and returns them.** Checking out copies a book to the
  phone for offline listening. Returning deletes that copy and keeps everything
  else — your place, your notes, your history.
- **Keeps a storage budget.** You set a ceiling; the app measures every
  commitment against it and refuses a copy that will not fit, naming the exact
  shortfall, rather than filling the phone and failing halfway.
- **Works with the drive unplugged.** Covers, progress and search all come from
  the phone's own database. Check out a book with the drive away and it goes
  **on hold**, then copies itself the next time you connect.
- **Takes notes while you listen**, on the book and on its characters, without
  leaving the player.
- **Sorts the shelves seven ways** — length, author, series in story order,
  narrator, what is gathering dust, what you are in the middle of, and an
  arrangement you drag into place yourself.
- **Counts your listening**: totals, streaks, a fortnight of bars, your busiest
  day of the week, time spent per book.
- **Travels between phones.** Notes, progress, history and shelves are written
  back to the drive, so a second phone pointed at the same library picks up
  where the first left off.
- **Optionally connects to an Audiobookshelf server**, for a library you
  already host yourself. Experimental — see [status](#status).

### The vocabulary

The app speaks plain library language, and so does the code.

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

## How it works

1. **Point it at a folder** — on a USB drive, or on the phone itself.
2. **It scans.** One folder of audio is one book. Names come from embedded
   metadata, falling back to the folder name and cleaned of the usual debris
   (`[Unabridged]`, `(2019)`, `64kbps`, leading series numbers). No audio is
   copied; everything found goes into a local database.
3. **Browse and check out.** Tap a cover to open the book, press and hold to
   check it out. A tap never starts a copy, so a stray thumb cannot pull 1.5 GB
   onto the phone.
4. **Return it** when the trip is over, and the space comes back.

A library on the phone rather than a drive skips all of that: nothing to plug
in, nothing to check out, and no book is ever stored twice.

## Engineering notes

The interesting constraints, and what they cost.

**Scanning never copies audio.** Book details are pulled out with byte-range
reads against the container format — the atoms at the head of an `.m4b`, the
ID3 frames of an `.mp3`. A one-gigabyte audiobook is read in **164 KB across
three reads**. File size barely matters; only the number of seeks does. That is
what makes a library on a slow USB drive feel like a local one.

**Identity is sampled, not hashed whole.** A book's id comes from a
head-and-tail content sample, so moving or renaming a folder does not mint a
new book and lose your place, and a rescan updates rows instead of duplicating
them.

**The copy is atomic and resumable.** Parts stream into a staging folder and
each one's size is verified; only then does the folder move into place, so a
half-copied book is never visible as a book. A cancel, a pulled drive, a failed
read or the app being killed all leave the staging folder behind, and the next
check-out resumes it part by verified part.

**One player, many files.** Everything above the audio layer talks in
whole-book seconds. That parts exist at all — preloading the next as the
current one ends so the seam is as short as the platform allows, carrying a
position across a boundary — is hidden behind a single `AudioEngine`
interface, which is also what lets the layers above it be tested without a
device.

**Offline-first sync with no server.** The drive carries a `.dueback` folder of
generations; two phones merge it field by field, last writer wins, and a note
edited on both sides is kept as a conflicted copy rather than silently
overwritten. There is no account and nothing to sign in to.

**Themes are derived, not drawn.** One hand-tuned palette of sixty-odd tokens,
and the rest come from hue and saturation transforms over it — with a test that
walks the source tree and fails if a colour is written as a literal anywhere
outside the theme files.

**Gestures from first principles.** The drag that rearranges shelves is built
on React Native's own `PanResponder` and `Animated`, with no gesture-handler or
reanimated dependency: measured window coordinates, a drop target resolved
against live scroll offset, distance-proportional edge scrolling, and a cascade
of displaced books previewed as you move.

**582 tests, no device required.** Thirty-four suites on Node's built-in test
runner, over synthetic audio fixtures built by script, covering the metadata
parsers, grouping, identity, the budget arithmetic, the sync merge and the sort
logic. Everything that *can* be checked without hardware is, because
everything else has to be checked by hand on a phone with a real drive.

Built with **Expo SDK 57**, **React Native 0.86** and **TypeScript**, plus Expo
Router, `expo-sqlite`, `expo-audio` and zustand — roughly 33,000 lines across
142 TypeScript files. Android is the tested platform; the architecture is
cross-platform, with one known iOS gap.

Build instructions, architecture and a feature-by-feature account of what is
verified: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## Status

In development, and used daily by its author on a Pixel with a real drive.

The USB library, scanning, check-out and return, playback, notes, shelves and
the sorts have all been exercised on hardware. The Audiobookshelf connection is
implemented and unit-tested but has not been through a full session against a
real server on a phone. Google Drive as a library root was investigated and
shelved: the platform's file layer will not hand back a seekable handle on a
Drive document, which is exactly what the parsers need.

There is no store release yet. [docs/STATE.md](docs/STATE.md) is the current
ledger of what is verified and what is not.

## Privacy

There is no account and no server operated by Due Back. Your library and
reading data stay on your device, plus the drive you chose to back them up to,
plus any Audiobookshelf server you connect yourself. No advertising, no
analytics.

Full policy: **[docs/PRIVACY.md](docs/PRIVACY.md)**.

## Contact

Questions, bugs and ideas: **[duebackapp@gmail.com](mailto:duebackapp@gmail.com)**.

## License

[MIT](LICENSE) — Due Back is a personal project, open for reading and reuse.
