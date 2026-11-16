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
import { useUi } from '@/store/ui';
import { switchableSources, useSources } from '@/store/sources';
import { USB_SOURCE_ID } from '@/db/sources';
import { useMiniPlayerInset } from '@/components/MiniPlayer';
import { safFolderPath } from '@/lib/files/safNames';
import { buildShelves } from '@/lib/shelves';
import { searchBooks } from '@/lib/library/search';
import { daysOfListening, relativeTime, relativeTimeShort } from '@/lib/format';
import { color, font, space } from '@/theme/tokens';
import { CheckedOutTray } from '@/components/CheckedOutTray';
import { DriveNotConnected } from '@/components/DriveNotConnected';
import { FirstRun, ScanProgressBar, ScanningLibrary } from '@/components/FirstRun';
import { NoSearchResults } from '@/components/NoSearchResults';
import { LibraryHeader } from '@/components/LibraryHeader';
import { Shelf } from '@/components/Shelf';
import type { Shelf as ShelfModel } from '@/lib/shelves';

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const [checkingDrive, setCheckingDrive] = useState(false);
  const [search, setSearch] = useState('');
  const setBottomObstruction = useUi((s) => s.setBottomObstruction);
  const activeSourceId = useUi((s) => s.activeSourceId);
  const setActiveSourceId = useUi((s) => s.setActiveSourceId);
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
  const checkDrive = useLibrary((s) => s.checkDrive);
  const showSlip = useLibrary((s) => s.showSlip);

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
   * The tray was global once — what is on the phone is on the phone, whichever
   * library it came from. That broke down as soon as a second source could put
   * books on the phone: standing in an Audiobookshelf library and seeing the
   * drive's checkouts in the tray below answers a question nobody asked. A
   * library's tray now holds that library's books, and a book downloaded from
   * a server appears under that server.
   */
  const inSource = useMemo(
    () => books.filter((b) => belongsToSource(b, activeSourceId, USB_SOURCE_ID)),
    [books, activeSourceId],
  );

  // Derived here rather than in a store selector: a selector that builds a new
  // array every call re-renders without end under zustand v5.
  const checkedOut = useMemo(() => checkedOutFrom(inSource), [inSource]);
  const onHoldCount = useMemo(() => heldCount(inSource), [inSource]);

  /*
   * The ruler measures this library's share of the budget.
   *
   * The budget itself is global, because it is about the phone — so with
   * downloads in more than one source, no single tray shows everything the
   * phone is holding. The alternative was a ruler that disagreed with the fan
   * above it, which is worse: a reader can switch libraries to see the rest.
   */
  const used = usedBytes(inSource);
  const heldBytes = holdBytes(inSource);

  // What the folder takes up, for a library that is already in phone storage.
  const onDeviceBooks = useMemo(() => inSource.filter((b) => !isRemote(b)), [inSource]);
  const libraryBytes = useMemo(() => librarySizeBytes(inSource), [inSource]);
  // The picker's name is the last segment only, which could be anywhere.
  const libraryPath = libraryRoot
    ? safFolderPath(libraryRoot.uri) || libraryRoot.name
    : '';
  const found = useMemo(() => searchBooks(inSource, search), [inSource, search]);
  const shelves = useMemo(() => buildShelves(found, sort), [found, sort]);
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

  const switchable = useMemo(() => switchableSources(sources), [sources]);
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
  const recheckDrive = () => {
    if (checkingDrive) return;
    setCheckingDrive(true);
    void (async () => {
      /*
       * Held on screen for a moment, whatever the answer.
       *
       * Looking for the drive is a single directory listing and usually
       * finishes in a few milliseconds, so the slip saying it is not connected
       * appeared to arrive before the tap had landed — it read as a button
       * that did not check anything. Long enough for the arrow to turn once.
       */
      const [connected] = await Promise.all([
        checkDrive(),
        new Promise((resolve) => setTimeout(resolve, 650)),
      ]);
      setCheckingDrive(false);
      // `checkDrive` already announces anything it picked up off hold.
      if (!useLibrary.getState().slip) {
        showSlip(
          connected
            ? { kind: 'note', stamp: 'DRIVE CONNECTED', text: 'Drive found. The shelves are live.' }
            : {
                kind: 'note',
                stamp: 'DRIVE NOT CONNECTED',
                text: "Still can't see the drive. Checked-out books keep playing.",
              },
        );
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

  const renderShelf = useCallback(
    ({ item }: { item: ShelfModel }) => (
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
      />
    ),
    [onPressBook, onMoveBook, onCancelCopy],
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
          sort={sort}
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
          />
        )}

        <View onLayout={(e) => setBottomObstruction(e.nativeEvent.layout.height)}>
          <CheckedOutTray
            books={checkedOut}
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
          checking={checkingDrive}
          onOpenSettings={libraryRoot ? () => router.push('/settings') : undefined}
          sources={switchable}
          activeSourceId={activeSourceId}
          onSelectSource={setActiveSourceId}
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
        checking={checkingDrive}
        onOpenSettings={() => router.push('/settings')}
        sort={sort}
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
          /*
           * No disconnected-drive banner: the header's drive button and
           * subtitle already say it, and the drive being unplugged is the
           * app's normal condition rather than news. The held count moved into
           * the subtitle.
           */
          ListFooterComponent={
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
          }
        />
      )}

      <View
        // Measured once rather than guessed: the mini player and the paper
        // slip both stack above whatever this screen pins to the bottom.
        onLayout={(e) => setBottomObstruction(e.nativeEvent.layout.height)}
      >
        <CheckedOutTray
          books={checkedOut}
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
    </View>
  );
}
