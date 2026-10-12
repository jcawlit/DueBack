/**
 * Book — the library card view. Everything known about one book, its stamped
 * checkout history, and the two moves available: keep listening, or return it.
 */

import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isCheckedOut, progressFraction, remainingSec } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { bytes, hoursMinutes, hoursLeft, stampDate } from '@/lib/format';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { BookCover } from '@/components/BookCover';
import { LibraryCard } from '@/components/LibraryCard';
import { Slip } from '@/components/Slip';
import { StatusTag } from '@/components/CoverBadges';
import { ChevronLeft } from '@/components/icons';

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Leave room for the title block, progress, the library card and the two
  // actions; the cover takes what is left of a screen shorter than the mockup's.
  const coverScale = Math.max(
    0.6,
    Math.min(1, (windowHeight - insets.top - insets.bottom - 560) / 248),
  );

  const book = useLibrary(selectBook(id));
  const driveConnected = useLibrary((s) => s.driveConnected);
  const checkOut = useLibrary((s) => s.checkOut);
  const returnBook = useLibrary((s) => s.returnBook);
  const cancelHold = useLibrary((s) => s.cancelHold);
  const checkOutAndPlay = useLibrary((s) => s.checkOutAndPlay);
  const slip = useLibrary((s) => s.slip);
  const dismissSlip = useLibrary((s) => s.dismissSlip);

  if (!book) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: color.ground,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xl,
          gap: space.md,
        }}
      >
        <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
          Not on the shelf.
        </Text>
        <Pressable onPress={() => router.replace('/')} accessibilityRole="button">
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
            back to the library
          </Text>
        </Pressable>
      </View>
    );
  }

  const out = isCheckedOut(book);
  const copying = book.local.status === 'copying';
  const onHold = book.local.status === 'on-hold';
  const fraction = progressFraction(book);
  const started = book.progressSec > 60;
  const finished = !!book.finishedAt;

  const progressLabel = finished
    ? `finished ${stampDate(book.finishedAt!)}`
    : started
      ? `${Math.round(fraction * 100)}% · ${hoursLeft(remainingSec(book))} to go`
      : 'not started';

  /** The primary action depends entirely on where the audio currently lives. */
  const openPlayer = (id: string) => router.push(`/player/${id}`);

  /**
   * The one action that matters, whatever state the book is in. A book that is
   * not on the phone is checked out and then played, rather than opening a
   * player that has nothing to play.
   */
  const primary = book.drmProtected
    ? {
        label: "Can't play — protected by DRM",
        onPress: undefined,
        tone: 'muted' as const,
      }
    : copying
      ? {
          label: `Checking out… ${Math.round((book.local.status === 'copying' ? book.local.progress : 0) * 100)}%`,
          onPress: undefined,
          tone: 'muted' as const,
        }
      : out
        ? {
            label: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
            onPress: () => openPlayer(book.id),
            tone: 'accent' as const,
          }
        : onHold
          ? {
              label: 'Waiting for the drawer',
              onPress: undefined,
              tone: 'muted' as const,
            }
          : {
              label: driveConnected
                ? `Check out and play · ${bytes(book.sizeBytes)}`
                : `Put on hold · ${bytes(book.sizeBytes)}`,
              onPress: () =>
                driveConnected
                  ? checkOutAndPlay(book.id, openPlayer)
                  : checkOut(book.id),
              tone: 'accent' as const,
            };

  const secondary = out
    ? {
        label: `Return to the shelves · frees ${bytes(book.sizeBytes)}`,
        onPress: () => returnBook(book.id),
      }
    : onHold
      ? { label: 'Cancel the hold', onPress: () => cancelHold(book.id) }
      : null;

  const tag = out
    ? { label: 'CHECKED OUT', variant: 'solid' as const }
    : onHold
      ? { label: 'ON HOLD', variant: 'outline' as const }
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View
        style={{
          paddingTop: 14,
          paddingHorizontal: space.md,
          flexDirection: 'row',
          justifyContent: 'space-between',
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
        {tag ? (
          <View style={{ marginRight: space.md }}>
            <StatusTag label={tag.label} variant={tag.variant} />
          </View>
        ) : null}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 36 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ alignItems: 'center', paddingTop: 18 }}>
          <BookCover
            book={book}
            size="book"
            showTag={false}
            showRibbon={false}
            lean={-1.5}
            edgeWidth={13}
            scale={coverScale}
          />
        </View>

        <View style={{ paddingTop: 26, paddingHorizontal: space.xxl, gap: space.sm }}>
          <Text
            accessibilityRole="header"
            style={{
              fontFamily: font.serif,
              fontSize: 28,
              lineHeight: 28 * 1.05,
              color: color.paper,
            }}
          >
            {book.title}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            {book.author} · {hoursMinutes(book.durationSec)} · {bytes(book.sizeBytes)}
          </Text>
          {book.narrator ? (
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              read by {book.narrator}
            </Text>
          ) : null}
        </View>

        <View style={{ paddingTop: space.lg, paddingHorizontal: space.xxl, gap: space.sm }}>
          <View
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: color.line,
              overflow: 'hidden',
            }}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={progressLabel}
          >
            <View
              style={{
                width: `${Math.max(fraction * 100, started ? 2 : 0)}%`,
                height: '100%',
                backgroundColor: color.ribbon,
              }}
            />
          </View>
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
            {progressLabel}
          </Text>
        </View>

        {book.missingFromDrive ? (
          <View
            style={{
              marginTop: space.lg,
              marginHorizontal: space.xxl,
              borderWidth: 1,
              borderColor: color.warningInk,
              borderRadius: radius.button,
              padding: space.md,
              gap: space.xs,
            }}
          >
            <Text
              style={{
                fontFamily: font.monoMedium,
                fontSize: 10,
                letterSpacing: 0.9,
                color: color.warning,
              }}
            >
              NOT ON THE DRIVE
            </Text>
            <Text
              style={{
                fontFamily: font.sans,
                fontSize: 13,
                lineHeight: 13 * 1.4,
                color: '#cbbb9e',
              }}
            >
              {`The last scan couldn't find this one on the USB — moved, renamed or deleted.`}
              {out ? ' Your phone has the only copy, so returning it will ask twice.' : ''}
            </Text>
          </View>
        ) : null}

        <View style={{ marginTop: space.xl, marginHorizontal: space.xxl }}>
          <LibraryCard checkouts={book.checkouts} />
        </View>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: space.xxl,
          paddingBottom: Math.max(26, insets.bottom + 10),
          gap: 10,
        }}
      >
        <Pressable
          onPress={primary.onPress}
          disabled={!primary.onPress}
          accessibilityRole="button"
          accessibilityState={{ disabled: !primary.onPress }}
          style={({ pressed }) => [
            {
              minHeight: 52,
              borderRadius: radius.button,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: primary.tone === 'accent' ? color.accent : color.panel,
              borderWidth: primary.tone === 'accent' ? 0 : 1,
              borderColor: color.border,
              opacity: pressed ? 0.85 : 1,
            },
            primary.tone === 'accent' ? shadow(8, 0.3) : null,
          ]}
        >
          <Text
            style={{
              fontFamily: font.serif,
              fontSize: 18,
              color: primary.tone === 'accent' ? color.ground : color.muted,
            }}
          >
            {primary.label}
          </Text>
        </Pressable>

        {secondary ? (
          <Pressable
            onPress={secondary.onPress}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: 48,
              borderRadius: radius.button,
              borderWidth: 1,
              borderColor: finished ? color.accent : color.border,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: finished ? color.accent : color.paper,
              }}
            >
              {secondary.label}
            </Text>
          </Pressable>
        ) : null}

        <Text
          style={{
            textAlign: 'center',
            fontFamily: font.mono,
            fontSize: 11,
            color: color.faint,
          }}
        >
          {finished && out
            ? 'all done — shall I put it back?'
            : out
              ? "finish it and I'll offer to return it for you"
              : driveConnected
                ? 'checking out copies it to your phone'
                : 'holds check out as soon as the drawer opens'}
        </Text>
      </View>

      {slip ? <Slip slip={slip} onDismiss={dismissSlip} bottom={180} /> : null}

    </View>
  );
}
