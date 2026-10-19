/**
 * SPIKE — throwaway. The Google Drive probe, as a screen.
 *
 * Plain on purpose: this exists to produce numbers on a real phone against
 * a real Drive folder, and then to be deleted along with
 * `src/lib/spike/`. Every button maps to one of the questions the spike
 * has to answer, and the log is the deliverable.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  checkGrant,
  forgetFolder,
  pickFolder,
  probeCopy,
  probeListing,
  probeMetadata,
  sameBooks,
  savedFolder,
  type ListingReport,
  type ProbeFolder,
} from '@/lib/spike/driveProbe';
import { bytes as formatBytes } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { ChevronLeft } from '@/components/icons';

function Button({
  label,
  onPress,
  disabled,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'accent' | 'warning';
}) {
  const ink = tone === 'accent' ? color.accent : tone === 'warning' ? color.warning : color.paper;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.md,
        borderWidth: 1,
        borderColor: ink,
        borderRadius: radius.button,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 12, color: ink }}>{label}</Text>
    </Pressable>
  );
}

export default function DriveSpikeScreen() {
  const insets = useSafeAreaInsets();
  const [folder, setFolder] = useState<ProbeFolder | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [listing, setListing] = useState<ListingReport | null>(null);
  const [firstKeys, setFirstKeys] = useState<string[] | null>(null);
  /** Set by Stop, read by the copy between files. */
  const [cancelled, setCancelled] = useState(false);

  const say = useCallback((line: string) => {
    setLog((l) => [...l, line]);
  }, []);

  // On arrival, report whether a folder picked earlier is still reachable.
  // This is most of question (a): run it after a restart, and after a reboot.
  useEffect(() => {
    void (async () => {
      const saved = await savedFolder();
      setFolder(saved);
      if (!saved) {
        say('No folder picked yet.');
        return;
      }
      say(`Remembered: ${saved.name}`);
      const grant = await checkGrant(saved.uri);
      say(
        grant.ok
          ? `Grant still good (${grant.ms} ms to prove it).`
          : 'GRANT GONE — the folder cannot be read. Pick it again.',
      );
    })();
  }, [say]);

  const run = (name: string, work: () => Promise<void>) => {
    setBusy(name);
    void work()
      .catch((error) => say(`FAILED: ${(error as Error)?.message ?? String(error)}`))
      .finally(() => setBusy(null));
  };

  const pick = () =>
    run('pick', async () => {
      const picked = await pickFolder();
      if (!picked) {
        say('Picker dismissed, or it returned nothing.');
        return;
      }
      setFolder(picked);
      setListing(null);
      setFirstKeys(null);
      say(`Picked: ${picked.name}`);
      say(`  uri: ${picked.uri}`);
      // The authority in the URI says which provider answered, which is the
      // whole of "did Drive appear in the picker".
      const authority = /content:\/\/([^/]+)/.exec(picked.uri)?.[1] ?? 'unknown';
      say(`  provider: ${authority}`);
    });

  const list = () =>
    run('list', async () => {
      if (!folder) return;
      say('Listing…');
      const report = await probeListing(folder.uri);
      setListing(report);
      say(`Listed in ${report.ms} ms`);
      say(`  readable: ${report.rootReadable}`);
      say(`  ${report.fileCount} audio files, ${report.bookCount} books`);
      say(`  ${report.unsupportedCount} unsupported, ${report.unreadableFolders.length} unreadable folders`);
      for (const folderName of report.unreadableFolders.slice(0, 5)) say(`    ! ${folderName}`);
      if (report.duplicateKeys.length > 0) {
        say(`  DUPLICATE identities: ${report.duplicateKeys.length}`);
      }
      if (firstKeys) {
        const verdict = sameBooks(firstKeys, report.keys);
        say(`  vs the first listing: ${verdict.same ? 'STABLE' : 'UNSTABLE'} — ${verdict.detail}`);
      } else {
        setFirstKeys(report.keys);
        say('  (list again to compare identities)');
      }
    });

  const metadata = () =>
    run('metadata', async () => {
      if (!listing) {
        say('List the folder first.');
        return;
      }
      say('Reading tags from up to 5 books…');
      const samples = await probeMetadata(listing.books, 5);
      let pulled = 0;
      let total = 0;
      for (const s of samples) {
        const share = s.sizeBytes > 0 ? Math.round((s.bytesRead / s.sizeBytes) * 100) : 0;
        pulled += s.bytesRead;
        total += s.sizeBytes;
        say(
          `  ${s.file}: read ${formatBytes(s.bytesRead)} of ${formatBytes(s.sizeBytes)} ` +
            `(${share}%) in ${Math.round(s.ms)} ms, ${s.readCount} reads` +
            (s.error ? ` — ${s.error}` : ''),
        );
      }
      const share = total > 0 ? Math.round((pulled / total) * 100) : 0;
      say(`  TOTAL: ${formatBytes(pulled)} of ${formatBytes(total)} (${share}%)`);
      say(
        share > 50
          ? '  VERDICT: the provider is pulling whole files. Indexing would download the library.'
          : '  VERDICT: partial reads survive. Indexing stays cheap.',
      );
    });

  const copy = () =>
    run('copy', async () => {
      if (!listing || listing.books.length === 0) {
        say('List the folder first.');
        return;
      }
      setCancelled(false);
      const book = listing.books[0];
      const size = book.files.reduce((n, f) => n + f.sizeBytes, 0);
      say(`Copying "${book.folderRelPath || '(root)'}" — ${formatBytes(size)}…`);
      let lastPercent = -1;
      const report = await probeCopy(book, {
        shouldCancel: () => cancelled,
        onProgress: (fraction) => {
          const percent = Math.round(fraction * 100);
          if (percent === lastPercent || percent % 20 !== 0) return;
          lastPercent = percent;
          say(`  ${percent}%`);
        },
      });
      say(
        report.ok
          ? `Copied ${formatBytes(report.bytes)} in ${(report.ms / 1000).toFixed(1)}s ` +
              `(${formatBytes(report.rate)}/s). ${report.message}`
          : `Copy did not finish — ${report.message}`,
      );
      say('  (the copy was deleted; this was a measurement)');
    });

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View style={{ paddingTop: 14, paddingHorizontal: space.md, flexDirection: 'row' }}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.navigate('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back"
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
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>back</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space.xl,
          paddingBottom: insets.bottom + 40,
          gap: space.sm,
        }}
      >
        <Text style={{ fontFamily: font.serif, fontSize: 24, color: color.paper }}>
          Drive folder spike
        </Text>
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
          Throwaway. Measures whether a cloud folder can carry the same
          pipeline the USB drawer does. Nothing here touches your library.
        </Text>

        <View style={{ gap: space.sm, paddingTop: space.md }}>
          <Button label="1 · Pick a folder" onPress={pick} disabled={busy !== null} tone="accent" />
          <Button label="2 · List it (time a scan)" onPress={list} disabled={busy !== null || !folder} />
          <Button
            label="3 · Read tags (bytes pulled)"
            onPress={metadata}
            disabled={busy !== null || !listing}
          />
          <Button
            label="4 · Copy the first book"
            onPress={copy}
            disabled={busy !== null || !listing}
          />
          {busy === 'copy' ? (
            <Button label="Stop the copy" onPress={() => setCancelled(true)} tone="warning" />
          ) : null}
          <Button
            label="Check the grant again"
            onPress={() =>
              run('grant', async () => {
                if (!folder) return;
                const grant = await checkGrant(folder.uri);
                say(grant.ok ? `Grant good (${grant.ms} ms).` : 'GRANT GONE.');
              })
            }
            disabled={busy !== null || !folder}
          />
          <Button
            label="Forget the folder"
            onPress={() =>
              run('forget', async () => {
                await forgetFolder();
                setFolder(null);
                setListing(null);
                setFirstKeys(null);
                say('Forgotten.');
              })
            }
            disabled={busy !== null || !folder}
            tone="warning"
          />
        </View>

        <View
          style={{
            marginTop: space.md,
            padding: space.md,
            borderWidth: 1,
            borderColor: color.line,
            borderRadius: radius.button,
            gap: 2,
          }}
        >
          {log.length === 0 ? (
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              Nothing yet.
            </Text>
          ) : (
            log.map((line, i) => (
              <Text
                key={`${i}-${line.slice(0, 12)}`}
                style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}
              >
                {line}
              </Text>
            ))
          )}
          {busy ? (
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
              working… ({busy})
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
