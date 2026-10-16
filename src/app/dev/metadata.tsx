/**
 * Scan report — the developer's view of what the scanner actually produced.
 *
 * Every book shows its raw folder name beside the cleaned title (so the effect
 * of the name rules is visible), its parts in order, chapter count, cover
 * source, warnings, and what reading it cost in bytes, reads and milliseconds.
 * That last part is the point: it is how USB-OTG latency gets measured on real
 * hardware rather than guessed at.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadDevBooks, type DevBook } from '@/db/books';
import { useLibrary } from '@/store/library';
import { useScan } from '@/store/scan';
import { DEFAULT_BLOCK_SIZE } from '@/lib/metadata/reader';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { useMiniPlayerInset } from '@/components/MiniPlayer';
import { ChevronLeft } from '@/components/icons';
import { ScanProgressBar } from '@/components/FirstRun';

function kb(n: number) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function dur(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

function Line({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <Text
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        lineHeight: 16,
        color: dim ? color.faint : color.muted,
      }}
    >
      {children}
    </Text>
  );
}

export default function ScanReportScreen() {
  const insets = useSafeAreaInsets();
  const miniPlayerInset = useMiniPlayerInset();
  const [books, setBooks] = useState<DevBook[]>([]);
  const [copied, setCopied] = useState(false);

  const libraryRoot = useLibrary((s) => s.libraryRoot);
  const driveConnected = useLibrary((s) => s.driveConnected);
  const running = useScan((s) => s.running);
  const progress = useScan((s) => s.progress);
  const lastResult = useScan((s) => s.lastResult);
  const rescan = useScan((s) => s.rescan);

  // Re-read the report whenever a scan finishes. The state update happens in
  // the promise callback, not in the effect body.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    loadDevBooks().then(
      (rows) => {
        if (!cancelled) setBooks(rows);
      },
      () => {
        if (!cancelled) setBooks([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [running]);

  const totals = books.reduce(
    (acc, b) => ({
      bytes: acc.bytes + b.bytes_read,
      reads: acc.reads + b.read_count,
      ms: acc.ms + b.scan_ms,
      parts: acc.parts + b.parts.length,
      size: acc.size + b.size_bytes,
    }),
    { bytes: 0, reads: 0, ms: 0, parts: 0, size: 0 },
  );

  /** A plain-text summary small enough to paste into a message. */
  const buildReport = () => {
    const lines: string[] = [];
    lines.push('DUE BACK — SCAN REPORT');
    lines.push(
      `root: ${libraryRoot?.name ?? '(none)'} ${driveConnected ? '[connected]' : '[not reachable]'}`,
    );
    lines.push(`block size: ${DEFAULT_BLOCK_SIZE / 1024} KB`);
    if (lastResult) {
      lines.push(
        `scan: ${lastResult.books} books, ${lastResult.updated} updated, ` +
          `${lastResult.unchanged} unchanged, ${lastResult.filesSeen} files seen, ` +
          `${lastResult.skippedUnsupported} skipped, ` +
          `${lastResult.errors.length + lastResult.unreadableFiles.length} errors, ` +
          `${(lastResult.ms / 1000).toFixed(1)}s total`,
      );
      if (lastResult.unreadableFolders.length) {
        lines.push(`unreadable folders: ${lastResult.unreadableFolders.join(', ')}`);
      }
      lastResult.errors.slice(0, 10).forEach((e) => lines.push(`  ERROR ${e}`));
    }
    lines.push(
      `totals: ${books.length} books, ${totals.parts} parts, ${kb(totals.size)} on drive, ` +
        `read ${kb(totals.bytes)} in ${totals.reads} reads, ${totals.ms} ms`,
    );
    lines.push('');

    for (const b of books) {
      const warnings = b.warnings ? (JSON.parse(b.warnings) as string[]) : [];
      lines.push(`-- ${b.title}`);
      lines.push(`   raw folder : ${b.raw_folder_name}`);
      lines.push(`   author     : ${b.author ?? '-'} (${b.author_source ?? '-'})`);
      lines.push(`   title from : ${b.title_source}`);
      lines.push(`   narrator   : ${b.narrator ?? '-'}`);
      lines.push(
        `   ${b.parts.length} part(s) · ${dur(b.duration_sec)} · ${kb(b.size_bytes)} · ` +
          `${b.chapterCount} chapters · cover ${b.cover_source ?? 'none'}`,
      );
      lines.push(
        `   read ${kb(b.bytes_read)} in ${b.read_count} reads · ${b.scan_ms} ms` +
          `${b.drm ? ' · DRM' : ''}${b.missing ? ' · MISSING' : ''}` +
          `${b.skipped_files ? ` · ${b.skipped_files} skipped` : ''}`,
      );
      b.parts.slice(0, 6).forEach((p, i) => {
        lines.push(
          `     ${String(i + 1).padStart(3)}. ${p.name} · ${dur(p.duration_sec)}` +
            `${p.track_number != null ? ` · trk ${p.track_number}` : ''}` +
            `${p.error ? ` · ERROR ${p.error}` : ''}`,
        );
      });
      if (b.parts.length > 6) lines.push(`     ... ${b.parts.length - 6} more parts`);
      warnings.forEach((w) => lines.push(`     ! ${w}`));
      lines.push('');
    }
    return lines.join('\n');
  };

  const copyReport = async () => {
    await Clipboard.setStringAsync(buildReport());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View
        style={{
          paddingTop: 12,
          paddingHorizontal: space.md,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Pressable
          onPress={() => router.back()}
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

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Pressable
            onPress={() => void rescan({ force: true })}
            disabled={running || !libraryRoot}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: TOUCH,
              justifyContent: 'center',
              paddingHorizontal: space.md,
              borderRadius: radius.chip,
              borderWidth: 1,
              borderColor: color.borderSoft,
              opacity: running || !libraryRoot ? 0.5 : pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
              full rescan
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void copyReport()}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: TOUCH,
              justifyContent: 'center',
              paddingHorizontal: space.md,
              borderRadius: radius.chip,
              backgroundColor: copied ? color.accent : 'transparent',
              borderWidth: 1,
              borderColor: color.accent,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: copied ? color.ground : color.accent,
              }}
            >
              {copied ? 'copied' : 'copy report'}
            </Text>
          </Pressable>
        </View>
      </View>

      {running && progress ? <ScanProgressBar progress={progress} /> : null}

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + 40 + miniPlayerInset,
          gap: space.md,
        }}
      >
        <View style={{ paddingTop: space.md, gap: 3 }}>
          <Text style={{ fontFamily: font.serif, fontSize: 24, color: color.paper }}>
            Scan report
          </Text>
          <Line>
            {books.length} books · {totals.parts} parts · {kb(totals.size)} on the drive
          </Line>
          <Line>
            read {kb(totals.bytes)} in {totals.reads} reads · {totals.ms} ms ·{' '}
            {DEFAULT_BLOCK_SIZE / 1024} KB blocks
          </Line>
          {lastResult ? (
            <Line dim>
              last scan {(lastResult.ms / 1000).toFixed(1)}s · {lastResult.updated} updated ·{' '}
              {lastResult.unchanged} unchanged · {lastResult.skippedUnsupported} skipped ·{' '}
              {lastResult.errors.length + lastResult.unreadableFiles.length} errors
            </Line>
          ) : null}
        </View>

        {books.map((b) => {
          const warnings = b.warnings ? (JSON.parse(b.warnings) as string[]) : [];
          return (
            <View
              key={b.id}
              style={{
                borderWidth: 1,
                borderColor: b.drm || b.missing ? color.warningInk : color.line,
                borderRadius: radius.button,
                padding: space.md,
                gap: 2,
              }}
            >
              <Text style={{ fontFamily: font.serif, fontSize: 17, color: color.paper }}>
                {b.title}
              </Text>
              <Line dim>
                raw folder: {b.raw_folder_name}
                {b.title === b.raw_folder_name ? '  (unchanged)' : ''}
              </Line>
              <Line>
                {b.author ?? 'no author'} · title from {b.title_source} · author from{' '}
                {b.author_source}
              </Line>
              {b.narrator ? <Line>narrator: {b.narrator}</Line> : null}
              <Line>
                {b.parts.length} part{b.parts.length === 1 ? '' : 's'} · {dur(b.duration_sec)} ·{' '}
                {kb(b.size_bytes)} · {b.chapterCount} chapters · cover {b.cover_source ?? 'none'}
              </Line>
              <Text style={{ fontFamily: font.monoMedium, fontSize: 11, color: color.paper }}>
                read {kb(b.bytes_read)} in {b.read_count} reads · {b.scan_ms} ms
              </Text>

              {b.drm ? (
                <Text style={{ fontFamily: font.monoMedium, fontSize: 11, color: color.warning }}>
                  {"Can't play: protected by DRM"}
                </Text>
              ) : null}
              {b.missing === 1 ? (
                <Text style={{ fontFamily: font.monoMedium, fontSize: 11, color: color.warning }}>
                  No longer on the drive
                </Text>
              ) : null}
              {b.skipped_files > 0 ? (
                <Line dim>{b.skipped_files} unsupported audio file(s) skipped</Line>
              ) : null}

              {b.parts.slice(0, 8).map((p, i) => (
                <Line key={p.rel_path} dim>
                  {String(i + 1).padStart(3)}. {p.name} · {dur(p.duration_sec)}
                  {p.track_number != null ? ` · trk ${p.track_number}` : ''}
                  {p.error ? ` · ${p.error}` : ''}
                </Line>
              ))}
              {b.parts.length > 8 ? <Line dim>… {b.parts.length - 8} more parts</Line> : null}

              {warnings.map((w) => (
                <Text key={w} style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                  ! {w}
                </Text>
              ))}
            </View>
          );
        })}

        {books.length === 0 ? (
          <Line dim>Nothing scanned yet. Pick a folder on the Library screen.</Line>
        ) : null}
      </ScrollView>
    </View>
  );
}
