/**
 * The three ways into a book you are part-way through: what is in it, what you
 * wrote in the margins, and who is in it.
 *
 * All three are panels rather than screens, because the question they answer
 * is always "in this book" and a listener flicking between them should not be
 * navigating.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import {
  groupNotesByChapter,
  isBookmark,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { NoteText } from './NoteText';
import { Ribbon } from './Ribbon';

export type BookTab = 'chapters' | 'margins' | 'whoswho';

export function TabBar({
  tab,
  onChange,
  tabs,
}: {
  tab: BookTab;
  onChange: (tab: BookTab) => void;
  tabs: { key: BookTab; label: string }[];
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        marginHorizontal: space.xxl,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
      }}
    >
      {tabs.map((entry) => {
        const active = entry.key === tab;
        return (
          <Pressable
            key={entry.key}
            onPress={() => onChange(entry.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              minHeight: TOUCH,
              alignItems: 'center',
              justifyContent: 'center',
              borderBottomWidth: 2,
              borderBottomColor: active ? color.accent : 'transparent',
            }}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: 0.5,
                color: active ? color.accent : color.faint,
              }}
            >
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A time that plays the book from there. */
export function TimeChip({ atSec, onPress }: { atSec: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play from ${timestamp(atSec)}`}
      hitSlop={8}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        paddingHorizontal: space.sm,
        paddingVertical: 3,
        borderRadius: radius.tag,
        borderWidth: 1,
        borderColor: color.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
        {timestamp(atSec)}
      </Text>
    </Pressable>
  );
}

export function EmptyPanel({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: font.sans,
        fontSize: 14,
        color: color.faint,
        paddingHorizontal: space.xxl,
        paddingTop: space.xl,
      }}
    >
      {children}
    </Text>
  );
}

export function ChaptersPanel({
  book,
  onPlayFrom,
}: {
  book: Book;
  onPlayFrom: (sec: number) => void;
}) {
  if (book.chapters.length === 0) {
    return <EmptyPanel>This book has no chapters.</EmptyPanel>;
  }
  return (
    <View style={{ paddingTop: space.md }}>
      {book.chapters.map((chapter, i) => (
        <Pressable
          key={`${chapter.startSec}-${i}`}
          onPress={() => onPlayFrom(chapter.startSec)}
          accessibilityRole="button"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            minHeight: TOUCH,
            paddingHorizontal: space.xxl,
            backgroundColor: pressed ? color.panel : 'transparent',
          })}
        >
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontFamily: font.sans, fontSize: 15, color: color.paper }}
          >
            {chapter.title}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
            {timestamp(chapter.startSec)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A chip naming someone a note is about. */
function CharacterChip({ name }: { name: string }) {
  return (
    <View
      style={{
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: 3,
        backgroundColor: color.panel,
        borderWidth: 1,
        borderColor: color.line,
      }}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.muted }}>{name}</Text>
    </View>
  );
}

export function MarginsPanel({
  book,
  notes,
  characters,
  onPlayFrom,
  onEdit,
  onDelete,
}: {
  book: Book;
  notes: Note[];
  characters: Character[];
  onPlayFrom: (sec: number) => void;
  onEdit: (note: Note) => void;
  onDelete: (note: Note) => void;
}) {
  if (notes.length === 0) {
    return (
      <EmptyPanel>
        Nothing here yet. The pencil in the player saves a bookmark where you are, and
        anything you type lands here.
      </EmptyPanel>
    );
  }

  const groups = groupNotesByChapter(notes, book.chapters, book.title);
  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name;

  return (
    <View style={{ paddingTop: space.md, gap: space.lg }}>
      {groups.map((group) => (
        <View key={group.chapterIndex} style={{ gap: space.sm }}>
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 10,
              letterSpacing: 1,
              color: color.faint,
              paddingHorizontal: space.xxl,
            }}
          >
            {group.title.toUpperCase()}
          </Text>

          {group.notes.map((note) =>
            isBookmark(note) ? (
              /* A bookmark has nothing to read, so it is a line, not a card. */
              <Pressable
                key={note.id}
                onPress={() => onEdit(note)}
                accessibilityRole="button"
                accessibilityLabel={`Bookmark at ${timestamp(note.positionSec)}. Tap to write a note.`}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  minHeight: TOUCH,
                  paddingHorizontal: space.xxl,
                  backgroundColor: pressed ? color.panel : 'transparent',
                })}
              >
                <Ribbon width={8} height={18} notch={0.25} />
                <Text style={{ flex: 1, fontFamily: font.mono, fontSize: 11, color: color.muted }}>
                  bookmark
                </Text>
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                  {timestamp(note.positionSec)}
                </Text>
              </Pressable>
            ) : (
              <View
                key={note.id}
                style={{
                  marginHorizontal: space.xxl,
                  padding: space.md,
                  borderWidth: 1,
                  borderColor: color.line,
                  borderRadius: radius.button,
                  gap: space.sm,
                }}
              >
                <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                <NoteText>{note.text}</NoteText>

                {note.characterIds.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                    {note.characterIds.map((id) => {
                      const name = nameOf(id);
                      return name ? <CharacterChip key={id} name={name} /> : null;
                    })}
                  </View>
                ) : null}

                <View style={{ flexDirection: 'row', gap: space.lg, paddingTop: 2 }}>
                  <RowAction label="edit" onPress={() => onEdit(note)} />
                  <RowAction label="delete" tone="warning" onPress={() => onDelete(note)} />
                </View>
              </View>
            ),
          )}
        </View>
      ))}
    </View>
  );
}

export function RowAction({
  label,
  onPress,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'warning';
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={10}>
      <Text
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: tone === 'warning' ? color.warningInk : color.accent,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
