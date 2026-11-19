/**
 * Everyone in the book, grouped by the chapter they first turn up in.
 *
 * Ordered by first appearance rather than alphabetically, because the
 * question this answers is "who was that again", and the answer is nearly
 * always someone met recently or met at the very start. The chapter
 * dividers are the same ones the notes list uses — a character and a note
 * are both things that happened at a point in the book.
 *
 * On the app's own ground, like the other two tabs. The paper is kept for
 * the editor, which is the one place a character really is a record card.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { chapterAt } from '@/data/types';
import {
  charactersByFirstHeard,
  firstHeardSec,
  noteCountFor,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { markLabelCaps } from '@/lib/library/marks';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { Aside } from './Aside';
import { ProLocked, ProTag } from './ProTag';
import { ChevronRight } from './icons';

type Row = {
  character: Character;
  heard: number | null;
  count: number;
};

/** Characters under the chapter they were first heard in, unheard ones last. */
function groupByChapter(book: Book, characters: Character[], notes: Note[]) {
  const groups: { label: string; rows: Row[] }[] = [];
  for (const character of charactersByFirstHeard(characters, notes)) {
    const heard = firstHeardSec(character.id, notes);
    const label =
      heard === null
        ? 'NOT HEARD YET'
        : book.chapters.length > 0
          ? markLabelCaps(book, chapterAt(book, heard).index)
          : 'IN THIS BOOK';
    const last = groups[groups.length - 1];
    const row = { character, heard, count: noteCountFor(character.id, notes) };
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

export function CharactersTab({
  book,
  characters,
  notes,
  onOpen,
  onAdd,
  locked = false,
  onUnlock,
}: {
  book: Book;
  characters: Character[];
  notes: Note[];
  onOpen: (character: Character) => void;
  /** Absent where tagging is not available, which is where Pro is not. */
  onAdd?: () => void;
  /**
   * Not paid for. The list still renders — characters already written stay
   * visible and stay in exports, always — but nobody new can be added, and
   * the tab says why rather than quietly losing its button.
   */
  locked?: boolean;
  onUnlock?: () => void;
}) {
  const groups = groupByChapter(book, characters, notes);
  const total = characters.length;

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: space.xl,
          paddingRight: space.md,
          paddingTop: space.sm,
        }}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
          {total === 0
            ? 'Nobody yet'
            : `${total} ${total === 1 ? 'character' : 'characters'} · in order of first appearance`}
        </Text>
        {locked ? (
          <View style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: 8 }}>
            <ProTag onPress={onUnlock} />
          </View>
        ) : onAdd ? (
          <Pressable
            onPress={onAdd}
            accessibilityRole="button"
            accessibilityLabel="Add a character"
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              justifyContent: 'center',
              paddingHorizontal: 8,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
              + Add character
            </Text>
          </Pressable>
        ) : null}
      </View>

      {total === 0 && locked ? (
        /*
         * Empty *and* locked: there is nothing to look at, so the tab
         * explains what it would hold. An empty tab with a dimmed button
         * tells somebody nothing about why they would want one.
         */
        <ProLocked
          title="Who is who"
          body={
            'Keep a note on each character and tag them with @ as you listen, ' +
            'so a long book with a long cast stops being a memory test.'
          }
          onPress={() => onUnlock?.()}
        />
      ) : total === 0 ? (
        <View style={{ paddingHorizontal: space.xl }}>
          <Aside>Nobody yet. Type @ in a note to tag someone, or add them here.</Aside>
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.label} style={{ paddingHorizontal: space.xl }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingTop: space.lg,
              paddingBottom: 2,
            }}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: 1,
                color: color.faint,
              }}
            >
              {group.label}
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: color.trough }} />
          </View>

          {group.rows.map(({ character, heard, count }) => {
            const described = character.bio.trim().length > 0;
            return (
              <Pressable
                key={character.id}
                onPress={() => onOpen(character)}
                accessibilityRole="button"
                accessibilityLabel={
                  `${character.name}, ` +
                  `${heard === null ? 'not heard yet' : `first heard ${timestamp(heard)}`}, ` +
                  `${count} ${count === 1 ? 'note' : 'notes'}`
                }
                accessibilityHint="Opens their card"
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: color.trough,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: font.serif,
                      fontSize: 18,
                      lineHeight: 18 * 1.15,
                      color: color.paper,
                    }}
                  >
                    {character.name}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={{
                      fontFamily: font.sans,
                      fontSize: 14,
                      lineHeight: 20,
                      color: described ? color.muted : color.stampFaded,
                      fontStyle: described ? 'normal' : 'italic',
                    }}
                  >
                    {described ? character.bio.trim() : 'No description yet'}
                  </Text>
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.mentionInk }}>
                    {heard === null
                      ? 'tag them in a note to place them'
                      : `first heard ${timestamp(heard)}`}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                    {count} {count === 1 ? 'note' : 'notes'}
                  </Text>
                  <ChevronRight />
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
