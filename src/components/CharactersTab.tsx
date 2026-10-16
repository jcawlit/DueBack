/**
 * Everyone in the book, one card each.
 *
 * Ordered by when you first heard of them rather than alphabetically,
 * because the question this answers is "who was that again", and the answer
 * is nearly always someone met recently or met at the very start.
 *
 * On paper, where the notes are not. A note is the listener's voice and
 * belongs on the app's own ground; a character is a record card about
 * someone, and the catalogue stock is what it is for.
 */

import { Pressable, Text, View } from 'react-native';
import {
  charactersByFirstHeard,
  firstHeardSec,
  noteCountFor,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { Aside } from './Aside';
import { NoteText } from './NoteText';

/** The ink used for a heading on this stock, shared with the library card. */
const ON_PAPER_FAINT = '#5a4a32';

export function CharactersTab({
  characters,
  notes,
  onOpen,
  onAdd,
}: {
  characters: Character[];
  notes: Note[];
  onOpen: (character: Character) => void;
  /** Absent where tagging is not available, which is where Pro is not. */
  onAdd?: () => void;
}) {
  const ordered = charactersByFirstHeard(characters, notes);

  return (
    <View style={{ paddingHorizontal: space.xl, paddingTop: space.lg, gap: space.md }}>
      {ordered.length === 0 ? (
        <Aside>Nobody yet. Type @ in a note to tag someone, or add them here.</Aside>
      ) : null}

      {ordered.map((character) => {
        const count = noteCountFor(character.id, notes);
        const heard = firstHeardSec(character.id, notes);
        return (
          <Pressable
            key={character.id}
            onPress={() => onOpen(character)}
            accessibilityRole="button"
            accessibilityLabel={`${character.name}, ${count} ${count === 1 ? 'note' : 'notes'}`}
            accessibilityHint="Opens their card"
            style={({ pressed }) => [
              {
                gap: 6,
                paddingVertical: space.md,
                paddingHorizontal: 14,
                backgroundColor: color.paperCardAlt,
                borderRadius: 3,
                opacity: pressed ? 0.85 : 1,
              },
              shadow(6, 0.4),
            ]}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                paddingBottom: 5,
                borderBottomWidth: 1.5,
                borderBottomColor: color.warningInk,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, fontFamily: font.serif, fontSize: 18, color: color.inkOnPaper }}
              >
                {character.name}
              </Text>
              <Text style={{ fontFamily: font.mono, fontSize: 10, color: ON_PAPER_FAINT }}>
                {count} {count === 1 ? 'note' : 'notes'}
              </Text>
            </View>

            {character.bio.trim().length > 0 ? (
              <NoteText size={14} numberOfLines={3} style={{ color: color.inkOnPaper }}>
                {character.bio}
              </NoteText>
            ) : null}

            <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.stampOut }}>
              {heard === null ? 'NOT HEARD YET' : `FIRST HEARD · ${timestamp(heard)}`}
            </Text>
          </Pressable>
        );
      })}

      {onAdd ? (
        <Pressable
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add a character"
          style={({ pressed }) => ({
            minHeight: Math.max(TOUCH, 52),
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: color.border,
            borderRadius: radius.cover,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.accent }}>
            + Add character
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
