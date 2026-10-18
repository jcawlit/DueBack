/**
 * A book on a server, shown plainly.
 *
 * Testing-stage, and deliberately not the polished Book screen. That one is
 * built around a book that is on the drive or on the phone: it offers to
 * check out, to return, to put on hold. None of those mean anything yet for
 * a book whose audio has not been brought across, and threading "except for
 * this kind of book" through eight hundred lines is how a screen that works
 * for the library people actually use gets broken.
 *
 * What it has to prove is narrow: the real chapters arrive, the position
 * agrees with the server, and a server that cannot be reached shows what it
 * said last rather than nothing.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Chapter } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { useSources } from '@/store/sources';
import { fetchDetail } from '@/lib/abs/catalogue';
import { adoptServerProgress, localProgress } from '@/db/remoteBooks';
import { chooseProgress } from '@/lib/abs/progress';
import { bytes as formatBytes, hoursMinutes, relativeTime, timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { ChevronLeft } from '@/components/icons';
import { useMiniPlayerInset } from '@/components/MiniPlayer';

type Loaded = {
  chapters: Chapter[];
  chaptersFromParts: boolean;
  durationSec: number;
  sizeBytes: number;
  trackCount: number;
  /** Came from the cache because the server could not be reached. */
  cached: boolean;
  cachedAt?: string;
};

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.sm }}>
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint, width: 96 }}>
        {label}
      </Text>
      <Text style={{ flex: 1, fontFamily: font.mono, fontSize: 11, color: color.muted }}>
        {value}
      </Text>
    </View>
  );
}

export default function AbsBookScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const miniPlayerInset = useMiniPlayerInset();

  const book = useLibrary(selectBook(id));
  const refreshLibrary = useLibrary((s) => s.refresh);
  const clientFor = useSources((s) => s.clientFor);
  const sources = useSources((s) => s.sources);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server's position was newer and has been taken. */
  const [adopted, setAdopted] = useState<number | null>(null);

  const sourceId = book?.sourceId;
  const remoteId = book?.remoteId;
  const bookId = book?.id;
  const source = sources.find((s) => s.id === sourceId) ?? null;

  useEffect(() => {
    if (!bookId || !sourceId || !remoteId) return;
    let alive = true;

    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const client = await clientFor(sourceId);

        const result = await fetchDetail(client, bookId, remoteId);
        if (!alive) return;
        if (!result) {
          setError('This book has not been read yet, and the server cannot be reached.');
        } else {
          setLoaded({
            chapters: result.detail.chapters,
            chaptersFromParts: result.detail.chaptersFromParts,
            durationSec: result.detail.durationSec,
            sizeBytes: result.detail.sizeBytes,
            trackCount: result.detail.tracks.length,
            cached: result.cached,
            cachedAt: result.cachedAt,
          });
        }

        /*
         * Whose position is newer.
         *
         * The comparison is the server's `lastUpdate` against our own
         * `progress_updated_at`, and the newer write wins. The position
         * itself is always `currentTime` — never the server's `progress`
         * fraction, which Step 0 proved it computes for itself and ignores
         * from a client.
         */
        if (client) {
          const server = await client.progress(remoteId).catch(() => null);
          const mine = await localProgress(bookId);
          const choice = chooseProgress(server, mine);
          if (alive && server && choice.take === 'server' && choice.positionSec !== mine?.positionSec) {
            await adoptServerProgress(bookId, server.currentTime, server.lastUpdate, server.isFinished);
            await refreshLibrary();
            if (alive) setAdopted(server.currentTime);
          }
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [bookId, sourceId, remoteId, clientFor, refreshLibrary]);

  if (!book) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted, padding: space.xl }}>
          No such book.
        </Text>
      </View>
    );
  }

  const chapters = loaded?.chapters ?? book.chapters;
  const durationSec = loaded?.durationSec || book.durationSec;
  const sizeBytes = loaded?.sizeBytes || book.sizeBytes;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View style={{ paddingTop: 14, paddingHorizontal: space.md, flexDirection: 'row' }}>
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

      <ScrollView
        contentContainerStyle={{
          padding: space.xl,
          paddingBottom: insets.bottom + 40 + miniPlayerInset,
          gap: space.lg,
        }}
      >
        <View style={{ flexDirection: 'row', gap: space.lg }}>
          {book.coverThumbPath ? (
            // The local cache, always. Nothing here points at the server.
            <Image
              source={{ uri: book.coverThumbPath }}
              style={{ width: 96, height: 144, borderRadius: 3, backgroundColor: color.panel }}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View
              style={{
                width: 96,
                height: 144,
                borderRadius: 3,
                backgroundColor: book.dominantColor ?? color.panel,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
                no cover
              </Text>
            </View>
          )}

          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
              {book.title}
            </Text>
            {book.author ? (
              <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.muted }}>
                {book.author}
              </Text>
            ) : null}
            {book.series ? (
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                {book.series}
              </Text>
            ) : null}
          </View>
        </View>

        {book.missingFromDrive ? (
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warning }}>
            This book is no longer on the server. Your place and notes are kept.
          </Text>
        ) : null}

        {adopted !== null ? (
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
            Picked up where you left off on another device — {timestamp(adopted)}
          </Text>
        ) : null}

        {loaded?.cached ? (
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warning }}>
            Showing what the server said last
            {loaded.cachedAt ? `, ${relativeTime(loaded.cachedAt)}` : ''}. It cannot be reached now.
          </Text>
        ) : null}

        {error ? (
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warning }}>{error}</Text>
        ) : null}

        <View style={{ gap: 4 }}>
          <Line label="SOURCE" value={source?.label ?? 'unknown'} />
          <Line label="NARRATOR" value={book.narrator || '—'} />
          <Line label="LENGTH" value={hoursMinutes(durationSec)} />
          <Line label="SIZE" value={formatBytes(sizeBytes)} />
          <Line
            label="CHAPTERS"
            value={
              chapters.length === 0
                ? 'none'
                : `${chapters.length}${loaded?.chaptersFromParts ? ' (one per file)' : ''}`
            }
          />
          <Line label="FILES" value={loaded ? String(loaded.trackCount) : '—'} />
          <Line label="PLACE" value={book.progressSec > 0 ? timestamp(book.progressSec) : 'not started'} />
          <Line label="REMOTE ID" value={book.remoteId ?? '—'} />
        </View>

        {busy ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <ActivityIndicator size="small" color={color.muted} />
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
              Reading the book from the server…
            </Text>
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <Text
            style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}
          >
            CHAPTERS
          </Text>
          {chapters.length === 0 ? (
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
              The server has no chapter marks for this book.
            </Text>
          ) : (
            chapters.map((chapter, i) => (
              <View
                key={`${i}-${chapter.startSec}`}
                style={{
                  flexDirection: 'row',
                  gap: space.sm,
                  paddingVertical: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: color.trough,
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint, width: 28 }}>
                  {i + 1}
                </Text>
                <Text style={{ flex: 1, fontFamily: font.sans, fontSize: 14, color: color.paper }}>
                  {chapter.title}
                </Text>
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
                  {timestamp(chapter.startSec)}
                </Text>
              </View>
            ))
          )}
        </View>

        <View
          style={{
            padding: space.md,
            borderWidth: 1,
            borderColor: color.line,
            borderRadius: radius.button,
          }}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
            Playing a book from a server arrives in a later step. Nothing here
            is downloaded yet.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
