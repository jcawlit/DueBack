/**
 * Who's who: the index card for every person in a book, and the card you get
 * when you turn one over.
 *
 * Ordered by when you first heard of them rather than alphabetically, because
 * the question this answers is "who was that again", and the answer is nearly
 * always someone met recently or met at the very start.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  charactersByFirstHeard,
  firstHeardSec,
  isBookmark,
  noteCountFor,
  notesForCharacter,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { NoteText, useNoteFont } from './NoteText';
import { EmptyPanel, RowAction, TimeChip } from './BookTabs';

function heardLabel(sec: number | null): string {
  return sec === null ? 'not heard yet' : `first heard ${timestamp(sec)}`;
}

export function WhosWhoPanel({
  characters,
  notes,
  onOpen,
  onAdd,
}: {
  characters: Character[];
  notes: Note[];
  onOpen: (character: Character) => void;
  onAdd: () => void;
}) {
  const ordered = charactersByFirstHeard(characters, notes);

  return (
    <View style={{ paddingTop: space.md, gap: space.sm }}>
      {ordered.length === 0 ? (
        <EmptyPanel>
          Nobody yet. Type @ in a note to tag someone, or add them here.
        </EmptyPanel>
      ) : null}

      {ordered.map((character) => {
        const heard = firstHeardSec(character.id, notes);
        const count = noteCountFor(character.id, notes);
        return (
          <Pressable
            key={character.id}
            onPress={() => onOpen(character)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              marginHorizontal: space.xxl,
              padding: space.md,
              borderWidth: 1,
              borderColor: color.line,
              borderRadius: radius.button,
              gap: space.xs,
              backgroundColor: pressed ? color.panel : 'transparent',
            })}
          >
            <Text style={{ fontFamily: font.serif, fontSize: 17, color: color.paper }}>
              {character.name}
            </Text>
            {character.bio.trim().length > 0 ? (
              <NoteText numberOfLines={2} size={14} tone="muted">
                {character.bio}
              </NoteText>
            ) : null}
            <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
              {heardLabel(heard)} · {count} {count === 1 ? 'note' : 'notes'}
            </Text>
          </Pressable>
        );
      })}

      <Pressable
        onPress={onAdd}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginHorizontal: space.xxl,
          minHeight: TOUCH,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: color.border,
          borderRadius: radius.button,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
          + Add character
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * One person, turned over.
 *
 * The bio is its own field and never the first note. A note is a thing the
 * listener wrote at a moment in the story; a bio is what they know about
 * someone now, and conflating the two means the first thing you ever wrote
 * about a character becomes their description for ever.
 */
export function CharacterSheet({
  character,
  notes,
  onSave,
  onDelete,
  onPlayFrom,
  onAddToBio,
  onClose,
}: {
  character: Character | null;
  notes: Note[];
  onSave: (fields: { name: string; aliases: string; bio: string }) => void;
  onDelete: () => void;
  onPlayFrom: (sec: number) => void;
  onAddToBio: (text: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bioFont = useNoteFont(16);
  const [name, setName] = useState(character?.name ?? '');
  const [aliases, setAliases] = useState(character?.aliases ?? '');
  const [bio, setBio] = useState(character?.bio ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!character) return null;

  const mine = notesForCharacter(character.id, notes);
  const heard = firstHeardSec(character.id, notes);

  const commit = () => {
    onSave({ name, aliases, bio });
    onClose();
  };

  return (
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={commit}>
      <View style={{ flex: 1, backgroundColor: 'rgba(10,7,5,0.6)' }}>
        <Pressable style={{ height: 70 }} onPress={commit} accessibilityLabel="Close" />
        <View
          style={{
            flex: 1,
            backgroundColor: color.ground,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            borderTopWidth: 1,
            borderColor: color.line,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: space.xl,
              paddingTop: space.lg,
              paddingBottom: space.sm,
              borderBottomWidth: 1,
              borderBottomColor: color.line,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
              {heardLabel(heard)}
            </Text>
            <Pressable onPress={commit} accessibilityRole="button" hitSlop={12}>
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                done
              </Text>
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: space.xl,
              paddingBottom: insets.bottom + 40,
              gap: space.md,
            }}
          >
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor={color.faint}
              style={{
                fontFamily: font.serif,
                fontSize: 22,
                color: color.paper,
                paddingVertical: space.xs,
              }}
            />
            <TextInput
              value={aliases}
              onChangeText={setAliases}
              placeholder="Also known as (comma separated)"
              placeholderTextColor={color.faint}
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: color.muted,
                paddingVertical: space.xs,
              }}
            />

            <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
              WHO THEY ARE
            </Text>
            <TextInput
              value={bio}
              onChangeText={setBio}
              multiline
              placeholder="What you know about them so far"
              placeholderTextColor={color.faint}
              style={[
                bioFont,
                {
                  minHeight: 80,
                  padding: space.md,
                  borderWidth: 1,
                  borderColor: color.line,
                  borderRadius: radius.button,
                  color: color.paper,
                  textAlignVertical: 'top',
                },
              ]}
            />

            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 10,
                letterSpacing: 1,
                color: color.faint,
                paddingTop: space.sm,
              }}
            >
              {mine.length} {mine.length === 1 ? 'NOTE' : 'NOTES'}
            </Text>

            {mine.map((note) => (
              <View
                key={note.id}
                style={{
                  padding: space.md,
                  borderWidth: 1,
                  borderColor: color.line,
                  borderRadius: radius.button,
                  gap: space.sm,
                }}
              >
                <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                {isBookmark(note) ? (
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
                    bookmark
                  </Text>
                ) : (
                  <>
                    <NoteText>{note.text}</NoteText>
                    <RowAction
                      label="+ add to bio"
                      onPress={() => {
                        const next = bio.trim().length === 0
                          ? note.text.trim()
                          : bio.includes(note.text.trim())
                            ? bio
                            : `${bio.trim()}\n\n${note.text.trim()}`;
                        setBio(next);
                        onAddToBio(note.text);
                      }}
                    />
                  </>
                )}
              </View>
            ))}

            <View style={{ paddingTop: space.xl }}>
              {confirmingDelete ? (
                <View style={{ gap: space.sm }}>
                  <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>
                    Remove {character.name} from this book? Your notes stay exactly as they
                    are — only the tags go.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: space.lg }}>
                    <RowAction label="remove" tone="warning" onPress={onDelete} />
                    <RowAction label="keep" onPress={() => setConfirmingDelete(false)} />
                  </View>
                </View>
              ) : (
                <RowAction
                  label="remove this character"
                  tone="warning"
                  onPress={() => setConfirmingDelete(true)}
                />
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
