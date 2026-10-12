# List B — what only a real phone can tell us

Ten checks, in priority order. The emulator suite covers 82 cases and none of
these; every one depends on hardware, a real drive, or Android behaviour that
cannot be faked.

Work top to bottom. Stop and write down what happened the moment something
looks wrong — "it broke" a week later is hard to act on, and most of these
leave evidence only at the time.

For each: **what to do**, **what should happen**, and **why it matters**.

---

## 1. Plug in the real drive and scan the whole library

**Do:** Connect your USB drive by OTG. Open Settings, pick the library folder,
let the scan run to the end. Leave the phone alone while it works.

**Expect:** Every book found. A sensible book count. Progress that keeps
moving. At the end, a report naming anything it could not read.

**Watch for:** books that split into two, box sets that should be one book,
authors that are obviously wrong, covers that are the wrong art or static.

**Why first:** everything else is downstream of this. The emulator scanned 44
synthetic books; your library is hundreds of real ones with naming no
generator would invent.

---

## 2. Check out a large book, then leave the app

**Do:** Start a check-out of the biggest book you have. The moment the
progress overlay appears, switch to another app. Wait two minutes. Come back.

**Expect:** The copy finished, and the book is on your phone.

**If it did not:** note roughly how far it got, and whether the app had
restarted. **This single test decides whether Due Back needs a background
service.** If copies survive, we need nothing. If they die, how they died
tells me whether to add a service or make copies resumable.

**Also try:** screen off mid-copy rather than switching apps. Those are two
different causes and may behave differently.

---

## 3. Pull the drive out mid-copy

**Do:** Start a check-out of something large. Physically unplug the drive
while the bar is moving.

**Expect:** The copy stops. A message says so in plain English. The book goes
back to being on the shelf. **No half-copied book, and nothing claiming to be
checked out that is not.**

**Then:** plug the drive back in and check the same book out again. It should
work as if nothing happened.

**Why:** copies are all-or-nothing by design, and this is the test of that
promise. It is also the single most likely way a real person breaks the app.

---

## 4. Listen for an hour, screen off, phone in your pocket

**Do:** Check out a book, start playing, lock the phone, put it away. Leave it
an hour.

**Expect:** Uninterrupted playback. No silent stop. No restart from the
beginning. The lock screen keeps showing the right book and chapter.

**Watch for:** playback dying after a while (battery optimisation killing the
app), position jumping, or the lock screen going stale.

**Why:** the harness cannot run the real audio stack for an hour under real
power management. This is the core promise of the app.

---

## 5. Bluetooth and headphones

**Do:** While playing, unplug wired headphones. Then reconnect. Separately:
connect to a Bluetooth speaker or car, play, then walk out of range.

**Expect:** Audio pauses when the connection drops rather than carrying on out
loud. Reconnecting does not lose your place.

**Why:** we deliberately did not write a headphone module, because the
expo-audio docs say playback stops on disconnect. **This check confirms
whether that is actually true on your Pixel.** If audio blares out of the
phone speaker when your headphones disconnect, tell me and I will add it.

---

## 6. Unplug the drive and live without it for a day

**Do:** With a few books checked out, unplug the drive and use the app
normally. Browse. Play. Try to check out a book that is not on the phone.

**Expect:** Shelves still browsable from cached covers. "Drive not connected"
shown honestly. Checked-out books play perfectly. Asking for a book you do not
have puts it on hold rather than failing.

**Then:** plug the drive back in and watch the holds copy across on their own.

**Why:** this is the app's actual daily shape. Most of the time the drive is
not there.

---

## 7. Restart the phone, then open the app

**Do:** Reboot. Open Due Back without the drive connected. Then plug it in.

**Expect:** The library is still there. Your position in the last book is
still there. Checked-out books still play. Plugging the drive in is noticed
without you pressing anything.

**Watch for:** being asked to pick the folder again. Android is supposed to
remember the permission; if it does not, that is a real bug and worth knowing
early.

---

## 8. Finish a book, and return one

**Do:** Play a short book to the very end. Then return a different book you
have part-read.

**Expect:** Finishing offers to return it. Returning frees the space and
**keeps your position and history**. A book that exists only on your phone
asks twice before anything is deleted.

**Why:** returning is the only destructive thing the app does. The last
confirmation is all that stands between a user and losing audio they cannot
get back.

---

## 9. Add a book from the phone itself

**Do:** Use "add a book folder" or "add a single file" to import something
from phone storage, not the drive. Play it. Then connect the drive and accept
the offer to copy it across.

**Expect:** Imports play like any other book. The offer to put it on the drive
appears once, not on every reconnect. After copying, the book is genuinely on
the drive — go and look at the folder on a computer.

**Why:** the import path had the worst bug we found, and the copy-to-drive
path was rewritten today and has never run against a real drive.

---

## 10. Search, duplicates and the DRM stamp

**Do:** With the full library loaded, search for a few books by title, by
author, and by half-remembered spelling. Look for a book you know you have two
copies of. Find any Audible downloads.

**Expect:** Search is instant with hundreds of books, and forgiving about
accents and word order. A duplicated book says where its twin lives. A DRM
book is stamped on the cover and explains itself.

**Why:** all three were built today and have only ever been tested against
synthetic data. Search in particular is about how it *feels* at real scale,
which no test can answer.

---

## If something goes wrong

Note the book, what you were doing, and what the screen said. If the app
crashes or a message looks wrong, that wording is the most useful thing you
can write down — it usually points straight at the code.

Checks **2** and **5** are the two whose answers change what gets built next.
