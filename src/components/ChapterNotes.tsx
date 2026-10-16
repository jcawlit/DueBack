/**
 * What you wrote in the chapter you are listening to, and the card you get
 * when you open one.
 *
 * The Player used to be able to make notes and show none of them. You could
 * hear a line you had already written about and never know — which is the
 * one moment the writing is worth most. The slips are in time order, the
 * same order the chapter plays in.
 */

import { Pressable, ScrollView, Text, View } from 'react-native';
import { isBookmark, type Character, type Note } from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { mentionSegments } from './mentionText';
import { NoteText } from './NoteText';
import { PlayIcon } from './icons';
import { Ribbon } from './Ribbon';

/** The ink a label takes on this stock. */
const ON_PAPER_FAINT = '#5f4f38';

/** A note on a slip, wide enough for two lines of it. */
function Slip({
  note,
  selected,
  onPress,
}: {
  note: Note;
  selected: boolean;
  onPress: () => void;
}) {
  const mark = isBookmark(note);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        `${mark ? 'Bookmark' : 'Note'} at ${timestamp(note.positionSec)}` +
        `${mark ? '' : `: ${note.text}`}`
      }
      style={({ pressed }) => [
        {
          width: mark ? 110 : 168,
          minHeight: 76,
          gap: 5,
          paddingVertical: 9,
          paddingHorizontal: 11,
          borderRadius: 3,
          backgroundColor: color.paperCardAlt,
          opacity: pressed ? 0.85 : 1,
        },
        selected
          ? { borderWidth: 2, borderColor: color.accent, paddingVertical: 7, paddingHorizontal: 9 }
          : shadow(6, 0.4),
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {mark ? <Ribbon width={7} height={13} notch={0.22} /> : null}
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampOut }}>
          {timestamp(note.positionSec)}
        </Text>
      </View>
      <Text
        numberOfLines={2}
        style={{
          fontFamily: font.sans,
          fontSize: 13,
          lineHeight: 18,
          color: mark ? ON_PAPER_FAINT : color.inkOnPaper,
        }}
      >
        {mark ? 'Bookmark' : note.text}
      </Text>
    </Pressable>
  );
}

export function ChapterNotes({
  notes,
  selectedId,
  onOpen,
}: {
  /** This chapter's notes, in the order they happen. */
  notes: Note[];
  selectedId: string | null;
  onOpen: (note: Note) => void;
}) {
  if (notes.length === 0) return null;

  return (
    <View style={{ paddingTop: 18, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.xxl }}>
        <Text
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            letterSpacing: 1,
            color: color.faint,
          }}
        >
          IN THIS CHAPTER · {notes.length}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: color.trough }} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingHorizontal: space.xxl, paddingBottom: 4 }}
      >
        {notes.map((note) => (
          <Slip
            key={note.id}
            note={note}
            selected={note.id === selectedId}
            onPress={() => onOpen(note)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * One note, read rather than edited.
 *
 * Opening a note while something is playing should not put a keyboard on
 * the screen. This is the reading step: the whole text, who it names, and
 * the two things worth doing with it.
 */
export function NoteReader({
  note,
  chapterLabel,
  characters,
  onPlayFrom,
  onEdit,
  onClose,
}: {
  note: Note | null;
  chapterLabel: string | null;
  characters: Character[];
  onPlayFrom: (sec: number) => void;
  onEdit: (note: Note) => void;
  onClose: () => void;
}) {
  if (!note) return null;

  const mark = isBookmark(note);
  const tagged = mentionSegments(note.text, characters)
    .map((segment) => segment.characterId)
    .filter((id, i, all): id is string => !!id && all.indexOf(id) === i)
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => !!c);

  return (
    <>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: 'rgba(10,7,5,0.55)',
          zIndex: 30,
        }}
      />
      <View
        style={[
          {
            position: 'absolute',
            left: 14,
            right: 14,
            bottom: 96,
            zIndex: 31,
            gap: 12,
            padding: 14,
            borderRadius: 4,
            backgroundColor: color.paperCardAlt,
          },
          shadow(18, 0.6),
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {mark ? <Ribbon width={8} height={15} notch={0.22} /> : null}
            <Text
              style={{
                fontFamily: font.monoMedium,
                fontSize: 12,
                color: color.stampOut,
              }}
            >
              {[chapterLabel, timestamp(note.positionSec)].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={10}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              margin: -8,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 16, color: ON_PAPER_FAINT }}>✕</Text>
          </Pressable>
        </View>

        <NoteText size={16} style={{ color: color.inkOnPaper, lineHeight: 26 }}>
          {mark ? 'Bookmark. No note yet.' : note.text}
        </NoteText>

        {tagged.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {tagged.map((character) => (
              <View
                key={character.id}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 12,
                  backgroundColor: 'rgba(91,58,138,0.14)',
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampOut }}>
                  @ {character.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            onPress={() => onPlayFrom(note.positionSec)}
            accessibilityRole="button"
            accessibilityLabel={`Play from ${timestamp(note.positionSec)}`}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 46,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 8,
              backgroundColor: color.inkOnPaper,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <PlayIcon size={11} fill={color.paperCardAlt} />
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.paperCardAlt }}>
              Play from here
            </Text>
          </Pressable>

          <Pressable
            onPress={() => onEdit(note)}
            accessibilityRole="button"
            accessibilityLabel="Edit this note"
            style={({ pressed }) => ({
              minHeight: Math.max(TOUCH, 46),
              justifyContent: 'center',
              paddingHorizontal: 16,
              borderWidth: 1.5,
              borderColor: '#7a6446',
              borderRadius: 8,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.inkOnPaper }}>
              Edit
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}
