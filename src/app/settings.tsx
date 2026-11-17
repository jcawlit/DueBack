/**
 * Settings: where the library lives, and the two actions that touch it —
 * rescan, and point the app at a different folder.
 */

import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isRemote } from '@/data/types';
import { committedBytes, useLibrary } from '@/store/library';
import { countPlaceholderDriveBooks, forgetMissingBooks } from '@/db/books';
import { countMarginsFor } from '@/db/notes';
import { useBackup } from '@/store/backup';
import { removeCover } from '@/lib/files/covers';
import { useScan } from '@/store/scan';
import { bytes as formatBytes, relativeTime } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { useTheme } from '@/store/theme';
import { THEMES } from '@/theme/palettes';
import { useMiniPlayerInset } from '@/components/MiniPlayer';
import { ChevronLeft } from '@/components/icons';
import { ScanProgressBar } from '@/components/FirstRun';
import { AbsTestingSection } from '@/components/AbsTesting';
import { BudgetSheet } from '@/components/BudgetSheet';
import { ContactSheet } from '@/components/ContactSheet';
import { availableBytes } from '@/lib/files/copy';
import { useSources } from '@/store/sources';

/** "3 notes", "1 character" — the plural done once. */
function countLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function Row({
  label,
  detail,
  onPress,
  tone = 'normal',
  disabled,
}: {
  label: string;
  detail?: string;
  onPress?: () => void;
  tone?: 'normal' | 'accent';
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        minHeight: TOUCH + 10,
        justifyContent: 'center',
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: tone === 'accent' ? color.accent : color.line,
        backgroundColor: pressed && onPress ? color.panel : 'transparent',
        opacity: disabled ? 0.5 : 1,
        gap: 3,
      })}
    >
      <Text
        style={{
          fontFamily: font.sans,
          fontSize: 15,
          color: tone === 'accent' ? color.accent : color.paper,
        }}
      >
        {label}
      </Text>
      {detail ? (
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function SettingsScreen() {
  /*
   * Subscribed so a change of scheme repaints this screen.
   *
   * The colours themselves live in a module object that swaps in place, so
   * nothing here reads them differently — but a component that does not run
   * again keeps what it last painted. One line per screen, and everything
   * the screen renders comes with it.
   */
  useTheme((s) => s.version);
  const themeId = useTheme((s) => s.themeId);
  const setTheme = useTheme((s) => s.setTheme);
  const insets = useSafeAreaInsets();
  const miniPlayerInset = useMiniPlayerInset();
  const backupEnabled = useBackup((s) => s.enabled);
  const setBackupEnabled = useBackup((s) => s.setEnabled);
  const backupPending = useBackup((s) => s.pending);
  const backupAt = useBackup((s) => s.lastAt);
  const backupStatus = useBackup((s) => s.status);
  const libraryRoot = useLibrary((s) => s.libraryRoot);
  const driveConnected = useLibrary((s) => s.driveConnected);
  const driveLastSeenAt = useLibrary((s) => s.driveLastSeenAt);
  const checkDrive = useLibrary((s) => s.checkDrive);
  const importBook = useLibrary((s) => s.importBook);
  const importing = useLibrary((s) => s.importing);
  const pendingDriveImports = useLibrary((s) => s.pendingDriveImports);
  const pushImportsToDrive = useLibrary((s) => s.pushImportsToDrive);
  const pushingToDrive = useLibrary((s) => s.pushingToDrive);
  const books = useLibrary((s) => s.books);
  const refresh = useLibrary((s) => s.refresh);
  const budgetBytes = useLibrary((s) => s.budgetBytes);
  const setBudgetBytes = useLibrary((s) => s.setBudgetBytes);
  const loadSources = useSources((s) => s.load);

  const [editingBudget, setEditingBudget] = useState(false);
  const [contacting, setContacting] = useState(false);
  /*
   * Free space, read when the sheet opens rather than on every render.
   *
   * `availableBytes` is a synchronous native stat. It is quick, but a
   * screen's render is not the place to ask the filesystem anything, and
   * the figure only has to be true at the moment the question is asked.
   */
  const [freeBytes, setFreeBytes] = useState(0);

  const scanning = useScan((s) => s.running);
  const preparing = useScan((s) => s.preparing);
  // Picking a folder, checking it and scanning it are one busy state here.
  const running = scanning || preparing;
  const progress = useScan((s) => s.progress);
  const lastResult = useScan((s) => s.lastResult);
  const scanError = useScan((s) => s.error);
  const rescan = useScan((s) => s.rescan);
  const chooseFolderAndScan = useScan((s) => s.chooseFolderAndScan);
  const cancel = useScan((s) => s.cancel);

  // Look for the drive on arrival, so the status shown is current.
  useEffect(() => {
    void checkDrive();
  }, [checkDrive]);

  // Configured servers, for the testing section below.
  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // Drive books only: a book missing from a server is counted and forgotten
  // by that source, not by the drive's housekeeping.
  const onDrive = books.filter((b) => !isRemote(b));
  const missing = onDrive.filter((b) => b.missingFromDrive).length;

  /**
   * Switching folders drops the old folder's catalogue, so the count that
   * will go is read before the question is asked and the question names it.
   *
   * It says "taken off the shelves" rather than "deleted": what goes is the
   * index, the drive's own backup still holds the writing, and switching back
   * brings the books and their notes with it. What never goes is a book with
   * audio on the phone.
   */
  const confirmChangeFolder = () => {
    if (books.length === 0) {
      void chooseFolderAndScan();
      return;
    }
    void (async () => {
      const dropping = await countPlaceholderDriveBooks();
      const held = onDrive.length - dropping;
      if (dropping === 0) {
        Alert.alert(
          'Switch library folder?',
          'Everything on your shelves is already copied to your phone, so nothing ' +
            'is taken off them. The new folder is scanned and added.',
          [
            { text: 'Keep this folder', style: 'cancel' },
            { text: 'Switch', onPress: () => void chooseFolderAndScan() },
          ],
        );
        return;
      }
      Alert.alert(
        'Switch library folder?',
        `${dropping} ${dropping === 1 ? 'book' : 'books'} on the shelves ${dropping === 1 ? 'is' : 'are'} ` +
          'only an entry pointing at the current folder, with no audio on this phone. ' +
          `${dropping === 1 ? 'It goes' : 'They go'} off the shelves, along with ` +
          `${dropping === 1 ? 'its' : 'their'} listening progress and checkout history.` +
          (held > 0
            ? ` The ${held} ${held === 1 ? 'book' : 'books'} already copied to your phone ` +
              `${held === 1 ? 'stays' : 'stay'} exactly where ${held === 1 ? 'it is' : 'they are'}.`
            : '') +
          '\n\nAnything you wrote is kept on the drive, so switching back brings the ' +
          'books and your notes with them.',
        [
          { text: 'Keep this folder', style: 'cancel' },
          { text: 'Switch', style: 'destructive', onPress: () => void chooseFolderAndScan() },
        ],
      );
    })();
  };

  /**
   * Dropping missing books also drops their progress and library-card history,
   * so it always asks first — and asks differently when there is writing at
   * stake.
   *
   * Notes and characters are the only things in this database the listener
   * authored. Everything else a rescan can rebuild; these it cannot. So the
   * count is read before the question is asked, and the question names it.
   */
  const confirmForgetMissing = () => {
    void (async () => {
      const ids = onDrive.filter((b) => b.missingFromDrive).map((b) => b.id);
      let margins = { notes: 0, characters: 0 };
      try {
        margins = await countMarginsFor(ids);
      } catch {
        // Unknown is not "none": warn as though there were something.
        margins = { notes: -1, characters: 0 };
      }
      /** A blank line before the part about the listener's own writing. */
      const BREAK = '\n\n';
      const wrote =
        margins.notes === 0 && margins.characters === 0
          ? ''
          : margins.notes < 0
            ? `${BREAK}Some of these may have notes you wrote. Those cannot be rebuilt by a rescan.`
            : `${BREAK}This also deletes ${countLabel(margins.notes, 'note')}` +
              `${margins.characters > 0 ? ` and ${countLabel(margins.characters, 'character')}` : ''}` +
              ' that you wrote. A rescan cannot bring them back.';

      Alert.alert(
        `Forget ${missing} missing ${missing === 1 ? 'book' : 'books'}?`,
        'These are no longer on the drive. Their listening progress and checkout ' +
          'history go with them. Books still on the drive are untouched.' +
          wrote,
        [
          { text: 'Keep them', style: 'cancel' },
          {
            text: wrote ? 'Delete my notes too' : 'Forget them',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                const forgotten = await forgetMissingBooks();
                forgotten.forEach(removeCover);
                await refresh();
              })();
            },
          },
        ],
      );
    })();
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View
        style={{
          paddingTop: 14,
          paddingHorizontal: space.md,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to the library"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            minHeight: TOUCH,
            paddingHorizontal: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <ChevronLeft />
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            back to the library
          </Text>
        </Pressable>
      </View>

      {running && progress ? <ScanProgressBar progress={progress} /> : null}

      <ScrollView
        contentContainerStyle={{
          padding: space.xl,
          paddingBottom: insets.bottom + 40 + miniPlayerInset,
          gap: space.lg,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ fontFamily: font.serif, fontSize: 30, color: color.paper }}
        >
          Settings
        </Text>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            THE DRIVE
          </Text>
          <Row
            label={libraryRoot ? libraryRoot.name : 'No folder chosen'}
            detail={
              libraryRoot
                ? driveConnected
                  ? 'Connected'
                  : `Not reachable · last seen ${relativeTime(driveLastSeenAt)}`
                : 'Pick the folder your audiobooks live in'
            }
          />
          <Row
            label="Check again"
            detail="Looks for the drive now"
            onPress={() => void checkDrive()}
          />
          <Row
            label="Change library folder"
            detail="Books not copied to your phone leave the shelves"
            onPress={confirmChangeFolder}
            disabled={running}
          />
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            LIBRARY
          </Text>
          <Row
            label={`${onDrive.length} ${onDrive.length === 1 ? 'book' : 'books'} indexed`}
            detail={
              missing > 0
                ? `${missing} no longer on the drive`
                : 'Everything indexed is still on the drive'
            }
          />
          <Row
            label={running ? 'Scanning…' : 'Rescan library'}
            detail="Reads anything new or changed"
            tone="accent"
            onPress={scanning ? cancel : () => void rescan()}
            disabled={!libraryRoot || preparing}
          />
          <Row
            label="Full rescan"
            detail="Re-reads every book, even unchanged ones"
            onPress={() => void rescan({ force: true })}
            disabled={!libraryRoot || running}
          />
          {missing > 0 ? (
            <Row
              label={`Forget ${missing} missing ${missing === 1 ? 'book' : 'books'}`}
              detail="Removes books that are no longer on the drive, and their progress"
              onPress={confirmForgetMissing}
              disabled={running}
            />
          ) : null}
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            ADD FROM THIS PHONE
          </Text>
          <Row
            label={importing ? 'Adding…' : 'Add a book folder'}
            // While an import runs, the row itself reports what it is doing.
            // Staging a folder of parts takes long enough that silence reads as
            // a button that did not work.
            detail={importing ?? 'A folder of audio files on this phone'}
            onPress={() => void importBook('folder')}
            disabled={running || !!importing}
          />
          <Row
            label="Add a single audio file"
            detail="One .m4b, .m4a or .mp3 on this phone"
            onPress={() => void importBook('file')}
            disabled={running || !!importing}
          />
          {pendingDriveImports.length > 0 ? (
            <Row
              label={
                pushingToDrive
                  ? 'Copying to the drive…'
                  : `Copy ${pendingDriveImports.length} to the drive`
              }
              // A book of any size takes a while to write to a USB drive, and
              // the row is the only place that can say so.
              detail={pushingToDrive ?? 'Puts books added here onto the drive as well'}
              tone="accent"
              onPress={() => void pushImportsToDrive()}
              disabled={running || !driveConnected || !!pushingToDrive}
            />
          ) : null}
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            APPEARANCE
          </Text>
          {THEMES.map((theme) => {
            const active = theme.id === themeId;
            return (
              <Pressable
                key={theme.id}
                onPress={() => setTheme(theme.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${theme.name}. ${theme.note}`}
                style={({ pressed }) => ({
                  minHeight: TOUCH + 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingHorizontal: space.md,
                  borderRadius: radius.button,
                  borderWidth: 1,
                  borderColor: active ? color.accent : color.borderSoft,
                  backgroundColor: pressed ? color.panel : 'transparent',
                })}
              >
                {/*
                  Three swatches rather than a name alone: a scheme is the
                  ground it sits on, the paper on top of it and the lamp,
                  and those three say more than any word for a colour.
                */}
                <View style={{ flexDirection: 'row' }}>
                  {[theme.palette.ground, theme.palette.paper, theme.palette.accent].map(
                    (swatch, i) => (
                      <View
                        key={swatch + i}
                        style={{
                          width: 16,
                          height: 28,
                          backgroundColor: swatch,
                          borderWidth: 1,
                          borderColor: color.border,
                          marginLeft: i === 0 ? 0 : -1,
                        }}
                      />
                    ),
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontFamily: font.serif, fontSize: 16, color: color.paper }}>
                    {theme.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}
                  >
                    {theme.note}
                  </Text>
                </View>
                {active ? (
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                    on
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            STORAGE
          </Text>
          <Row
            label={`Budget ${formatBytes(budgetBytes)}`}
            detail="How much of the phone checked-out books may use"
            onPress={() => {
              setFreeBytes(availableBytes());
              setEditingBudget(true);
            }}
          />
        </View>

        {scanError ? (
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.warning }}>
            {scanError}
          </Text>
        ) : null}

        {lastResult ? (
          <View style={{ gap: 3 }}>
            <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
              LAST SCAN
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
              {lastResult.books} books · {lastResult.updated} updated ·{' '}
              {lastResult.unchanged} unchanged · {(lastResult.ms / 1000).toFixed(1)}s
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
              {lastResult.filesSeen} files seen · {lastResult.skippedUnsupported} skipped ·{' '}
              {lastResult.errors.length + lastResult.unreadableFiles.length} errors
            </Text>
            {lastResult.unreadableFiles.length > 0 ? (
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warning }}>
                {lastResult.unreadableFiles.length}{' '}
                {lastResult.unreadableFiles.length === 1 ? 'file' : 'files'} could not be read
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            NOTES
          </Text>
          <Row
            label="Back up reading data to the drive"
            detail={
              !backupEnabled
                ? 'Off — notes, places and history stay on this phone'
                : backupStatus ??
                  (backupPending
                    ? 'Pending — the drive will take a copy on the next scan'
                    : backupAt
                      ? `Last copied ${relativeTime(backupAt)}`
                      : 'On — notes, places and history are copied to the drive')
            }
            onPress={() => setBackupEnabled(!backupEnabled)}
          />
        </View>

        <AbsTestingSection />

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            CONTACT
          </Text>
          <Row
            label="Report a problem"
            detail="Something went wrong, or did not work the way it reads"
            onPress={() => setContacting(true)}
          />
          <Row
            label="Ask for something"
            detail="A feature, or a change to one"
            onPress={() => setContacting(true)}
          />
          <Row
            label="Listening"
            detail="Hours, streaks, and what you have spent them on"
            onPress={() => router.push('/stats')}
          />
          <Row
            label="Scan report"
            detail="Every book, its parts, timings and warnings"
            onPress={() => router.push('/dev/metadata')}
          />
        </View>
      </ScrollView>

      <ContactSheet visible={contacting} onClose={() => setContacting(false)} />

      <BudgetSheet
        visible={editingBudget}
        budgetBytes={budgetBytes}
        /*
         * Every book, not just the drive's. What a server's books have
         * downloaded fills the same phone, and the budget is about the phone.
         */
        committedBytes={committedBytes(books)}
        availableBytes={freeBytes}
        onSave={(next) => {
          setBudgetBytes(next);
          setEditingBudget(false);
        }}
        onCancel={() => setEditingBudget(false)}
      />
    </View>
  );
}
