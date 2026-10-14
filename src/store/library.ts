/**
 * Library state: what is on the shelf, what is checked out, what is on hold,
 * and the rules governing the moves between those states.
 *
 * The database is the source of truth; this store is a cache of it for the UI,
 * and every move writes through to SQLite before the screens see it. `copying`
 * is the one state never written there — `npm run kb copying`.
 */

import { create } from 'zustand';
import type { Book, SortMode } from '@/data/types';
import { occupiesBudget } from '@/data/types';
import { bytes as formatBytes, gigabytes } from '@/lib/format';
import {
  addCheckout,
  checkedOutLocalParts,
  clearPartLocalPaths,
  deleteBook,
  markBookMissing,
  importsAwaitingDrive,
  markImportOnDrive,
  closeCheckout,
  loadBooks,
  loadParts,
  setLocalState,
  setPartLocalPaths,
  updateProgress,
} from '@/db/books';
import {
  copyImportToDrive,
  deleteImport,
  importBookFromFile,
  importBookFromFolder,
} from '@/lib/files/import';
import { buildImportedBook, saveImportedBook } from '@/lib/scan/importBook';
import { libraryOnDeviceOverride } from '@/dev/faults';
import {
  checkFreeSpace,
  copyBookToDevice,
  deleteLocalCopy,
  listLocalBookIds,
  localUriFor,
  sweepTempCopies,
  type CopyPart,
} from '@/lib/files/copy';
import { removeCover } from '@/lib/files/covers';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { isPresent, isReachable } from '@/lib/files/access';
import { isDeviceStorage } from '@/lib/files/safNames';
import { waitForScanToFinish } from '@/lib/scanBusy';

const GB = 1024 * 1024 * 1024;

/**
 * A transient paper slip, like the mockup's "WON'T FIT" notice. `stamp` is the
 * rubber-stamped word in the margin; refusals default to "WON'T FIT".
 */
export type Slip = {
  kind: 'wont-fit' | 'note';
  text: string;
  stamp?: string;
};

/** A move that needs an explicit answer before it happens. */
export type Confirm = {
  kind: 'return-missing';
  bookId: string;
  title: string;
};

export type LibraryRootInfo = {
  uri: string;
  name: string;
};

type LibraryState = {
  /** False until the database has been read for the first time. */
  ready: boolean;
  /** Set when the database could not be opened or read. */
  startupError: string | null;
  books: Book[];
  sort: SortMode;
  budgetBytes: number;
  libraryRoot: LibraryRootInfo | null;
  driveConnected: boolean;
  /**
   * The library folder is on the phone itself, so there is nothing to plug in
   * and nothing to check out: every book is already here.
   */
  libraryOnDevice: boolean;
  driveLastSeenAt: string;
  slip: Slip | null;
  confirm: Confirm | null;

  /** Loads settings and books from the database. */
  hydrate: () => Promise<void>;
  /** Re-reads books from the database after a scan. */
  refresh: () => Promise<void>;
  setLibraryRoot: (root: LibraryRootInfo | null) => Promise<void>;
  /** Re-checks whether the drive is reachable; called on launch and resume. */
  checkDrive: () => Promise<boolean>;
  /**
   * The cheap check behind the foreground poller. Does nothing at all unless
   * the drive has appeared or disappeared since the last look.
   */
  pollDrive: () => Promise<void>;

  setSort: (sort: SortMode) => void;
  setBudgetBytes: (value: number) => void;

  checkOut: (id: string) => void;
  returnBook: (id: string, opts?: { confirmed?: boolean }) => void;
  cancelHold: (id: string) => void;
  /** Stops an in-flight copy and discards what was staged. */
  cancelCopy: (id: string) => void;

  /**
   * Checks a book out and starts playing the moment the copy lands. Used by
   * the Book screen so a book that is not on the phone is never a dead end.
   */
  checkOutAndPlay: (id: string, onReady: (id: string) => void) => void;

  /** What an in-flight import is doing, for the Settings row to report. */
  importing: string | null;
  /** Imported books waiting to be copied onto the drive. */
  pendingDriveImports: { id: string; title: string; folderName: string }[];
  /** What a push to the drive is doing, for the Settings row. */
  pushingToDrive: string | null;
  /** Adds a book from phone storage. `kind` picks file or folder. */
  importBook: (kind: 'file' | 'folder') => Promise<void>;
  /** Copies the pending imports onto the library drive. */
  pushImportsToDrive: () => Promise<void>;
  dismissDriveImportOffer: () => void;

  showSlip: (slip: Slip) => void;
  dismissSlip: () => void;
  dismissConfirm: () => void;

  /**
   * Saves a playback position. Always writes the database; only replaces the
   * book in memory when `commit` is set — see the implementation.
   */
  recordProgress: (id: string, positionSec: number, options?: { commit?: boolean }) => void;
};

/** Books the user has asked to stop copying. */
const cancelledCopies = new Set<string>();

/**
 * Told that a book's audio is about to be deleted, so that whatever is
 * playing it can let go first.
 *
 * A callback rather than a direct call because the player store imports this
 * one, and importing it back would make a cycle. The player registers itself
 * when it loads, which the root layout guarantees happens at startup.
 */
let audioRemovedHandler: ((bookId: string) => void) | null = null;
export function onBookAudioRemoved(handler: (bookId: string) => void) {
  audioRemovedHandler = handler;
}
/** Books with a copy running right now, so a second one cannot start. */
const copiesInFlight = new Set<string>();
let slipTimer: ReturnType<typeof setTimeout> | undefined;
/** Guards against two concurrent hydrations racing the database open. */
let hydrating = false;
/**
 * What the last cheap presence check saw.
 *
 * The poller acts on a change in this rather than on a mismatch with
 * `driveConnected`: a stale permission leaves the root present but unreadable,
 * and comparing the two would re-list the root every few seconds.
 */
let lastPresence: boolean | null = null;

/**
 * Whether the chosen library already lives on the phone. A test can stand in
 * an answer here; see src/dev/faults.ts.
 */
function resolveOnDevice(rootUri: string | null | undefined): boolean {
  const forced = libraryOnDeviceOverride();
  if (forced !== undefined) return forced;
  return rootUri ? isDeviceStorage(rootUri) : false;
}

/** Bytes actually sitting on the phone right now. */
export function usedBytes(books: Book[]): number {
  return books.reduce((sum, b) => (occupiesBudget(b) ? sum + b.sizeBytes : sum), 0);
}

/** Bytes promised: on the phone, plus everything queued on hold. */
export function committedBytes(books: Book[]): number {
  return books.reduce(
    (sum, b) =>
      occupiesBudget(b) || b.local.status === 'on-hold' ? sum + b.sizeBytes : sum,
    0,
  );
}

export function holdBytes(books: Book[]): number {
  return books.reduce(
    (sum, b) => (b.local.status === 'on-hold' ? sum + b.sizeBytes : sum),
    0,
  );
}

/**
 * Puts the database back in step with the filesystem: a book counts as checked
 * out only if its files are really there. They might not be — the app was
 * killed mid-copy, or app storage was cleared.
 *
 * Exported for the dev self-test harness, which runs it on demand.
 */
export async function reconcileLocalCopies() {
  try {
    const rows = await checkedOutLocalParts();
    /** Books that survived reconciliation and still own their local folder. */
    const stillCheckedOut = new Set<string>();
    for (const row of rows) {
      // Checked against the paths the book actually recorded, not against
      // `books/<id>/`: an imported book's audio lives in `imported/<id>/`.
      const complete =
        row.partCount > 0 &&
        row.localPaths.length >= row.partCount &&
        row.localPaths.every((p) => localUriFor(p) !== null);
      if (complete) {
        stillCheckedOut.add(row.id);
        continue;
      }

      deleteLocalCopy(row.id);

      if (row.sourceKind === 'imported') {
        deleteImport(row.id);
        // An import that never reached the drive has no copy anywhere else, so
        // leaving the row behind would put a book on the shelf that can never
        // be checked out and can never be played. Drop it rather than lie.
        if (!row.onDrive) {
          await deleteBook(row.id);
          removeCover(row.id);
          continue;
        }
      }

      await clearPartLocalPaths(row.id);
      await setLocalState(row.id, { status: 'on-shelf' });
    }

    // Anything left in `books/` that no checked-out book claims is dead weight:
    // a copy whose book was forgotten, a folder left by a crash, or a rename
    // that moved the book's identity. It occupies real space while being
    // invisible to the storage ruler, so it goes.
    for (const id of listLocalBookIds()) {
      // A copy running right now owns its folder even though no finished book
      // claims it yet: `copying` is never written to the database, so without
      // this the sweep deletes the files out from under it.
      if (!stillCheckedOut.has(id) && !copiesInFlight.has(id)) deleteLocalCopy(id);
    }
  } catch {
    // Reconciliation is a safety net; never let it stop the app starting.
  }
}

export const useLibrary = create<LibraryState>((set, get) => {
  /** Replaces one book in place, leaving the rest of the array identical. */
  const patch = (id: string, next: (b: Book) => Book) =>
    set((s) => ({ books: s.books.map((b) => (b.id === id ? next(b) : b)) }));

  const flashSlip = (slip: Slip) => {
    clearTimeout(slipTimer);
    set({ slip });
    slipTimer = setTimeout(() => set({ slip: null }), 3400);
  };

  /**
   * Copies a book onto the phone, all-or-nothing. Progress is the real bytes
   * landing on disk; anything that goes wrong leaves the book on the shelf
   * with nothing saved.
   */
  const startCopy = async (book: Book, onCheckedOut?: (id: string) => void) => {
    // One copy per book, ever. `checkDrive` flushes holds and runs from
    // several places at once, so without this two calls can both start a copy
    // and fight over the same staging folder.
    if (copiesInFlight.has(book.id)) return;
    // Cancelled while it was still waiting its turn. `runCopy` clears the flag
    // on entry, so without this the queue would copy it anyway.
    if (cancelledCopies.has(book.id)) {
      cancelledCopies.delete(book.id);
      return;
    }
    copiesInFlight.add(book.id);
    try {
      await runCopy(book, onCheckedOut);
    } catch (err) {
      // Anything thrown here used to leave the book pinned at "copying" for
      // the rest of the session: nothing else ever resets that state, and it
      // is never written to the database, so even a relaunch could not clear
      // it. A failed copy puts the book back on the shelf and says why.
      patch(book.id, (b) => ({ ...b, local: { status: 'on-shelf' } }));
      await setLocalState(book.id, { status: 'on-shelf' }).catch(() => {});
      await clearPartLocalPaths(book.id).catch(() => {});
      deleteLocalCopy(book.id);
      flashSlip({
        kind: 'wont-fit',
        text: `${book.title} could not be copied: ${(err as Error)?.message ?? 'unknown error'}`,
      });
    } finally {
      copiesInFlight.delete(book.id);
    }
  };

  const runCopy = async (book: Book, onCheckedOut?: (id: string) => void) => {
    cancelledCopies.delete(book.id);
    patch(book.id, (b) => ({ ...b, local: { status: 'copying', progress: 0 } }));
    const started = new Date().toISOString();

    let parts: CopyPart[];
    try {
      const rows = await loadParts(book.id);
      parts = rows.map((r) => ({ uri: r.uri, name: r.name, sizeBytes: r.size_bytes }));
      if (parts.length === 0) throw new Error('No files are recorded for this book');
    } catch (err) {
      patch(book.id, (b) => ({ ...b, local: { status: 'on-shelf' } }));
      flashSlip({ kind: 'wont-fit', text: (err as Error).message });
      return;
    }

    const outcome = await copyBookToDevice(book.id, parts, {
      shouldCancel: () => cancelledCopies.has(book.id),
      onProgress: ({ bytesCopied, totalBytes }) => {
        const progress = totalBytes > 0 ? bytesCopied / totalBytes : 0;
        patch(book.id, (b) =>
          b.local.status === 'copying' ? { ...b, local: { status: 'copying', progress } } : b,
        );
      },
    });

    cancelledCopies.delete(book.id);

    if (!outcome.ok) {
      patch(book.id, (b) => ({ ...b, local: { status: 'on-shelf' } }));
      await setLocalState(book.id, { status: 'on-shelf' });
      await clearPartLocalPaths(book.id);

      if (outcome.reason === 'source-missing') {
        /*
         * A deleted book and a pulled drive look identical from inside the
         * copy, and asking the root is what tells them apart. Marking a book
         * NOT ON DRIVE because someone unplugged the drive is a lie that
         * outlives the moment.
         */
        if (!(await proveDriveReachable())) {
          flashSlip({
            kind: 'note',
            stamp: 'DRIVE REMOVED',
            text: `The drive was disconnected, so ${book.title} wasn't copied. Nothing was saved — plug it back in and check it out again.`,
          });
          return;
        }

        // The book really has gone from the library folder. Record that now so
        // the shelf tells the truth immediately, rather than leaving the user
        // to guess that a rescan is what they need.
        await markBookMissing(book.id);
        await get().refresh();
        flashSlip({
          kind: 'wont-fit',
          stamp: 'NOT ON DRIVE',
          text: `${book.title} is no longer in the library folder. It's been marked as off the shelf.`,
        });
        return;
      }

      // Any other failure may also be a drive that has gone; the header should
      // not keep claiming it is connected until the app next comes back to the
      // foreground.
      if (outcome.reason === 'failed') await proveDriveReachable();

      // `cancelCopy` has already said so, at the moment the button was
      // pressed. Saying it again here would be a second slip for one action.
      if (outcome.reason !== 'cancelled') {
        flashSlip({
          kind: outcome.reason === 'no-space' ? 'wont-fit' : 'note',
          text: outcome.message,
        });
      }
      return;
    }

    await setPartLocalPaths(book.id, outcome.localRelPaths);
    const localPath = `books/${book.id}`;
    patch(book.id, (b) => ({
      ...b,
      local: { status: 'checked-out', localPath },
      checkouts: [...b.checkouts, { out: started }],
    }));
    await setLocalState(book.id, { status: 'checked-out', localPath });
    await addCheckout(book.id, started);
    flashSlip({
      kind: 'note',
      stamp: 'CHECKED OUT',
      text: `${book.title} is on your phone. Safe to unplug.`,
    });
    onCheckedOut?.(book.id);
  };

  /**
   * Everything that can stop a check-out, in one place, so that no route to a
   * copy can miss one. Returns the slip to show, or null to proceed.
   */
  const refusalFor = (book: Book): Slip | null => {
    /*
     * Why a book cannot be played comes before where it already is. "It is
     * already on this phone" is true of a DRM-protected or damaged book too,
     * and saying that instead sends the user off to press a Play button that
     * cannot work.
     */
    if (book.drmProtected) {
      return {
        kind: 'wont-fit',
        text: `${book.title} is protected by DRM and can't be played.`,
      };
    }

    // Nothing in the folder could be read as audio, so there is no part to
    // copy. The book is still listed — it exists on the drive and the user may
    // want to go and look at it — but it cannot be checked out.
    if (book.files.length === 0 || book.durationSec <= 0) {
      return {
        kind: 'wont-fit',
        text: `${book.title} has no audio that can be read. The files may be empty or damaged.`,
      };
    }

    /*
     * A library already on the phone has nothing to check out. The screens
     * know this too, but the promise that no book is stored twice belongs
     * here, where every route to a copy passes through.
     */
    if (get().libraryOnDevice) {
      return {
        kind: 'note',
        text: `${book.title} is already on this phone. Open it and press play.`,
      };
    }

    // A book flagged missing has no readable source: its files were indexed
    // from a folder that is no longer the library, or they have been deleted.
    if (book.missingFromDrive) {
      return {
        kind: 'wont-fit',
        text: `${book.title} isn't in the library folder any more. Rescan, or switch back to the folder it came from.`,
      };
    }

    const free = get().budgetBytes - committedBytes(get().books);
    if (book.sizeBytes > free) {
      return {
        kind: 'wont-fit',
        text: `${book.title} needs ${formatBytes(book.sizeBytes)}. You have ${formatBytes(free)} left. Return something?`,
      };
    }

    // The budget is a preference; the phone's actual free space is a fact.
    const space = checkFreeSpace(book.sizeBytes);
    if (!space.ok) {
      return {
        kind: 'wont-fit',
        text: `${book.title} needs ${formatBytes(book.sizeBytes)}, and the phone is ${formatBytes(space.shortBy)} short of keeping 1 GB free.`,
      };
    }
    return null;
  };

  /**
   * Proves the drive is really readable right now. `driveConnected` can be
   * seconds stale, and the poller behind it uses a deliberately weaker test.
   */
  const proveDriveReachable = async (): Promise<boolean> => {
    const root = get().libraryRoot;
    const reachable = root ? await isReachable(root.uri) : false;
    if (!reachable) set({ driveConnected: false });
    return reachable;
  };
  /**
   * Stops a copy; the staged files are discarded.
   *
   * The book goes back on the shelf here rather than when the copy notices,
   * because the copy can only notice between parts: one part is a single
   * native `copy()` call that cannot be interrupted, so cancelling a one-file
   * book means waiting for the whole file. The bytes are thrown away either
   * way, and the drive keeps reading until that part finishes — but the
   * button answers now, which is what it promises.
   */
  const cancelCopy = (id: string) => {
    if (cancelledCopies.has(id)) return;
    cancelledCopies.add(id);
    const book = get().books.find((b) => b.id === id);
    patch(id, (b) =>
      b.local.status === 'copying' ? { ...b, local: { status: 'on-shelf' } } : b,
    );
    flashSlip({
      kind: 'note',
      stamp: 'STOPPED',
      text: `${book?.title ?? 'That book'} wasn't checked out. Nothing was saved.`,
    });
  };

  /**
   * Every copy, from every route, in turn.
   *
   * The drive is the bottleneck: three copies off one stick are slower than
   * three in a row, not faster, and running them together left books stuck at
   * 100% and then gone — several copies reach the end at once and write their
   * parts and their checked-out state to SQLite in the same moment. Holds were
   * always queued; the check-out buttons were not.
   */
  let copyQueue: Promise<unknown> = Promise.resolve();
  const queueCopy = (book: Book, onCheckedOut?: (id: string) => void) => {
    copyQueue = copyQueue.then(() => startCopy(book, onCheckedOut)).catch(() => {});
    return copyQueue;
  };

  /**
   * Starts copies for anything on hold that now fits — strictly one at a time.
   * The drive is the bottleneck, so a queue is faster than parallel reads off
   * one stick, as well as calmer.
   */
  const flushHolds = () => {
    const held = get().books.filter((b) => b.local.status === 'on-hold');
    if (held.length === 0) return;
    const queued: Book[] = [];
    let refused = 0;
    held.forEach((book) => {
      // Measured against everything already committed, including the books
      // queued just above, so the budget cannot be overspent by a batch.
      const others = get().books.filter((b) => b.id !== book.id);
      const alreadyQueued = queued.reduce((n, b) => n + b.sizeBytes, 0);
      const free = get().budgetBytes - committedBytes(others) - alreadyQueued;
      if (book.sizeBytes <= free) queued.push(book);
      else refused += 1;
    });

    const copied = queued.length;
    void (async () => {
      // The drive reappearing starts a re-sync scan and flushes the holds from
      // the same event, so without this a scan writing hundreds of rows and a
      // copy recording where it put its files reached SQLite together, and one
      // of them lost. Let the scan finish; the books are not going anywhere.
      await waitForScanToFinish();
      for (const book of queued) {
        if (get().books.find((b) => b.id === book.id)?.local.status !== 'on-hold') continue;
        await queueCopy(book);
      }
    })();

    if (copied > 0) {
      flashSlip({
        kind: 'note',
        stamp: 'DRIVE CONNECTED',
        text:
          refused > 0
            ? `Checking out ${copied} held ${copied === 1 ? 'book' : 'books'}. ${refused} still won't fit.`
            : `Drive connected. Checking out ${copied} held ${copied === 1 ? 'book' : 'books'}.`,
      });
    }
  };

  return {
    ready: false,
    startupError: null,
    books: [],
    sort: 'length',
    budgetBytes: 4 * GB,
    libraryRoot: null,
    driveConnected: false,
    libraryOnDevice: false,
    driveLastSeenAt: new Date().toISOString(),
    slip: null,
    confirm: null,
    importing: null,
    pendingDriveImports: [],
    pushingToDrive: null,

    hydrate: async () => {
      // Idempotent: mounting effects and fast refresh can both call this.
      if (get().ready || hydrating) return;
      hydrating = true;
      await reconcileLocalCopies();
      try {
        const [rootUri, rootName, lastSeen, budget, books] = await Promise.all([
          getSetting(SETTING_KEYS.libraryRootUri),
          getSetting(SETTING_KEYS.libraryRootName),
          getSetting(SETTING_KEYS.lastSeenAt),
          getSetting(SETTING_KEYS.budgetBytes),
          loadBooks(),
        ]);
        /*
         * Tidy the staging folder now the books are known. What an interrupted
         * copy left is kept only for a book that still exists, so checking it
         * out again carries on from where it stopped.
         */
        sweepTempCopies(books.map((b) => b.id));

        const root = rootUri ? { uri: rootUri, name: rootName ?? rootUri } : null;
        set({
          libraryOnDevice: resolveOnDevice(root?.uri),
          ready: true,
          startupError: null,
          books,
          libraryRoot: root,
          budgetBytes: budget ? Number(budget) : 4 * GB,
          driveLastSeenAt: lastSeen ?? new Date().toISOString(),
        });
        if (root) await get().checkDrive();
      } catch (err) {
        // A library that cannot be read must say so rather than showing an
        // empty screen with no explanation.
        const message = (err as Error)?.message ?? 'Could not open the library.';
        console.warn('[dueback] hydrate failed:', message);
        set({ ready: true, startupError: message });
      } finally {
        hydrating = false;
      }
    },

    refresh: async () => {
      const loaded = await loadBooks();

      // A copy in flight exists only in memory, so a reload would throw it
      // back to whatever the database last said.
      //
      // Read inside the updater, not before the await above: a snapshot taken
      // earlier goes stale when a copy finishes mid-load, and the remembered
      // `copying` then overwrites the finished state on every later refresh.
      set((s) => {
        const inFlight = new Map(
          s.books.filter((b) => b.local.status === 'copying').map((b) => [b.id, b.local]),
        );
        if (inFlight.size === 0) return { books: loaded };
        return {
          books: loaded.map((b) => {
            const live = inFlight.get(b.id);
            return live ? { ...b, local: live } : b;
          }),
        };
      });
    },

    setLibraryRoot: async (root) => {
      await setSetting(SETTING_KEYS.libraryRootUri, root?.uri ?? null);
      await setSetting(SETTING_KEYS.libraryRootName, root?.name ?? null);
      set({ libraryRoot: root, libraryOnDevice: resolveOnDevice(root?.uri) });
      if (root) await get().checkDrive();
      else set({ driveConnected: false });
    },

    checkDrive: async () => {
      const root = get().libraryRoot;
      if (!root) {
        set({ driveConnected: false });
        return false;
      }
      const connected = await isReachable(root.uri);
      // Keep the poller in step, so a manual check does not leave it thinking
      // the drive has just changed state.
      lastPresence = connected;
      const now = new Date().toISOString();
      set({
        driveConnected: connected,
        driveLastSeenAt: connected ? now : get().driveLastSeenAt,
      });
      if (connected) {
        await setSetting(SETTING_KEYS.lastSeenAt, now);
        flushHolds();
        // The drive is back: anything added from the phone can go onto it.
        try {
          set({ pendingDriveImports: await importsAwaitingDrive() });
        } catch {
          // Not worth failing a reachability check over.
        }
      } else {
        set({ pendingDriveImports: [] });
      }
      return connected;
    },

    pollDrive: async () => {
      const { libraryRoot: root, libraryOnDevice } = get();
      // A library on the phone has nothing to plug in, and nothing to watch.
      if (!root || libraryOnDevice) return;

      const present = isPresent(root.uri);
      if (present === lastPresence) return;
      lastPresence = present;

      if (!present) {
        if (get().driveConnected) set({ driveConnected: false, pendingDriveImports: [] });
        return;
      }

      // The drive has just appeared. `checkDrive` is the honest answer —
      // it lists the root, records the sighting, picks up anything on hold and
      // offers to put imports across — and the re-sync scan follows from the
      // connected flag changing, so it happens once per arrival rather than
      // once per look.
      await get().checkDrive();
    },

    setSort: (sort) => set({ sort }),
    setBudgetBytes: (budgetBytes) => {
      set({ budgetBytes });
      void setSetting(SETTING_KEYS.budgetBytes, String(budgetBytes));
    },

    checkOut: (id) => {
      const { books, driveConnected } = get();
      const book = books.find((b) => b.id === id);
      if (!book) return;
      if (book.local.status === 'checked-out' || book.local.status === 'copying') return;
      if (book.local.status === 'on-hold') {
        get().cancelHold(id);
        return;
      }

      const refusal = refusalFor(book);
      if (refusal) {
        flashSlip(refusal);
        return;
      }

      const placeOnHold = () => {
        // The file lives on the drive, so queue it rather than dead-ending.
        const since = new Date().toISOString();
        patch(id, (b) => ({ ...b, local: { status: 'on-hold', since } }));
        void setLocalState(id, { status: 'on-hold', since });
        flashSlip({
          kind: 'note',
          stamp: 'ON HOLD',
          text: `${book.title} is on hold. It'll check out when the drive is connected.`,
        });
      };

      if (!driveConnected) {
        placeOnHold();
        return;
      }

      void (async () => {
        if (!(await proveDriveReachable())) {
          placeOnHold();
          return;
        }
        void queueCopy(book);
      })();
    },

    returnBook: (id, opts) => {
      const book = get().books.find((b) => b.id === id);
      if (!book) return;
      if (book.local.status === 'on-shelf') return;

      // The local copy is the only copy left — make the user say so out loud.
      if (book.onlyCopyOnPhone && !opts?.confirmed) {
        set({ confirm: { kind: 'return-missing', bookId: id, title: book.title } });
        return;
      }

      // Returning mid-copy is a cancel; the staged files are thrown away.
      if (book.local.status === 'copying') {
        cancelCopy(id);
        return;
      }

      const backDate = new Date().toISOString();
      patch(id, (b) => {
        const checkouts = [...b.checkouts];
        for (let i = checkouts.length - 1; i >= 0; i -= 1) {
          if (!checkouts[i].back) {
            checkouts[i] = { ...checkouts[i], back: backDate };
            break;
          }
        }
        return { ...b, local: { status: 'on-shelf' }, checkouts };
      });
      // Playback stops before the audio under it does. Returning a book that
      // is playing used to leave it playing from files that no longer existed.
      audioRemovedHandler?.(id);
      // The local files go; progress and history stay in the database.
      deleteLocalCopy(id);
      set({ confirm: null });

      // An import that never reached the drive has no copy anywhere else, so
      // returning it is a deletion, not a return. Leaving the row behind put a
      // book on the shelf that could not be checked out and could not be
      // played — and it only disappeared on the next launch, when startup
      // reconciliation finally noticed.
      if (book.importedFromPhone && book.onlyCopyOnPhone) {
        deleteImport(id);
        set((s) => ({ books: s.books.filter((b) => b.id !== id) }));
        // Dropped from the list at once so the shelf does not flicker, but the
        // row has to be gone from the database before anything reloads from
        // it — otherwise the next refresh brings the book straight back.
        void deleteBook(id).then(() => {
          removeCover(id);
          return get().refresh();
        });
        flashSlip({
          kind: 'note',
          stamp: 'REMOVED',
          text: `${book.title} was only on this phone, so it has been removed from the library.`,
        });
        return;
      }

      if (book.importedFromPhone) deleteImport(id);
      void clearPartLocalPaths(id);
      void setLocalState(id, { status: 'on-shelf' });
      void closeCheckout(id, backDate);
      flashSlip({
        kind: 'note',
        stamp: 'RETURNED',
        text: `${book.title} returned. ${gigabytes(book.sizeBytes)} free.`,
      });
    },

    cancelCopy,

    checkOutAndPlay: (id, onReady) => {
      const { books, driveConnected } = get();
      const book = books.find((b) => b.id === id);
      if (!book) return;

      // Already here: nothing to copy, just play.
      if (book.local.status === 'checked-out') {
        onReady(id);
        return;
      }
      if (book.local.status === 'copying') return;

      const refusal = refusalFor(book);
      if (refusal) {
        flashSlip(refusal);
        return;
      }

      const driveNotConnected: Slip = {
        kind: 'wont-fit',
        stamp: 'DRIVE NOT CONNECTED',
        text: 'Plug in your drive to check this out.',
      };
      if (!driveConnected) {
        flashSlip(driveNotConnected);
        return;
      }

      void (async () => {
        // Unlike `checkOut`, there is no hold to fall back on here: the user
        // asked to listen now, so a vanished drive has to be said out loud.
        if (!(await proveDriveReachable())) {
          flashSlip(driveNotConnected);
          return;
        }
        void queueCopy(book, onReady);
      })();
    },

    importBook: async (kind) => {
      if (get().importing) return;
      set({ importing: 'Waiting for you to choose…' });

      const onProgress = ({ done, total, name }: { done: number; total: number; name: string }) =>
        set({
          importing:
            total > 1 ? `Copying ${done + 1} of ${total}…` : `Copying ${name}…`,
        });

      try {
        const result =
          kind === 'file'
            ? await importBookFromFile(onProgress)
            : await importBookFromFolder(onProgress);

        if (!result.ok) {
          if (result.reason !== 'cancelled') {
            flashSlip({ kind: 'wont-fit', text: result.message });
          }
          return;
        }

        set({ importing: 'Reading the tags…' });
        try {
          const book = await buildImportedBook(result.bookId, result.folderName, result.files);

          // Nothing in what was picked is playable. A book on the drive in this
          // state is still worth listing — it exists, and the user may want to
          // go and look at it — but an import has no such folder to go back to,
          // so saving it would only put an unplayable row on the shelf and
          // leave the staged copies on disk for ever.
          if (book.parts.length === 0) {
            deleteImport(result.bookId);
            flashSlip({
              kind: 'wont-fit',
              text:
                result.files.length === 1
                  ? "That file has no audio that can be read. It may be empty or damaged."
                  : 'None of those files had audio that could be read.',
            });
            return;
          }

          await saveImportedBook(
            book,
            // The parts that survived, not everything that was staged: a file
            // dropped as unplayable must not be recorded as one of the book's
            // local files.
            book.parts.map((p) => p.relPath),
          );
          await get().refresh();
          flashSlip({
            kind: 'note',
            stamp: 'ADDED',
            text: `${book.title} added from this phone.`,
          });
          if (get().driveConnected) {
            set({ pendingDriveImports: await importsAwaitingDrive() });
          }
        } catch (err) {
          deleteImport(result.bookId);
          flashSlip({
            kind: 'wont-fit',
            text: (err as Error)?.message ?? 'That book could not be read.',
          });
        }
      } finally {
        set({ importing: null });
      }
    },

    pushImportsToDrive: async () => {
      const root = get().libraryRoot;
      const pending = get().pendingDriveImports;
      if (!root || pending.length === 0 || get().pushingToDrive) return;

      let copied = 0;
      /** Why each book failed, not just that it did — see the slip below. */
      const failures: { title: string; message: string }[] = [];
      set({ pushingToDrive: 'Starting…' });
      try {
        for (const item of pending) {
          const rows = await loadParts(item.id);
          const files = rows.map((r) => ({
            relPath: r.local_rel_path ?? '',
            name: r.name,
            sizeBytes: r.size_bytes,
          }));
          if (files.some((f) => !f.relPath)) {
            failures.push({ title: item.title, message: 'its files are no longer on the phone' });
            continue;
          }
          const outcome = await copyImportToDrive(
            root.uri,
            item.folderName,
            files,
            ({ fileIndex, fileCount, bytesCopied, totalBytes }) => {
              const pct = totalBytes > 0 ? Math.floor((bytesCopied / totalBytes) * 100) : 0;
              set({
                pushingToDrive:
                  fileCount > 1
                    ? `${item.title}: file ${fileIndex + 1} of ${fileCount} · ${pct}%`
                    : `${item.title}: ${pct}%`,
              });
            },
          );
          if (outcome.ok) {
            await markImportOnDrive(item.id, outcome.folderRelPath, outcome.files);
            copied += 1;
          } else {
            failures.push({ title: item.title, message: outcome.message });
          }
        }
      } finally {
        set({ pushingToDrive: null });
      }

      set({ pendingDriveImports: await importsAwaitingDrive() });
      await get().refresh();

      /*
       * The reason, every time, and a stamp of its own: the slip renders an
       * unstamped refusal as "WON'T FIT", which is a lie about a drive that
       * rejected a write.
       */
      const failed = failures.length;
      flashSlip({
        kind: failed > 0 && copied === 0 ? 'wont-fit' : 'note',
        stamp: copied > 0 ? 'ON THE DRIVE' : 'NOT COPIED',
        text:
          copied > 0
            ? `${copied} ${copied === 1 ? 'book' : 'books'} copied to the drive.` +
              (failed > 0 ? ` ${failures[0].title} could not be: ${failures[0].message}` : '')
            : failed === 1
              ? `${failures[0].title} could not be copied: ${failures[0].message}`
              : `${failed} books could not be copied. ${failures[0].title}: ${failures[0].message}`,
      });
    },

    dismissDriveImportOffer: () => set({ pendingDriveImports: [] }),

    cancelHold: (id) => {
      const book = get().books.find((b) => b.id === id);
      if (!book || book.local.status !== 'on-hold') return;
      patch(id, (b) => ({ ...b, local: { status: 'on-shelf' } }));
      void setLocalState(id, { status: 'on-shelf' });
      flashSlip({ kind: 'note', stamp: 'CANCELLED', text: `${book.title} taken off hold.` });
    },

    showSlip: flashSlip,
    dismissSlip: () => {
      clearTimeout(slipTimer);
      set({ slip: null });
    },
    dismissConfirm: () => set({ confirm: null }),

    recordProgress: (id, positionSec, options = {}) => {
      const book = get().books.find((b) => b.id === id);
      if (!book) return;

      // Clamped once, here, and used for both the memory and the database. The
      // database was being given the raw figure while only the in-memory copy
      // was clamped, so a seek past the end could store a position beyond the
      // book's own duration — and that is the figure a relaunch reads back.
      const clamped = Math.max(0, Math.min(book.durationSec, Math.round(positionSec)));
      const finishedAt =
        clamped >= book.durationSec - 1
          ? (book.finishedAt ?? new Date().toISOString())
          : book.finishedAt;

      void updateProgress(id, clamped, finishedAt);

      /*
       * Replacing the book in memory is the expensive half — the Library
       * derives its shelves from this array — so it waits for a moment that
       * matters: a pause, a stop, the end of the book, or the app going to the
       * background. The database is written every time, so nothing is at risk.
       */
      if (options.commit ?? true) {
        patch(id, (b) => ({
          ...b,
          progressSec: clamped,
          lastPlayedAt: new Date().toISOString(),
          finishedAt,
        }));
      }
    },
  };
});

/**
 * Convenience selectors. Each must return a stable value — zustand v5 re-renders
 * for ever if a selector builds a new array or object on every call, so a
 * filtered list is derived with `useMemo` in the component instead.
 */
export const selectBook = (id: string | undefined) => (s: LibraryState) =>
  id ? s.books.find((b) => b.id === id) : undefined;

export const selectTotalBooks = (s: LibraryState) => s.books.length;

export const selectTotalDuration = (s: LibraryState) =>
  s.books.reduce((sum, b) => sum + b.durationSec, 0);

/** Plain helpers over an already-selected `books` array. */
export const checkedOutFrom = (books: Book[]) =>
  books.filter((b) => b.local.status !== 'on-shelf');

export const onShelfCount = (books: Book[]) =>
  books.reduce((n, b) => (b.local.status === 'on-shelf' ? n + 1 : n), 0);

export const heldCount = (books: Book[]) =>
  books.reduce((n, b) => (b.local.status === 'on-hold' ? n + 1 : n), 0);
