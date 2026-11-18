/**
 * Library — the main screen. Shelves above, checked-out books pinned below.
 *
 * Everything here comes from the database. Before a folder has been chosen the
 * screen is the first-run prompt instead; when the drive is unreachable the
 * shelves stay browsable from cached covers and a banner explains holds.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Book } from '@/data/types';
import { belongsToSource, isCheckedOut, isRemote } from '@/data/types';
import {
  checkedOutFrom,
  heldCount,
  holdBytes,
  librarySizeBytes,
  selectTotalBooks,
  selectTotalDuration,
  usedBytes,
  useLibrary,
} from '@/store/library';
import { useScan } from '@/store/scan';
import { useShelves } from '@/store/shelves';
import { DragGhost, useShelfDrag } from '@/components/ShelfDrag';
import { NewShelfRow, ShelfNameSheet } from '@/components/ShelfNameSheet';
import { useUi } from '@/store/ui';
import { switchableSources, useSources } from '@/store/sources';
import { USB_SOURCE_ID } from '@/db/sources';
import { useMiniPlayerInset } from '@/components/MiniPlayer';
import { safFolderPath } from '@/lib/files/safNames';
import {
  buildShelves,
  effectiveSort,
  seedShelvesFromLength,
  type CustomShelf,
  type Shelf as ShelfModel,
} from '@/lib/shelves';
import { cascade } from '@/lib/library/cascade';
import { trayGroups } from '@/lib/library/tray';
import { searchBooks } from '@/lib/library/search';
import { daysOfListening, relativeTime, relativeTimeShort } from '@/lib/format';
import { color, font, space } from '@/theme/tokens';
import { useTheme } from '@/store/theme';
import { CheckedOutTray } from '@/components/CheckedOutTray';
import { CheckoutHint } from '@/components/CheckoutHint';
import { DriveNotConnected } from '@/components/DriveNotConnected';
import { FirstRun, ScanProgressBar, ScanningLibrary } from '@/components/FirstRun';
import { NoSearchResults } from '@/components/NoSearchResults';
import { LibraryHeader } from '@/components/LibraryHeader';
import { Shelf } from '@/components/Shelf';

export default function LibraryScreen() {
  /*
   * Subscribed so a change of scheme repaints this screen.
   *
   * The colours themselves live in a module object that swaps in place, so
   * nothing here reads them differently — but a component that does not run
   * again keeps what it last painted. One line per screen, and everything
   * the screen renders comes with it.
   */
  const paletteVersion = useTheme((s) => s.version);
  const insets = useSafeAreaInsets();
  const [checkingDrive, setCheckingDrive] = useState(false);
  const [search, setSearch] = useState('');
  const setBottomObstruction = useUi((s) => s.setBottomObstruction);
  const activeSourceId = useUi((s) => s.activeSourceId);
  const setActiveSourceId = useUi((s) => s.setActiveSourceId);
  const customShelves = useShelves((s) => s.shelves);
  const loadShelvesFor = useShelves((s) => s.load);
  const placeOnShelf = useShelves((s) => s.place);
  const addShelf = useShelves((s) => s.add);
  const seedShelves = useShelves((s) => s.seed);
  const moveShelfBy = useShelves((s) => s.moveShelf);
  const checkoutHintDone = useUi((s) => s.checkoutHintDone);
  const markCheckoutHintDone = useUi((s) => s.markCheckoutHintDone);
  const trayCollapsed = useUi((s) => s.trayCollapsed);
  const setTrayCollapsed = useUi((s) => s.setTrayCollapsed);
  const sources = useSources((s) => s.sources);

  const loadSources = useSources((s) => s.load);
  /** The docked player sits above the tray; the shelves clear both. */
  const miniPlayerInset = useMiniPlayerInset();

  const ready = useLibrary((s) => s.ready);
  const startupError = useLibrary((s) => s.startupError);
  const books = useLibrary((s) => s.books);
  const sort = useLibrary((s) => s.sort);
  const setSort = useLibrary((s) => s.setSort);
  const budgetBytes = useLibrary((s) => s.budgetBytes);
  const libraryRoot = useLibrary((s) => s.libraryRoot);
  const driveConnected = useLibrary((s) => s.driveConnected);
  const libraryOnDevice = useLibrary((s) => s.libraryOnDevice);
  const driveLastSeenAt = useLibrary((s) => s.driveLastSeenAt);
  const lookForDrive = useLibrary((s) => s.lookForDrive);

  const checkOut = useLibrary((s) => s.checkOut);
  const cancelCopy = useLibrary((s) => s.cancelCopy);
  const pendingDriveImports = useLibrary((s) => s.pendingDriveImports);
  const pushImportsToDrive = useLibrary((s) => s.pushImportsToDrive);
  const dismissDriveImportOffer = useLibrary((s) => s.dismissDriveImportOffer);
  const returnBook = useLibrary((s) => s.returnBook);

  const totalBooks = useLibrary(selectTotalBooks);
  const totalDuration = useLibrary(selectTotalDuration);

  const scanRunning = useScan((s) => s.running);
  const scanPreparing = useScan((s) => s.preparing);
  const scanProgress = useScan((s) => s.progress);
  // Picking a folder, checking it and scanning it are one wait to the user.
  const scanBusy = scanRunning || scanPreparing;
  const chooseFolderAndScan = useScan((s) => s.chooseFolderAndScan);

  // Shelves show everything, so a checked-out book keeps its place in the
  // stacks with an "OUT" tag rather than vanishing from where the user left it.
  /*
   * One library at a time, shelves and tray alike.
   *
   * A book's source is where it is kept, and mixing two of them into one set
   * of generated shelves would produce a "6 hours or less" shelf containing
   * books you cannot reach.
   *
   * **The tray is not scoped, and that is a reversal.** It was global, then
   * per-source, and per-source turned out worse: a book downloaded from a
   * server that was later removed belonged to no library you could switch to,
   * so it appeared nowhere while still holding gigabytes. It is global again,
   * in labelled groups — see `src/lib/library/tray.ts`. Shelves stay scoped,
   * because mixing two libraries into one set of generated shelves really
   * does produce a "6 hours or less" shelf full of books you cannot reach.
   */
  const inSource = useMemo(
    () => books.filter((b) => belongsToSource(b, activeSourceId, USB_SOURCE_ID)),
    [books, activeSourceId],
  );

  // Derived here rather than in a store selector: a selector that builds a new
  // array every call re-renders without end under zustand v5.
  const onHoldCount = useMemo(() => heldCount(inSource), [inSource]);

  /** The servers signed into, for the tray's groups and their labels. */
  const absServers = useMemo(
    () => sources.filter((s) => s.kind === 'abs').map(({ id, label }) => ({ id, label })),
    [sources],
  );

  /*
   * Every book on the phone, grouped by where it came from — not just the
   * library being looked at. A book from a removed server lands in its own
   * group rather than vanishing, which is the whole reason this is not scoped.
   */
  const trayStacks = useMemo(
    () => trayGroups(books, { driveSourceId: USB_SOURCE_ID, servers: absServers }),
    [books, absServers],
  );
  // Global too: the hint is about whether anything at all has been taken out.
  const checkedOut = useMemo(() => checkedOutFrom(books), [books]);

  /*
   * The ruler measures the whole phone, and now agrees with the fan above it.
   *
   * It used to measure the active library's share, because the tray did — and
   * the note here said the alternative was "a ruler that disagreed with the
   * fan above it, which is worse". With the tray showing everything, that
   * objection is gone and the ruler says what the budget was always about:
   * this phone.
   */
  const used = usedBytes(books);
  const heldBytes = holdBytes(books);

  // What the folder takes up, for a library that is already in phone storage.
  const onDeviceBooks = useMemo(() => inSource.filter((b) => !isRemote(b)), [inSource]);
  const libraryBytes = useMemo(() => librarySizeBytes(inSource), [inSource]);
  // The picker's name is the last segment only, which could be anywhere.
  const libraryPath = libraryRoot
    ? safFolderPath(libraryRoot.uri) || libraryRoot.name
    : '';
  const found = useMemo(() => searchBooks(inSource, search), [inSource, search]);

  /*
   * Shelves belong to a source, so they are reloaded when it changes.
   *
   * `USB_SOURCE_ID` is the Library's name for the drive; the tables use
   * NULL for it, matching `books`. Translated here rather than in the
   * store, so the store speaks the database's language throughout.
   */
  useEffect(() => {
    void loadShelvesFor(activeSourceId === USB_SOURCE_ID ? null : activeSourceId);
  }, [activeSourceId, loadShelvesFor]);

  /*
   * Custom mode starts from the by-length shelves.
   *
   * Seeded the first time it is opened for a source, and never again — the
   * store checks the database rather than its own state, so opening twice
   * quickly cannot seed twice. It writes on a view, which is unusual, but
   * the alternative is a wall of books belonging to nothing and a shelf to
   * invent before anything can be arranged.
   *
   * `inSource`, not the searched list: seeding half a library because a
   * search box had something in it would be a mess to undo by hand.
   */
  useEffect(() => {
    if (sort !== 'custom' || inSource.length === 0) return;
    void seedShelves(
      activeSourceId === USB_SOURCE_ID ? null : activeSourceId,
      seedShelvesFromLength(inSource),
    );
  }, [sort, inSource, activeSourceId, seedShelves]);


  const customRows = useMemo<CustomShelf[]>(
    () => customShelves.map((s) => ({ id: s.id, name: s.name, bookIds: s.bookIds })),
    [customShelves],
  );

  /*
   * The list, for the drag to scroll and to measure against.
   *
   * A shelf's `onLayout` gives its box in content coordinates; a finger
   * arrives in page coordinates. The drag turns one into the other, which
   * needs where the list starts on screen and how far it has scrolled.
   */
  const listRef = useRef<FlatList<ShelfModel> | null>(null);
  const scrolled = useRef(0);

  const scrollBy = useCallback((delta: number) => {
    /*
     * The offset is advanced here as well as read from `onScroll`.
     *
     * Edge scrolling ticks every 16ms and `onScroll` is throttled to the
     * same, so reading back the last reported offset meant ticks landing on
     * a stale number and cancelling each other out. Advancing it optimistically
     * lets the ticks accumulate; the next real `onScroll` corrects any drift.
     */
    const next = Math.max(0, scrolled.current + delta);
    scrolled.current = next;
    listRef.current?.scrollToOffset({ offset: next, animated: false });
  }, []);

  const { drag, handlersFor, measure, retainBoxes, setViewport, setScrollOffset } = useShelfDrag({
    onDrop: (bookId, shelfId) => void placeOnShelf(bookId, shelfId),
    scrollBy,
  });
  /*
   * What the shelves would look like if the finger let go here.
   *
   * The cascade runs on every frame and the Library is drawn from its
   * result, so pushing a book onto a full shelf shows the far one sliding
   * down while you are still deciding. The same function commits the drop,
   * so what is written is what was on screen.
   *
   * **The dragged book itself is pinned where it started.** This is not
   * cosmetic. The gesture lives on a responder attached to that book's
   * cover, and moving the book to another shelf in the preview unmounts
   * the cover from one row and mounts a new one in another — which
   * terminates the gesture mid-drag, so the finger coming up never
   * reaches `onPanResponderRelease` and the drop is never committed. It
   * looked exactly like dragging not working at all.
   *
   * So the preview shows the consequences — the far book sliding down the
   * shelves — while the dragged book stays faded in its own slot and the
   * ghost under the finger shows where it is going. The green ledge says
   * where it will land.
   */
  const previewRows = useMemo<CustomShelf[]>(() => {
    if (!drag || !drag.overShelfId) return customRows;

    const origin = customRows.find((s) => s.bookIds.includes(drag.bookId));
    const at = origin ? origin.bookIds.indexOf(drag.bookId) : -1;
    const names = new Map(customRows.map((s) => [s.id, s.name]));

    const moved = cascade(customRows, drag.bookId, drag.overShelfId).shelves;
    return moved.map((s) => {
      const without = s.bookIds.filter((id) => id !== drag.bookId);
      const bookIds =
        origin && s.id === origin.id
          ? [...without.slice(0, at), drag.bookId, ...without.slice(at)]
          : without;
      return { id: s.id, name: names.get(s.id) ?? '', bookIds };
    });
  }, [customRows, drag]);
  /*
   * A custom arrangement holding nothing gives way to the default.
   *
   * Shelves whose books were re-minted by a rescan hold ids that resolve to
   * nothing, and the Library would show a row of empty ledges. Better the
   * books back under the default sort while the seeding repairs the
   * arrangement underneath.
   */
  const liveBookIds = useMemo(() => new Set(found.map((b) => b.id)), [found]);
  /*
   * What the shelves are actually in — and therefore what the picker has to
   * say. Showing the saved `sort` there while rendering this one made the chip
   * read "Custom" over shelves in length order.
   *
   * The saved preference is deliberately left alone. Custom is where the
   * listener put themselves, the fallback is temporary cover while the seeding
   * repairs the arrangement, and overwriting the setting would turn a bad
   * scan into a lost choice.
   */
  const shownSort = effectiveSort(sort, liveBookIds, previewRows);
  const shelves = useMemo(
    () => buildShelves(found, shownSort, previewRows),
    [found, shownSort, previewRows],
  );
  const searching = search.trim().length > 0;

  /**
   * Offers to put books added from the phone onto the drive, once it is back.
   * Asked once per set, so declining does not nag on every reconnect.
   */
  const offeredFor = useRef('');
  useEffect(() => {
    const key = pendingDriveImports.map((b) => b.id).sort().join(',');
    if (!key || offeredFor.current === key) return;
    offeredFor.current = key;
    const count = pendingDriveImports.length;
    Alert.alert(
      `Add ${count} ${count === 1 ? 'book' : 'books'} to the drive?`,
      `${pendingDriveImports.map((b) => b.title).join(', ')} ${count === 1 ? 'was' : 'were'} ` +
        'added from this phone and is not on the drive yet. Copying it across means it is ' +
        'backed up by the drive, and can be returned from your phone safely.',
      [
        { text: 'Not now', style: 'cancel', onPress: dismissDriveImportOffer },
        { text: 'Add to drive', onPress: () => void pushImportsToDrive() },
      ],
    );
  }, [pendingDriveImports, pushImportsToDrive, dismissDriveImportOffer]);

  // Which libraries exist to switch between. Just the drive, until a server
  // is configured in Settings.
  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const switchable = useMemo(
    () => switchableSources(sources, driveConnected),
    [sources, driveConnected],
  );
  const refreshCatalogue = useSources((s) => s.refreshCatalogue);
  const refreshingSource = useSources((s) => s.refreshing);
  /*
   * A removed source leaves its id behind in the stored preference. Falling
   * back to the drive is better than an empty screen that cannot be left.
   */
  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;
  const onRemote = activeSourceId !== USB_SOURCE_ID && activeSource !== null;

  /*
   * Every book opens on the Book screen, wherever it came from.
   *
   * A server book used to open on a plain screen of its own, because at
   * the time it was an inert catalogue entry: no audio, no parts, and the
   * Book screen's whole vocabulary — check out, return, put on hold — meant
   * nothing for it. Downloading changed that. It now has parts, chapters,
   * a position and notes, and checks out through the same queue; it is a
   * book. Two screens for one thing is what produced a loop between the
   * player and the book, and the fix is to stop having two.
   */
  const openBook = useCallback((book: Book) => router.push(`/book/${book.id}`), []);

  /**
   * Tapping the status looks for the drive there and then, rather than sending
   * the user to Settings to press a second button.
   */
  /**
   * Look at whichever source is showing. The drive for the drive, a catalogue
   * refresh for a server: both answer "can this actually be reached", which
   * is the question the light is reporting on.
   */
  const recheckSource = (source: { id: string; kind: string }) => {
    if (source.kind === 'usb') {
      recheckDrive();
      return;
    }
    void refreshCatalogue(source.id);
  };

  const recheckDrive = () => {
    // The spinner state is this screen's; the looking and the answer are the
    // store's, so Settings behaves identically. See `lookForDrive`.
    if (checkingDrive) return;
    setCheckingDrive(true);
    void (async () => {
      try {
        await lookForDrive();
      } finally {
        setCheckingDrive(false);
      }
    })();
  };

  // The shelf callbacks are memoised so that scrolling, which re-renders this
  // screen as rows come and go, does not hand every mounted shelf a new set of
  // props and undo the work `React.memo` does on them.
  const onPressBook = useCallback((book: Book) => openBook(book), [openBook]);

  const onMoveBook = useCallback(
    (book: Book) => {
      if (isCheckedOut(book)) returnBook(book.id);
      else checkOut(book.id);
    },
    [returnBook, checkOut],
  );

  const onCancelCopy = useCallback((book: Book) => cancelCopy(book.id), [cancelCopy]);


  /*
   * Custom mode is the whole condition now; there is no edit mode.
   *
   * There was one, because press and hold already checked a book out and a
   * gesture cannot mean two things. A grip of its own solves that without
   * a mode: hold the grip to drag, hold anywhere else to check out. One
   * fewer state to be in, and the shelf names are editable whenever you
   * are looking at them.
   */
  const arranging = shownSort === 'custom';

  /*
   * Anyone holding a book has already found the gesture.
   *
   * Covers the reader who had the "+" before it went, and anyone who
   * worked it out without being told — neither should be shown a hint
   * about something they are plainly doing.
   */
  useEffect(() => {
    if (!checkoutHintDone && checkedOut.length > 0) markCheckoutHintDone();
  }, [checkoutHintDone, checkedOut.length, markCheckoutHintDone]);

  const hint =
    checkoutHintDone || checkedOut.length > 0 ? null : (
      <CheckoutHint onDismiss={markCheckoutHintDone} />
    );

  /*
   * Forget the rows that are gone, and keep the ones still up.
   *
   * This runs on every frame of a drag, because the preview makes a new
   * row array each time — so it must not throw away boxes that are still
   * true. A row only re-measures itself when its layout changes, and a
   * box nobody replaces is a row that cannot be found.
   */
  useEffect(() => {
    retainBoxes(shelves.map((row) => row.key));
  }, [shelves, retainBoxes]);

  /*
   * Naming a shelf: `null` id means a new one, which is the same question
   * with an empty starting value.
   */
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const promptNewShelf = () => setNaming({ id: null, name: '' });
  const renameShelfAt = useShelves((s) => s.rename);
  const removeShelfAt = useShelves((s) => s.remove);
  const shelfSourceId = activeSourceId === USB_SOURCE_ID ? null : activeSourceId;
  /*
   * Stable, with no dependencies, and that is the point.
   *
   * Every row used to get a fresh arrow for this, so `Shelf`'s `memo`
   * compared unequal props and redrew every mounted shelf on every frame
   * of a drag. That is the half-second of treacle a second into picking a
   * book up. The name is read from the store at the moment it is wanted
   * instead of closed over, which is what lets the callback never change.
   */
  const onMoveShelf = useCallback(
    (shelfId: string, by: -1 | 1) => void moveShelfBy(shelfId, by),
    [moveShelfBy],
  );

  const onRenameShelf = useCallback(
    (shelfId: string, name: string) => setNaming({ id: shelfId, name }),
    // A setState function never changes, so this stays one callback for the
    // life of the screen. Listed because the compiler infers it and refuses
    // to optimise the component over the discrepancy.
    [setNaming],
  );


  /*
   * Not wrapped in `useCallback` any more.
   *
   * It was, for the reason in the note on `Shelf`'s `memo`: redrawing every
   * mounted shelf as the list scrolls is what made scrolling stutter. But
   * the drag made the hand-written memo unpreservable, and the compiler's
   * answer to that is to skip the whole component — no memoization at all
   * rather than slightly wrong memoization. `Shelf` is still `memo`'d on
   * its props, which is what actually stops the redraw.
   */
  const renderShelf = ({ item }: { item: ShelfModel }) => (
    <Shelf
        shelf={item}
        onPressBook={onPressBook}
        /*
         * Press and hold is the only way a book moves to or from the phone.
         *
         * There was a "+" tab in the corner of every cover as well. It went:
         * it sat on the art, it needed its own touch target on a thumbnail,
         * and everything it showed — OUT, HOLD, DONE — is already a tag on
         * the cover, so it was a button wearing a status badge's clothes.
         *
         * The same gesture everywhere, including a library already on the
         * phone. Checkout is refused there, and the refusal says why — "it
         * is already on this phone, open it and press play" — which is a
         * better answer to the gesture than quietly doing something else.
         */
        onLongPressBook={onMoveBook}
        onCancelCopy={onCancelCopy}
        /*
         * Only while arranging. Out of edit mode a shelf is exactly what it
         * was, responders and measuring included, so the common case pays
         * nothing for a feature it is not using.
         */
        dragHandlersFor={arranging ? handlersFor : undefined}
        onMeasure={arranging ? measure : undefined}
        isDropTarget={!!drag && !!item.shelfId && item.shelfId === drag.overShelfId}
        liftedBookId={drag?.bookId ?? null}
        paletteVersion={paletteVersion}
        // Only a hand-arranged shelf has a name to change. The loose pile
        // is not a shelf, and a generated label is not ours to rewrite.
        onRenameShelf={arranging ? onRenameShelf : undefined}
        onMoveShelf={arranging ? onMoveShelf : undefined}
        canMoveUp={!!item.shelfId && item.shelfId !== customShelves[0]?.id}
        canMoveDown={
          !!item.shelfId && item.shelfId !== customShelves[customShelves.length - 1]?.id
        }
      />
  );

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: color.ground }} />;
  }

  if (startupError) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: color.ground,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xxl,
          gap: space.md,
        }}
      >
        <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
          The library wouldn&apos;t open.
        </Text>
        <Text
          style={{
            fontFamily: font.mono,
            fontSize: 12,
            color: color.warning,
            textAlign: 'center',
          }}
        >
          {startupError}
        </Text>
      </View>
    );
  }

  /*
   * A server source: the same shelves, built from that library's books.
   *
   * The checked-out tray is at the bottom here too, and deliberately shows
   * the same books as on the drive. What is on the phone is on the phone,
   * whichever library it came from — and the tray is what the mini player
   * measures itself against. Leaving it out stranded the player in the
   * middle of the screen, floating over nothing, because the obstruction
   * it had been told about belonged to a screen that was no longer showing.
   */
  if (onRemote && activeSource) {
    const busy = refreshingSource[activeSource.id] === true;
    const subtitle = activeSource.config.needsSignIn
      ? 'Sign in again in Settings'
      : busy
        ? 'Reading the catalogue…'
        : `${inSource.length} ${inSource.length === 1 ? 'book' : 'books'}` +
          (activeSource.lastSeenAt ? ` · checked ${relativeTimeShort(activeSource.lastSeenAt)}` : '');

    return (
      <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
        <LibraryHeader
          title={activeSource.config.absLibraryName ?? activeSource.label}
          subtitle={subtitle}
          connected={false}
          onCheckDrive={() => void refreshCatalogue(activeSource.id)}
          checking={busy}
          onOpenSettings={() => router.push('/settings')}
          sources={switchable}
          activeSourceId={activeSourceId}
          onSelectSource={setActiveSourceId}
          sort={shownSort}
          onSort={setSort}
          search={search}
          onSearch={setSearch}
        />

        {inSource.length === 0 ? (
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              padding: space.xxl,
              gap: space.sm,
            }}
          >
            <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
              {activeSource.label}
            </Text>
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: color.muted,
                textAlign: 'center',
              }}
            >
              {activeSource.config.needsSignIn
                ? 'Sign in again in Settings.'
                : busy
                  ? 'Reading the catalogue…'
                  : 'Nothing here yet. Settings → Check again reads the catalogue.'}
            </Text>
          </View>
        ) : searching && found.length === 0 ? (
          <NoSearchResults query={search} total={inSource.length} onClear={() => setSearch('')} />
        ) : (
          <FlatList
            style={{ flex: 1 }}
            data={shelves}
            keyExtractor={(shelf) => shelf.key}
            renderItem={renderShelf}
            contentContainerStyle={{ paddingBottom: 28 + miniPlayerInset }}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={7}
            ref={listRef}
            ListHeaderComponent={hint}
            scrollEnabled={!drag}
            scrollEventThrottle={16}
            onScroll={(e) => {
              scrolled.current = e.nativeEvent.contentOffset.y;
              setScrollOffset(scrolled.current);
            }}
            onLayout={(e) => {
              e.currentTarget.measure?.((_x, _y, _w, h, _px, py) => setViewport(py ?? 0, h));
            }}
            ListFooterComponent={
              arranging ? <NewShelfRow onPress={promptNewShelf} /> : null
            }
          />
        )}

        <View onLayout={(e) => setBottomObstruction(e.nativeEvent.layout.height)}>
          <CheckedOutTray
            groups={trayStacks}
            usedBytes={used}
            holdBytes={heldBytes}
            budgetBytes={budgetBytes}
            onPressBook={openBook}
            onLongPressBook={onMoveBook}
            showRuler
            collapsed={trayCollapsed}
            onToggleCollapsed={() => setTrayCollapsed(!trayCollapsed)}
            onDevice={libraryOnDevice && !onRemote}
            libraryCount={onDeviceBooks.length}
            libraryBytes={libraryBytes}
            libraryPath={libraryPath}
          />
          <View style={{ height: insets.bottom, backgroundColor: color.panel }} />
        </View>
        {/* Over everything, because a lifted book has to clear the tray too. */}
        <DragGhost drag={drag} books={inSource} />
        <ShelfNameSheet
          visible={!!naming}
          shelfId={naming?.id ?? null}
          initialName={naming?.name ?? ''}
          onSave={(name) => {
            const target = naming;
            setNaming(null);
            if (!target) return;
            void (target.id
              ? renameShelfAt(target.id, name)
              : addShelf(shelfSourceId, name));
          }}
          onDelete={() => {
            const target = naming;
            setNaming(null);
            if (target?.id) void removeShelfAt(target.id);
          }}
          onCancel={() => setNaming(null)}
        />
      </View>
    );
  }

  // Nothing has been indexed yet: ask for the folder.
  if (!libraryRoot || (books.length === 0 && !scanBusy)) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
        <LibraryHeader
          title="Library"
          subtitle={libraryRoot ? 'No books indexed yet' : 'No library folder chosen'}
          connected={driveConnected}
          onCheckDrive={recheckDrive}
          checking={checkingDrive || !!refreshingSource[activeSourceId]}
          onOpenSettings={libraryRoot ? () => router.push('/settings') : undefined}
          sources={switchable}
          activeSourceId={activeSourceId}
          onSelectSource={setActiveSourceId}
          onCheckSource={recheckSource}
        />
        {scanProgress && scanBusy ? <ScanProgressBar progress={scanProgress} /> : null}
        <FirstRun onPick={() => void chooseFolderAndScan()} busy={scanBusy} />
      </View>
    );
  }

  // While searching, the count is the useful fact — "3 of 412" answers both
  // "did it find anything" and "is this all of them".
  const holdNote = onHoldCount > 0 ? ` · ${onHoldCount} on hold` : '';
  const subtitle = searching
    ? `${found.length} of ${books.length} ${books.length === 1 ? 'book' : 'books'}`
    : driveConnected
      ? `${totalBooks} ${totalBooks === 1 ? 'book' : 'books'} · ${daysOfListening(totalDuration)}${holdNote}`
      : `last seen ${relativeTimeShort(driveLastSeenAt)} · ${totalBooks} books${holdNote}`;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <LibraryHeader
        title="Library"
        subtitle={subtitle}
        connected={driveConnected}
        lastSeenLabel={relativeTime(driveLastSeenAt)}
        onCheckDrive={recheckDrive}
        checking={checkingDrive || !!refreshingSource[activeSourceId]}
        onOpenSettings={() => router.push('/settings')}
        onCheckSource={recheckSource}
        sort={shownSort}
        onSort={setSort}
        search={search}
        onSearch={setSearch}
        sources={switchable}
        activeSourceId={activeSourceId}
        onSelectSource={setActiveSourceId}
      />

      {scanProgress && scanBusy ? <ScanProgressBar progress={scanProgress} /> : null}

      {books.length === 0 ? (
        // A scan in flight is the one reason the shelves can be empty while a
        // folder is chosen: books are not loaded until it finishes.
        scanBusy ? (
          <ScanningLibrary progress={scanProgress} />
        ) : (
          <DriveNotConnected heldCount={onHoldCount} />
        )
      ) : searching && found.length === 0 ? (
        <NoSearchResults query={search} total={books.length} onClear={() => setSearch('')} />
      ) : (
        /*
         * Virtualized, not a ScrollView: 400 books is 134 shelves and several
         * hundred megabytes of decoded bitmap if they all mount at once.
         *
         * Two settings are deliberate. No `getItemLayout`, because shelf
         * height varies with the label card's wrapping. And
         * `removeClippedSubviews` stays off, because tags and ribbons sit
         * outside their row's bounds and clipping eats them.
         */
        <FlatList
          style={{ flex: 1 }}
          data={shelves}
          keyExtractor={(shelf) => shelf.key}
          renderItem={renderShelf}
          contentContainerStyle={{ paddingBottom: 28 + miniPlayerInset }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={false}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={7}
          ref={listRef}
          ListHeaderComponent={hint}
          scrollEnabled={!drag}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrolled.current = e.nativeEvent.contentOffset.y;
            setScrollOffset(scrolled.current);
          }}
          onLayout={(e) => {
            e.currentTarget.measure?.((_x, _y, _w, h, _px, py) => setViewport(py ?? 0, h));
          }}
          /*
           * No disconnected-drive banner: the header's drive button and
           * subtitle already say it, and the drive being unplugged is the
           * app's normal condition rather than news. The held count moved into
           * the subtitle.
           *
           * While arranging, the folder's name gives way to the one control
           * the mode needs that is not a drag.
           */
          ListFooterComponent={
            arranging ? (
              <NewShelfRow onPress={promptNewShelf} />
            ) : (
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: font.mono,
                  fontSize: 11,
                  color: color.faint,
                  textAlign: 'center',
                  paddingTop: space.xl,
                  paddingHorizontal: space.xl,
                }}
              >
                {libraryRoot.name}
              </Text>
            )
          }
        />
      )}

      <View
        // Measured once rather than guessed: the mini player and the paper
        // slip both stack above whatever this screen pins to the bottom.
        onLayout={(e) => setBottomObstruction(e.nativeEvent.layout.height)}
      >
        <CheckedOutTray
          groups={trayStacks}
          usedBytes={used}
          holdBytes={heldBytes}
          budgetBytes={budgetBytes}
          onPressBook={openBook}
          onLongPressBook={onMoveBook}
          showRuler
          collapsed={trayCollapsed}
          onToggleCollapsed={() => setTrayCollapsed(!trayCollapsed)}
          onDevice={libraryOnDevice && !onRemote}
          libraryCount={onDeviceBooks.length}
          libraryBytes={libraryBytes}
          libraryPath={libraryPath}
        />
        <View style={{ height: insets.bottom, backgroundColor: color.panel }} />
      </View>
      {/* Over everything, because a lifted book has to clear the tray too. */}
      <DragGhost drag={drag} books={inSource} />
      <ShelfNameSheet
        visible={!!naming}
        shelfId={naming?.id ?? null}
        initialName={naming?.name ?? ''}
        onSave={(name) => {
          const target = naming;
          setNaming(null);
          if (!target) return;
          void (target.id
            ? renameShelfAt(target.id, name)
            : addShelf(shelfSourceId, name));
        }}
        onDelete={() => {
          const target = naming;
          setNaming(null);
          if (target?.id) void removeShelfAt(target.id);
        }}
        onCancel={() => setNaming(null)}
      />
    </View>
  );
}
