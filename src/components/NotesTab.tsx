/**
 * What was written while listening, under the chapter it was written in.
 *
 * A row of names across the top narrows the list to one person; everything
 * else is the writing itself. Names inside a note are highlighted and can
 * be pressed, so the question "what else did I write about her" is asked
 * from the thing that prompted it.
 *
 * Untagged notes appear under All and nowhere else. A note about nobody in
 * particular belongs to the book, and filing it under someone would invent
 * a connection the listener did not make.
 */

import { Fragment } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import {
  charactersByFirstHeard,
  groupNotesByChapter,
  isBookmark,
  notesForCharacter,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { Aside } from './Aside';
import { mentionSegments } from './mentionText';
import { NoteText } from './NoteText';
import { Ribbon } from './Ribbon';

/** The time column, wide enough for `12:34:56` and the same on every row. */
const TIME_COLUMN = 72;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** One name in the row along the top. */
function FilterChip({
  label,
  selected,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  selected: boolean;
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
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: 13,
        borderTopLeftRadius: 7,
        borderTopRightRadius: 7,
        borderWidth: 1,
        // The chosen one is cut from the same paper the characters' cards
        // are, so the row reads as tabs on a file rather than buttons.
        backgroundColor: selected ? color.paperCardAlt : color.trough,
        borderColor: selected ? color.paperCardAlt : color.line,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          fontFamily: font.sans,
          fontSize: 14,
          color: selected ? color.inkOnPaper : color.muted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function NotesTab({
  book,
  notes,
  characters,
  selected,
  onSelect,
  onPlayFrom,
  onOpenNote,
  onExport,
}: {
  book: Book;
  notes: Note[];
  characters: Character[];
  /** The character the list is narrowed to, or null for the whole book. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  onPlayFrom: (sec: number) => void;
  onOpenNote: (note: Note) => void;
  onExport: () => void;
}) {
  const ordered = charactersByFirstHeard(characters, notes);
  // A character deleted while their notes were on screen must not leave the
  // list filtered to somebody who is no longer there.
  const person = selected ? (ordered.find((c) => c.id === selected) ?? null) : null;
  const shown = person ? notesForCharacter(person.id, notes) : notes;

  const written = shown.filter((n) => !isBookmark(n)).length;
  const marked = shown.length - written;
  const summary = person
    ? `${written} ${written === 1 ? 'note' : 'notes'} tagging ${firstName(person.name)}`
    : `${written} ${written === 1 ? 'note' : 'notes'} · ${marked} ${marked === 1 ? 'bookmark' : 'bookmarks'}`;

  const groups = groupNotesByChapter(shown, book.chapters, book.title);

  return (
    <View>
      {ordered.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingHorizontal: space.xl }}
          style={{ paddingTop: space.md, borderBottomWidth: 1, borderBottomColor: color.line }}
        >
          <FilterChip
            label="All"
            selected={person === null}
            accessibilityLabel={`All notes, ${notes.length}`}
            onPress={() => onSelect(null)}
          />
          {ordered.map((character) => (
            <FilterChip
              key={character.id}
              label={firstName(character.name)}
              selected={person?.id === character.id}
              accessibilityLabel={`Only notes about ${character.name}`}
              // Pressing the one already chosen puts the whole book back.
              onPress={() => onSelect(person?.id === character.id ? null : character.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: space.xl,
          paddingRight: space.md,
          paddingTop: space.xs,
        }}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>{summary}</Text>
        <Pressable
          onPress={onExport}
          accessibilityRole="button"
          accessibilityLabel="Export these notes"
          hitSlop={8}
          style={({ pressed }) => ({
            minHeight: TOUCH,
            justifyContent: 'center',
            paddingHorizontal: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>Export</Text>
        </Pressable>
      </View>

      {shown.length === 0 ? (
        <View style={{ paddingHorizontal: space.xl }}>
          <Aside>
            {person
              ? `No notes tag ${firstName(person.name)} yet.`
              : 'Nothing written yet. The pencil in the player marks where you are, and anything you type lands here.'}
          </Aside>
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.chapterIndex} style={{ paddingHorizontal: space.xl }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingTop: space.lg,
              paddingBottom: space.xs,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                flexShrink: 1,
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: 1,
                color: color.faint,
              }}
            >
              {group.title.toUpperCase()}
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: color.trough }} />
          </View>

          {group.notes.map((note) => (
            <Pressable
              key={note.id}
              onPress={() => (isBookmark(note) ? onPlayFrom(note.positionSec) : onOpenNote(note))}
              accessibilityRole="button"
              accessibilityLabel={
                isBookmark(note)
                  ? `Bookmark at ${timestamp(note.positionSec)}. Play from here.`
                  : `Note at ${timestamp(note.positionSec)}. Open it.`
              }
              style={({ pressed }) => ({
                flexDirection: 'row',
                gap: 10,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: color.trough,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              {/*
                The time is its own control: pressing it plays from there,
                where pressing the note opens what you wrote. Two things to
                want from one line, so they are two targets.
              */}
              <Pressable
                onPress={() => onPlayFrom(note.positionSec)}
                accessibilityRole="button"
                accessibilityLabel={`Play from ${timestamp(note.positionSec)}`}
                hitSlop={10}
                style={({ pressed }) => ({
                  width: TIME_COLUMN,
                  minHeight: 32,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                  {timestamp(note.positionSec)}
                </Text>
              </Pressable>

              {isBookmark(note) ? (
                <View
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}
                >
                  <Ribbon width={8} height={16} notch={0.25} />
                  <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.faint }}>
                    Bookmark
                  </Text>
                </View>
              ) : (
                <View style={{ flex: 1 }}>
                  <NoteText size={15}>
                    {mentionSegments(note.text, characters).map((segment, i) => (
                      <Fragment key={i}>
                        {segment.characterId ? (
                          <Text
                            onPress={() => onSelect(segment.characterId ?? null)}
                            style={{
                              color: color.mentionInk,
                              backgroundColor:
                                segment.characterId === person?.id
                                  ? color.mentionWashOn
                                  : color.mentionWash,
                              borderRadius: radius.cover,
                            }}
                          >
                            {` ${segment.text} `}
                          </Text>
                        ) : (
                          segment.text
                        )}
                      </Fragment>
                    ))}
                  </NoteText>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
