/**
 * What the listening log adds up to.
 *
 * Reads the log once on arrival rather than subscribing: nothing here changes
 * while it is on screen, because a stretch is only written when playback
 * stops and this screen is not where anyone listens.
 *
 * Everything shown comes from the log except the books finished, which is a
 * fact the library already holds.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadSessions, type Session } from '@/db/listening';
import { summarise, type Stats } from '@/lib/stats/summary';
import { useLibrary } from '@/store/library';
import { useTheme } from '@/store/theme';
import { hoursMinutes } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { ChevronLeft } from '@/components/icons';
import { useMiniPlayerInset } from '@/components/MiniPlayer';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A figure and what it means, as a pair you read top to bottom. */
function Figure({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text
        numberOfLines={1}
        style={{ fontFamily: font.serif, fontSize: 26, color: color.paper }}
      >
        {value}
      </Text>
      <Text
        numberOfLines={2}
        style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 0.8, color: color.faint }}
      >
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.md }}>
      <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * Two weeks of days, as bars.
 *
 * Scaled to the busiest day rather than to a fixed ceiling, because the
 * question a run of bars answers is "which days, and how do they compare",
 * not "how does this measure against some number".
 */
function Fortnight({ days }: { days: Stats['recentDays'] }) {
  const peak = Math.max(...days.map((d) => d.seconds), 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 76 }}>
      {days.map((day) => {
        const share = day.seconds / peak;
        return (
          <View key={day.day} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <View
              style={{
                width: '100%',
                // A day with any listening gets a visible sliver, so "a little"
                // and "none at all" do not look the same.
                height: Math.max(day.seconds > 0 ? 3 : 1, Math.round(share * 60)),
                backgroundColor: day.seconds > 0 ? color.accent : color.line,
                borderRadius: 1,
              }}
            />
            <Text style={{ fontFamily: font.mono, fontSize: 8, color: color.faint }}>
              {day.day.slice(-2)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function StatsScreen() {
  useTheme((s) => s.version);
  const insets = useSafeAreaInsets();
  const miniPlayerInset = useMiniPlayerInset();
  const books = useLibrary((s) => s.books);

  /*
   * The log and the moment it was read, together.
   *
   * Every figure here is relative to a moment, so the clock is read once —
   * when the rows arrive, which is outside a render — and carried with
   * them. Reading it during render would make each figure a slightly
   * different number on every pass, and is impure besides.
   */
  const [log, setLog] = useState<{ sessions: Session[]; at: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadSessions().then(
      (rows) => {
        if (alive) setLog({ sessions: rows, at: Date.now() });
      },
      () => {
        // An unreadable log is an empty one as far as this screen goes.
        if (alive) setLog({ sessions: [], at: Date.now() });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const stats = useMemo(
    () => (log ? summarise(log.sessions, log.at) : null),
    [log],
  );

  const finished = books.filter((b) => !!b.finishedAt).length;
  const titleOf = (bookId: string) =>
    books.find((b) => b.id === bookId)?.title ?? 'A book no longer here';

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View style={{ paddingTop: 14, paddingHorizontal: space.xl, paddingBottom: space.sm }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={10}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: TOUCH }}
        >
          <ChevronLeft size={18} stroke={color.muted} />
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>Back</Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          style={{ fontFamily: font.serif, fontSize: 30, color: color.paper }}
        >
          Listening
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space.xl,
          paddingTop: space.md,
          paddingBottom: space.xl + miniPlayerInset,
          gap: space.xxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {!stats ? (
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            Reading the log…
          </Text>
        ) : stats.sessions === 0 ? (
          <View style={{ gap: space.sm }}>
            <Text style={{ fontFamily: font.serif, fontSize: 18, color: color.paper }}>
              Nothing recorded yet.
            </Text>
            {/*
              Said plainly, because the honest answer to an empty screen is
              that the log only starts when it starts. It cannot be worked out
              backwards from a position, which is the whole reason it exists.
            */}
            <Text
              style={{
                fontFamily: font.sans,
                fontSize: 14,
                lineHeight: 14 * 1.45,
                color: color.muted,
              }}
            >
              Listening is counted from now on. Nothing before this build could
              be recovered — a saved position says where you are in a book, never
              when you were there.
            </Text>
          </View>
        ) : (
          <>
            <Section title="ALL TOLD">
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <Figure value={hoursMinutes(stats.totalSec)} label="Listened" />
                <Figure value={String(finished)} label="Books finished" />
                <Figure value={String(stats.daysListened)} label="Days listened" />
              </View>
            </Section>

            <Section title="LATELY">
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <Figure value={hoursMinutes(stats.todaySec)} label="Today" />
                <Figure value={hoursMinutes(stats.weekSec)} label="Last 7 days" />
                <Figure value={hoursMinutes(stats.monthSec)} label="Last 30 days" />
              </View>
              <Fortnight days={stats.recentDays} />
            </Section>

            <Section title="HABITS">
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <Figure
                  value={stats.streakDays > 0 ? `${stats.streakDays}` : '—'}
                  label={stats.streakDays === 1 ? 'Day streak' : 'Day streak'}
                />
                <Figure value={String(stats.longestStreakDays)} label="Longest streak" />
                <Figure
                  value={
                    stats.busiestWeekday === null
                      ? '—'
                      : WEEKDAYS[stats.busiestWeekday].slice(0, 3)
                  }
                  label="Busiest day"
                />
              </View>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <Figure
                  value={hoursMinutes(stats.averagePerActiveDaySec)}
                  label="On a day you listen"
                />
                <Figure value={hoursMinutes(stats.longestSessionSec)} label="Longest sitting" />
                <Figure value={String(stats.sessions)} label="Sittings" />
              </View>
            </Section>

            {stats.byBook.length > 0 ? (
              <Section title="MOST LISTENED">
                <View style={{ gap: space.sm }}>
                  {stats.byBook.slice(0, 8).map((entry) => (
                    <View
                      key={entry.bookId}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'baseline',
                        gap: space.md,
                        borderRadius: radius.button,
                        borderWidth: 1,
                        borderColor: color.borderSoft,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontFamily: font.serif,
                          fontSize: 15,
                          color: color.paper,
                        }}
                      >
                        {titleOf(entry.bookId)}
                      </Text>
                      <Text
                        style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}
                      >
                        {hoursMinutes(entry.seconds)}
                      </Text>
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
