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
import { isCheckedOut } from '@/data/types';
import {
  checkedOutFrom,
  committedBytes,
  heldCount,
  holdBytes,
  onShelfCount,
  selectTotalBooks,
  selectTotalDuration,
  usedBytes,
  useLibrary,
} from '@/store/library';
import { useScan } from '@/store/scan';
import { useUi } from '@/store/ui';
import { buildShelves } from '@/lib/shelves';
import { daysOfListening, relativeTime, relativeTimeShort } from '@/lib/format';
import { color, font, space } from '@/theme/tokens';
import { CheckedOutTray } from '@/components/CheckedOutTray';
import { DrawerShut } from '@/components/DrawerShut';
import { DrawerShutBanner } from '@/components/DrawerShutBanner';
import { FirstRun, ScanProgressBar } from '@/components/FirstRun';
import { LibraryHeader } from '@/components/LibraryHeader';
import { SelectBar } from '@/components/SelectBar';
import { Shelf } from '@/components/Shelf';
import type { Shelf as ShelfModel } from '@/lib/shelves';

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const [checkingDrive, setCheckingDrive] = useState(false);
  const setBottomObstruction = useUi((s) => s.setBottomObstruction);

  const ready = useLibrary((s) => s.ready);
  const startupError = useLibrary((s) => s.startupError);
  const books = useLibrary((s) => s.books);
  const sort = useLibrary((s) => s.sort);
  const setSort = useLibrary((s) => s.setSort);
  const budgetBytes = useLibrary((s) => s.budgetBytes);
  const libraryRoot = useLibrary((s) => s.libraryRoot);
  const driveConnected = useLibrary((s) => s.driveConnected);
  const driveLastSeenAt = useLibrary((s) => s.driveLastSeenAt);
  const checkDrive = useLibrary((s) => s.checkDrive);
  const selecting = useLibrary((s) => s.selecting);
  const selected = useLibrary((s) => s.selected);
  const showSlip = useLibrary((s) => s.showSlip);

  const checkOut = useLibrary((s) => s.checkOut);
  const cancelCopy = useLibrary((s) => s.cancelCopy);
  const pendingDriveImports = useLibrary((s) => s.pendingDriveImports);
  const pushImportsToDrive = useLibrary((s) => s.pushImportsToDrive);
  const dismissDriveImportOffer = useLibrary((s) => s.dismissDriveImportOffer);
  const returnBook = useLibrary((s) => s.returnBook);
  const enterSelect = useLibrary((s) => s.enterSelect);
  const exitSelect = useLibrary((s) => s.exitSelect);
  const toggleSelected = useLibrary((s) => s.toggleSelected);
  const checkOutSelected = useLibrary((s) => s.checkOutSelected);

  const totalBooks = useLibrary(selectTotalBooks);
  const totalDuration = useLibrary(selectTotalDuration);

  const scanRunning = useScan((s) => s.running);
  const scanProgress = useScan((s) => s.progress);
  const chooseFolderAndScan = useScan((s) => s.chooseFolderAndScan);

  // Derived from `books` here rather than inside a store selector: a selector
  // that builds a new array every call re-renders without end under zustand v5.
  const checkedOut = useMemo(() => checkedOutFrom(books), [books]);
  const shelfCount = useMemo(() => onShelfCount(books), [books]);
  const onHoldCount = useMemo(() => heldCount(books), [books]);

  const used = usedBytes(books);
  const held = holdBytes(books);
  const freeBytes = Math.max(0, budgetBytes - committedBytes(books));

  // Shelves show everything, so a checked-out book keeps its place in the
  // stacks with an "OUT" tag rather than vanishing from where the user left it.
  const shelves = useMemo(() => buildShelves(books, sort), [books, sort]);

  const selectionBytes = useMemo(
    () =>
      selected.reduce((sum, id) => {
        const b = books.find((x) => x.id === id);
        return b ? sum + b.sizeBytes : sum;
      }, 0),
    [selected, books],
  );

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
      `Add ${count} ${count === 1 ? 'book' : 'books'} to the USB library?`,
      `${pendingDriveImports.map((b) => b.title).join(', ')} ${count === 1 ? 'was' : 'were'} ` +
        'added from this phone and is not on the drive yet. Copying it across means it is ' +
        'backed up by the drive, and can be returned from your phone safely.',
      [
        { text: 'Not now', style: 'cancel', onPress: dismissDriveImportOffer },
        { text: 'Add to drive', onPress: () => void pushImportsToDrive() },
      ],
    );
  }, [pendingDriveImports, pushImportsToDrive, dismissDriveImportOffer]);

  const openBook = useCallback((book: Book) => router.push(`/book/${book.id}`), []);

  /**
   * Tapping the drawer looks for the drive there and then, rather than sending
   * the user to Settings to press a second button.
   */
  const recheckDrive = () => {
    if (checkingDrive) return;
    setCheckingDrive(true);
    void (async () => {
      const connected = await checkDrive();
      setCheckingDrive(false);
      // `checkDrive` already announces anything it picked up off hold.
      if (!useLibrary.getState().slip) {
        showSlip(
          connected
            ? { kind: 'note', stamp: 'DRAWER OPEN', text: 'Drive found. The shelves are live.' }
            : {
                kind: 'note',
                stamp: 'DRAWER SHUT',
                text: "Still can't see the drive. Checked-out books keep playing.",
              },
        );
      }
    })();
  };

  // The shelf callbacks are memoised so that scrolling, which re-renders this
  // screen as rows come and go, does not hand every mounted shelf a new set of
  // props and undo the work `React.memo` does on them.
  const onPressBook = useCallback(
    (book: Book) => {
      if (selecting) {
        // Only books not already on the phone can be added to a trip.
        if (book.local.status === 'on-shelf') toggleSelected(book.id);
        return;
      }
      openBook(book);
    },
    [selecting, toggleSelected, openBook],
  );

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
        onLongPressBook={onMoveBook}
        onTabBook={onMoveBook}
        onCancelCopy={onCancelCopy}
        selecting={selecting}
        selectedIds={selected}
      />
    ),
    [onPressBook, onMoveBook, onCancelCopy, selecting, selected],
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

  // Nothing has been indexed yet: ask for the folder.
  if (!libraryRoot || (books.length === 0 && !scanRunning)) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
        <LibraryHeader
          title="Library"
          subtitle={libraryRoot ? 'No books indexed yet' : 'No library folder chosen'}
          connected={driveConnected}
          onToggleDrawer={recheckDrive}
          checking={checkingDrive}
          onOpenSettings={libraryRoot ? () => router.push('/settings') : undefined}
        />
        {scanProgress && scanRunning ? <ScanProgressBar progress={scanProgress} /> : null}
        <FirstRun onPick={() => void chooseFolderAndScan()} busy={scanRunning} />
      </View>
    );
  }

  const subtitle = driveConnected
    ? `${totalBooks} ${totalBooks === 1 ? 'book' : 'books'} · ${daysOfListening(totalDuration)}`
    : `last seen ${relativeTimeShort(driveLastSeenAt)} · ${totalBooks} books`;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <LibraryHeader
        title="Library"
        subtitle={subtitle}
        connected={driveConnected}
        lastSeenLabel={relativeTime(driveLastSeenAt)}
        onToggleDrawer={recheckDrive}
        checking={checkingDrive}
        onOpenSettings={() => router.push('/settings')}
        sort={sort}
        onSort={setSort}
        selecting={selecting}
        onToggleSelect={
          shelfCount > 0 ? () => (selecting ? exitSelect() : enterSelect()) : undefined
        }
      />

      {scanProgress && scanRunning ? <ScanProgressBar progress={scanProgress} /> : null}

      {books.length === 0 ? (
        <DrawerShut heldCount={onHoldCount} />
      ) : (
        /*
         * Virtualized, not a ScrollView. A 400-book library is 134 shelves and
         * 400 covers; mounting them all at once put several hundred megabytes of
         * decoded bitmap on the heap and made the screen unusable. A FlatList
         * keeps roughly a screenful alive.
         *
         * No `getItemLayout`: shelf height varies with the label card's
         * wrapping, and a layout function that guesses wrong is worse than
         * letting the list measure — as the Contents sheet taught us.
         *
         * `removeClippedSubviews` stays off on purpose. Status tags sit at
         * `top: -9` and ribbons at `bottom: -16`, outside their row's bounds,
         * and clipping eats them.
         */
        <FlatList
          style={{ flex: 1 }}
          data={shelves}
          keyExtractor={(shelf) => shelf.key}
          renderItem={renderShelf}
          contentContainerStyle={{ paddingBottom: 28 }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={false}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={7}
          ListHeaderComponent={
            !driveConnected ? (
              <DrawerShutBanner
                lastSeenLabel={relativeTime(driveLastSeenAt)}
                heldCount={onHoldCount}
              />
            ) : null
          }
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
        {selecting ? (
          <SelectBar
            count={selected.length}
            selectionBytes={selectionBytes}
            freeBytes={freeBytes}
            onConfirm={checkOutSelected}
            onCancel={exitSelect}
          />
        ) : (
          <CheckedOutTray
            books={checkedOut}
            usedBytes={used}
            holdBytes={held}
            budgetBytes={budgetBytes}
            onPressBook={openBook}
            onLongPressBook={onMoveBook}
            showRuler
          />
        )}
        <View style={{ height: insets.bottom, backgroundColor: color.panel }} />
      </View>
    </View>
  );
}
