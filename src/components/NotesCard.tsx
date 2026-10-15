/**
 * The notes card: everything written while listening to this book, under the
 * chapter it was written in.
 *
 * Lives inside `CardStack`, so the paper, the ink and the rules all come from
 * there and nothing here sets a colour that is not on paper. A bookmark is a
 * single ruled line rather than a card of its own — it has nothing to read,
 * and giving it the same weight as a written note made a list of bookmarks
 * look like a list of empty boxes.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { groupNotesByChapter, isBookmark, type Character, type Note } from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { CardEmpty } from './CardStack';
import { NoteText } from './NoteText';
import { Ribbon } from './Ribbon';

/** A time that plays the book from there. */
export function TimeChip({ atSec, onPress }: { atSec: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play from ${timestamp(atSec)}`}
      hitSlop={10}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: radius.tag,
        borderWidth: 1,
        borderColor: color.paperRule,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize: 11,
          letterSpacing: 0.5,
          color: color.stampOut,
        }}
      >
        {timestamp(atSec)}
      </Text>
    </Pressable>
  );
}

/** A small action in a card's margin. Ink, never lamp-light. */
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={6}
      style={{ minHeight: TOUCH, justifyContent: 'center' }}
    >
      <Text
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: tone === 'warning' ? color.warningInk : color.stampOut,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A chip naming someone a note is about. */
function CharacterChip({ name }: { name: string }) {
  return (
    <View
      style={{
        paddingHorizontal: space.sm,
        paddingVertical: 1,
        borderRadius: 2,
        backgroundColor: color.paperCard,
        borderWidth: 1,
        borderColor: color.paperRule,
      }}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.inkOnPaper }}>{name}</Text>
    </View>
  );
}

/** The chapter a run of notes belongs to, ruled off like a column heading. */
function ChapterRule({ title }: { title: string }) {
  return (
    <View
      style={{
        paddingBottom: 6,
        marginTop: space.md,
        borderBottomWidth: 1.5,
        borderBottomColor: '#7a6446',
      }}
    >
      <Text
        numberOfLines={1}
        style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1, color: '#5a4a32' }}
      >
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

export function NotesCard({
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
      <CardEmpty>
        Nothing written yet. The pencil in the player marks where you are, and anything you
        type lands here.
      </CardEmpty>
    );
  }

  const groups = groupNotesByChapter(notes, book.chapters, book.title);
  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name;

  return (
    <View>
      {groups.map((group) => (
        <View key={group.chapterIndex}>
          <ChapterRule title={group.title} />

          {group.notes.map((note) =>
            isBookmark(note) ? (
              <Pressable
                key={note.id}
                onPress={() => onEdit(note)}
                accessibilityRole="button"
                accessibilityLabel={`Bookmark at ${timestamp(note.positionSec)}. Tap to write a note.`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  minHeight: 34,
                  borderBottomWidth: 1,
                  borderBottomColor: color.paperRule,
                }}
              >
                <Ribbon width={7} height={16} notch={0.25} />
                <Text
                  style={{ flex: 1, fontFamily: font.mono, fontSize: 11, color: color.stampFaded }}
                >
                  bookmark
                </Text>
                <Text
                  style={{
                    fontFamily: font.monoMedium,
                    fontSize: 11,
                    letterSpacing: 0.5,
                    color: color.stampOut,
                  }}
                >
                  {timestamp(note.positionSec)}
                </Text>
              </Pressable>
            ) : (
              <View
                key={note.id}
                style={{
                  paddingVertical: space.sm,
                  gap: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: color.paperRule,
                }}
              >
                <NoteText style={{ color: color.inkOnPaper }}>{note.text}</NoteText>

                {note.characterIds.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                    {note.characterIds.map((id) => {
                      const name = nameOf(id);
                      return name ? <CharacterChip key={id} name={name} /> : null;
                    })}
                  </View>
                ) : null}

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                  <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                  <View style={{ flex: 1 }} />
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
