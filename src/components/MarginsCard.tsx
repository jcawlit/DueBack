/**
 * The margins: everything the listener wrote about this book, and everyone
 * they wrote about, as one thing rather than two tabs.
 *
 * Notes and characters were never separate subjects. A character is an index
 * *into* the notes — the question is always "what did I write about her" —
 * and a tab made you leave the notes to ask it, then leave the characters to
 * read the answer. Here the people are a strip of faces along the top and
 * the notes are the page below; tapping a face narrows the page.
 *
 * Untagged notes live under All and nowhere else. That is deliberate: a note
 * about nobody in particular belongs to the book, not to a person, and
 * filing it under someone would be inventing a connection the listener did
 * not make.
 *
 * On the screen's own dark ground. The section used to sit on a cream card,
 * which made the whole lower half of the Book screen read as a notepad
 * stuck to the app. The one place the paper is still the point is the
 * library card in the hero — that one is a library card, and looks it.
 */

import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import {
  charactersByFirstHeard,
  firstHeardSec,
  noteCountFor,
  notesForCharacter,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { fallbackPalette } from '@/lib/library/palette';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { Aside } from './Aside';
import { NotesCard } from './NotesCard';

/** Big enough to read two letters on, small enough that four fit across. */
const MEDALLION = 56;
/** The ring sits outside the disc, so selecting one does not resize it. */
const RING = 2.5;

/**
 * "Jane Eyre" → "JE", "Hyperion" → "HY".
 *
 * `Array.from` rather than indexing, so a name starting with an emoji or any
 * character outside the basic plane gives one whole character and not half
 * of a surrogate pair.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2)
      : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  return letters.join('').toUpperCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function heardLabel(sec: number | null): string {
  return sec === null ? 'not heard yet' : `first heard ${timestamp(sec)}`;
}

/** One face in the strip, or the All and Add discs at either end of it. */
function Medallion({
  label,
  caption,
  palette,
  selected,
  dashed = false,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  caption: string;
  /** Absent for All and Add, which are outlines rather than colours. */
  palette?: { bg: string; ink: string };
  selected: boolean;
  /** Marks the disc as a thing to fill rather than a thing already there. */
  dashed?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        width: MEDALLION + RING * 4,
        alignItems: 'center',
        gap: 4,
        paddingVertical: 2,
        minHeight: TOUCH,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View
        style={{
          width: MEDALLION + RING * 2,
          height: MEDALLION + RING * 2,
          borderRadius: (MEDALLION + RING * 2) / 2,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: RING,
          // The lamp, the way every other chosen thing on a dark screen
          // is marked. This surface is no longer paper.
          borderColor: selected ? color.accent : 'transparent',
        }}
      >
        <View
          style={{
            width: MEDALLION,
            height: MEDALLION,
            borderRadius: MEDALLION / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette ? palette.bg : 'transparent',
            /*
             * Everyone not chosen sits back. At full strength a row of
             * saturated discs is the loudest thing on a dark screen, and
             * which one is selected stops being the question it answers.
             */
            opacity: selected ? 1 : 0.55,
            borderWidth: palette ? 0 : 1.5,
            borderStyle: dashed ? 'dashed' : 'solid',
            borderColor: color.border,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              fontFamily: font.monoMedium,
              fontSize: palette ? 18 : dashed ? 20 : 14,
              letterSpacing: palette ? 1 : 0.5,
              color: palette ? palette.ink : color.muted,
            }}
          >
            {label}
          </Text>
        </View>
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontFamily: selected ? font.monoMedium : font.mono,
          fontSize: 11,
          color: selected ? color.paper : color.faint,
        }}
      >
        {caption}
      </Text>
    </Pressable>
  );
}

export function MarginsCard({
  book,
  notes,
  characters,
  selected,
  onSelect,
  onPlayFrom,
  onOpenNote,
  onOpenCharacter,
  onAddCharacter,
}: {
  book: Book;
  notes: Note[];
  characters: Character[];
  /** The character the page is narrowed to, or null for all of it. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  onPlayFrom: (sec: number) => void;
  onOpenNote: (note: Note) => void;
  onOpenCharacter: (character: Character) => void;
  /** Makes someone new and opens their card. Only shown where tagging works. */
  onAddCharacter?: () => void;
}) {
  const ordered = charactersByFirstHeard(characters, notes);
  // A character deleted while their notes were on screen must not leave the
  // page filtered to somebody who is no longer there.
  const person = selected ? (ordered.find((c) => c.id === selected) ?? null) : null;
  const shown = person ? notesForCharacter(person.id, notes) : notes;

  return (
    <View>
      {ordered.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingBottom: space.sm }}
          style={{ marginBottom: space.md }}
        >
          {/* Captioned like everyone else. The tally moved to the heading. */}
          <Medallion
            label="All"
            caption="All"
            selected={person === null}
            accessibilityLabel={`All notes, ${notes.length}`}
            onPress={() => onSelect(null)}
          />
          {ordered.map((character) => (
            <Medallion
              key={character.id}
              label={initialsFor(character.name)}
              caption={firstName(character.name)}
              palette={fallbackPalette(character.id)}
              selected={person?.id === character.id}
              accessibilityLabel={`${character.name}, ${noteCountFor(character.id, notes)} notes`}
              // Tapping the one already chosen puts the whole book back.
              onPress={() => onSelect(person?.id === character.id ? null : character.id)}
            />
          ))}

          {/*
            Last, not first: the strip is read left to right as the people in
            the book, and a control at the head of it would be the first face
            you see. It filters nothing, so it is never the selected one.
          */}
          {onAddCharacter ? (
            <Medallion
              label="+"
              caption="Add"
              dashed
              selected={false}
              accessibilityLabel="Add a character"
              onPress={onAddCharacter}
            />
          ) : null}
        </ScrollView>
      ) : null}

      {/*
        With nobody in the book there is no strip to hang the disc on, so the
        same action is a line of text instead. Without this, a book you have
        never tagged anyone in offers no way to start.
      */}
      {ordered.length === 0 && onAddCharacter ? (
        <Pressable
          onPress={onAddCharacter}
          accessibilityRole="button"
          accessibilityLabel="Add a character"
          hitSlop={8}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            minHeight: TOUCH,
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
            + Add character
          </Text>
        </Pressable>
      ) : null}

      {person ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingBottom: space.md,
            marginBottom: space.xs,
          }}
        >
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: fallbackPalette(person.id).bg,
            }}
          >
            <Text
              style={{
                fontFamily: font.monoMedium,
                fontSize: 12,
                color: fallbackPalette(person.id).ink,
              }}
            >
              {initialsFor(person.name)}
            </Text>
          </View>

          <View style={{ flex: 1, gap: 1 }}>
            <Text
              numberOfLines={1}
              style={{ fontFamily: font.serif, fontSize: 17, color: color.paper }}
            >
              {person.name}
            </Text>
            <Text
              numberOfLines={1}
              style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}
            >
              {heardLabel(firstHeardSec(person.id, notes))} · {shown.length}{' '}
              {shown.length === 1 ? 'note' : 'notes'}
            </Text>
          </View>

          <Pressable
            onPress={() => onOpenCharacter(person)}
            accessibilityRole="button"
            accessibilityLabel={`About ${person.name}`}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>About</Text>
          </Pressable>
        </View>
      ) : null}

      {person && shown.length === 0 ? (
        <Aside>{`No notes about ${person.name} yet.`}</Aside>
      ) : (
        <NotesCard
          book={book}
          notes={shown}
          characters={characters}
          onPlayFrom={onPlayFrom}
          onEdit={onOpenNote}
          onSelectCharacter={(id) => onSelect(id)}
        />
      )}
    </View>
  );
}
