/**
 * The chapters, as a list you can jump from.
 *
 * It was dropped once, on the grounds that the Player's Contents sheet is
 * the same list — but that sheet is only reachable while something is
 * playing, and this is the screen you are on when deciding *whether* to
 * play. The chapter you are in is marked with a bar down its left edge, and
 * any chapter you wrote in says how much.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import type { Note } from '@/data/notes';
import { tidyChapterTitle, timestamp } from '@/lib/format';
import { color, font, radius, space } from '@/theme/tokens';
import { Aside } from './Aside';

/** Where each chapter ends, so a note can be counted into one of them. */
function chapterBounds(book: Book) {
  return book.chapters.map((chapter, i) => ({
    chapter,
    index: i,
    startSec: chapter.startSec,
    endSec: book.chapters[i + 1]?.startSec ?? book.durationSec,
  }));
}

export function ChaptersTab({
  book,
  notes,
  currentIndex,
  onPlayFrom,
}: {
  book: Book;
  notes: Note[];
  /** The chapter the listener is in, marked rather than selected. */
  currentIndex: number;
  onPlayFrom: (sec: number) => void;
}) {
  if (book.chapters.length === 0) {
    return <Aside>This book has no chapter marks — it plays straight through.</Aside>;
  }

  const bounds = chapterBounds(book);

  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm }}>
      {bounds.map(({ chapter, index, startSec, endSec }) => {
        const here = index === currentIndex;
        const written = notes.filter(
          (n) => n.positionSec >= startSec && n.positionSec < endSec,
        ).length;
        const title = tidyChapterTitle(chapter.title?.trim() || `Chapter ${index + 1}`);

        return (
          <Pressable
            key={`${index}-${startSec}`}
            onPress={() => onPlayFrom(startSec)}
            accessibilityRole="button"
            accessibilityLabel={
              `Chapter ${index + 1}, ${title}${here ? ', where you are' : ''}` +
              `${written > 0 ? `, ${written} notes` : ''}, starts ${timestamp(startSec)}`
            }
            style={({ pressed }) => ({
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingHorizontal: 8,
              borderRadius: radius.button,
              backgroundColor: here ? color.trough : 'transparent',
              // The bar is the mark, not a tick: it says "you are here"
              // without implying the row has been chosen.
              borderLeftWidth: here ? 3 : 0,
              borderLeftColor: color.accent,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ width: 52, fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              CH. {index + 1}
            </Text>
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontFamily: font.sans, fontSize: 15, color: color.paper }}
            >
              {title}
            </Text>
            {written > 0 ? (
              <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.mentionInk }}>
                {written} {written === 1 ? 'note' : 'notes'}
              </Text>
            ) : null}
            <Text
              style={{
                width: 64,
                textAlign: 'right',
                fontFamily: font.mono,
                fontSize: 11,
                color: color.muted,
              }}
            >
              {timestamp(startSec)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
