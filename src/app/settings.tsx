/**
 * Settings: where the library lives, and the two actions that touch it —
 * rescan, and point the app at a different folder.
 */

import { useEffect } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLibrary } from '@/store/library';
import { forgetMissingBooks } from '@/db/books';
import { countMarginsFor } from '@/db/notes';
import { useUi } from '@/store/ui';
import { useBackup } from '@/store/backup';
import { removeCover } from '@/lib/files/covers';
import { useScan } from '@/store/scan';
import { bytes as formatBytes, relativeTime } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { ChevronLeft } from '@/components/icons';
import { ScanProgressBar } from '@/components/FirstRun';

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
  const insets = useSafeAreaInsets();
  const handwritten = useUi((s) => s.handwritten);
  const setHandwritten = useUi((s) => s.setHandwritten);
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

  const missing = books.filter((b) => b.missingFromDrive).length;

  /**
   * Switching folders re-indexes everything, so books from the old one end up
   * flagged missing and cannot be checked out. That is recoverable but
   * surprising, so it is spelled out first.
   */
  const confirmChangeFolder = () => {
    if (books.length === 0) {
      void chooseFolderAndScan();
      return;
    }
    Alert.alert(
      'Switch library folder?',
      `The ${books.length} ${books.length === 1 ? 'book' : 'books'} from the current folder will be ` +
        'marked as no longer on the drive, and you will not be able to check them out ' +
        'until you switch back. Progress and checkout history are kept, and anything ' +
        'already copied to your phone stays playable.',
      [
        { text: 'Keep this folder', style: 'cancel' },
        { text: 'Switch', style: 'destructive', onPress: () => void chooseFolderAndScan() },
      ],
    );
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
      const ids = books.filter((b) => b.missingFromDrive).map((b) => b.id);
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
          paddingBottom: insets.bottom + 40,
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
            detail="Pick a different folder and scan it"
            onPress={confirmChangeFolder}
            disabled={running}
          />
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            LIBRARY
          </Text>
          <Row
            label={`${books.length} ${books.length === 1 ? 'book' : 'books'} indexed`}
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
            STORAGE
          </Text>
          <Row
            label={`Budget ${formatBytes(budgetBytes)}`}
            detail="How much of the phone checked-out books may use"
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
            label="Handwritten notes"
            detail={
              handwritten
                ? 'On — your notes are shown in a handwriting face'
                : 'Off — your notes are shown in the reading face'
            }
            onPress={() => setHandwritten(!handwritten)}
          />
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

        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
            DEVELOPER
          </Text>
          <Row
            label="Scan report"
            detail="Every book, its parts, timings and warnings"
            onPress={() => router.push('/dev/metadata')}
          />
        </View>
      </ScrollView>
    </View>
  );
}
