/**
 * The notes list: everything written while listening to this book, under the
 * chapter it was written in.
 *
 * On the screen's own dark ground, not on paper. It used to be a page in a
 * card — ruled lines, boxes round the timestamps, a separator under every
 * note — and it read as a notepad pasted into the app rather than as the
 * listener's own writing. What is left is the writing itself, with space
 * doing the work the rules were doing.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { groupNotesByChapter, isBookmark, type Character, type Note } from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { Aside } from './Aside';
import { NoteText } from './NoteText';
import { Ribbon } from './Ribbon';

/**
 * A time that plays the book from there.
 *
 * Plain text, not a chip. The box round it made every note look like a form
 * with a field in it; the lamp colour is enough to say it can be pressed,
 * and the tap target is kept honest with hitSlop rather than with padding
 * that has to be drawn.
 */
export function TimeChip({ atSec, onPress }: { atSec: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play from ${timestamp(atSec)}`}
      hitSlop={12}
      style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize: 11,
          letterSpacing: 0.5,
          color: color.accent,
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
          color: tone === 'warning' ? color.warning : color.accent,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A chip naming someone a note is about, and a way to see only them.
 *
 * The name was already the answer to "who is this about"; making it the
 * control for "show me the rest about them" means the list can be narrowed
 * from the thing that prompted the question.
 */
function CharacterChip({ name, onPress }: { name: string; onPress?: () => void }) {
  const body = (
    <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>{name}</Text>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Show only notes about ${name}`}
      hitSlop={12}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/** The chapter a run of notes belongs to. A label, with no rule under it. */
function ChapterRule({ title }: { title: string }) {
  return (
    <Text
      numberOfLines={1}
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        letterSpacing: 1,
        color: color.faint,
        marginTop: space.lg,
        marginBottom: space.xs,
      }}
    >
      {title.toUpperCase()}
    </Text>
  );
}

export function NotesCard({
  book,
  notes,
  characters,
  onPlayFrom,
  onEdit,
  onSelectCharacter,
}: {
  book: Book;
  notes: Note[];
  characters: Character[];
  onPlayFrom: (sec: number) => void;
  /** Opens the note. Editing and deleting both live in the sheet. */
  onEdit: (note: Note) => void;
  /** Narrows the list to one character. Omitted where there is no strip. */
  onSelectCharacter?: (id: string) => void;
}) {
  if (notes.length === 0) {
    return (
      <Aside>
        Nothing written yet. The pencil in the player marks where you are, and anything you
        type lands here.
      </Aside>
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
                  minHeight: TOUCH,
                }}
              >
                <Ribbon width={7} height={16} notch={0.25} />
                <Text style={{ flex: 1, fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                  bookmark
                </Text>
                <Text
                  style={{
                    fontFamily: font.monoMedium,
                    fontSize: 11,
                    letterSpacing: 0.5,
                    color: color.accent,
                  }}
                >
                  {timestamp(note.positionSec)}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                key={note.id}
                onPress={() => onEdit(note)}
                accessibilityRole="button"
                accessibilityHint="Opens the note"
                style={({ pressed }) => ({
                  paddingVertical: space.md,
                  gap: space.sm,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <NoteText size={15}>{note.text}</NoteText>

                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: space.sm,
                  }}
                >
                  <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                  {note.characterIds.map((id) => {
                    const name = nameOf(id);
                    return name ? (
                      <CharacterChip
                        key={id}
                        name={name}
                        onPress={onSelectCharacter ? () => onSelectCharacter(id) : undefined}
                      />
                    ) : null;
                  })}
                </View>
              </Pressable>
            ),
          )}
        </View>
      ))}
    </View>
  );
}
