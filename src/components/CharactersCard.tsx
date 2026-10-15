/**
 * The characters card: everyone in this book, and the card you get when you
 * turn one of them over.
 *
 * Ordered by when you first heard of them rather than alphabetically, because
 * the question this answers is "who was that again", and the answer is nearly
 * always someone met recently or met at the very start.
 *
 * The editor is a sheet of its own, and carries the same stock with it so
 * that turning a card over does not change what it is made of.
 *
 * `CharactersCard` — the list — has no caller since the margins became one
 * section with a medallion strip. It is left here rather than deleted
 * because it holds the only "+ Add character" affordance the app ever had;
 * characters are now made by typing @ in a note.
 */

import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
import { CardEmpty, paperCardStyle } from './PaperCard';
import { RowAction, TimeChip } from './NotesCard';

function heardLabel(sec: number | null): string {
  return sec === null ? 'not heard yet' : `first heard ${timestamp(sec)}`;
}

export function CharactersCard({
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
    <View>
      {ordered.length === 0 ? (
        <CardEmpty>Nobody yet. Type @ in a note to tag someone, or add them here.</CardEmpty>
      ) : null}

      {ordered.map((character) => {
        const heard = firstHeardSec(character.id, notes);
        const count = noteCountFor(character.id, notes);
        return (
          <Pressable
            key={character.id}
            onPress={() => onOpen(character)}
            accessibilityRole="button"
            accessibilityHint="Opens their card"
            style={({ pressed }) => ({
              paddingVertical: space.sm,
              gap: 3,
              borderBottomWidth: 1,
              borderBottomColor: color.paperRule,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.serif, fontSize: 17, color: color.inkOnPaper }}>
              {character.name}
            </Text>
            {character.bio.trim().length > 0 ? (
              <NoteText numberOfLines={2} size={14} style={{ color: color.inkOnPaper }}>
                {character.bio}
              </NoteText>
            ) : null}
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampFaded }}>
              {heardLabel(heard)} · {count} {count === 1 ? 'note' : 'notes'}
            </Text>
          </Pressable>
        );
      })}

      <Pressable
        onPress={onAdd}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginTop: space.md,
          minHeight: TOUCH,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: color.paperRule,
          borderRadius: radius.button,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.stampOut }}>
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingTop: insets.top + space.md, paddingBottom: Math.max(insets.bottom, space.md), paddingHorizontal: space.lg, backgroundColor: 'rgba(10,7,5,0.6)' }}>
        <Pressable style={{ height: 24 }} onPress={commit} accessibilityLabel="Close" />
        <View
          style={{
            flex: 1,
            ...paperCardStyle,
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
              borderBottomColor: color.paperRule,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.wood }}>
              {heardLabel(heard)}
            </Text>
            <Pressable onPress={commit} accessibilityRole="button" hitSlop={8} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.stampOut }}>
                done
              </Text>
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: space.xl,
              paddingBottom: space.xl,
              gap: space.md,
            }}
          >
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor={color.wood}
              style={{
                fontFamily: font.serif,
                fontSize: 22,
                color: color.inkOnPaper,
                paddingVertical: space.xs,
              }}
            />
            <TextInput
              value={aliases}
              onChangeText={setAliases}
              placeholder="Also known as (comma separated)"
              placeholderTextColor={color.wood}
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: color.wood,
                paddingVertical: space.xs,
              }}
            />

            <Text style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1, color: color.wood }}>
              WHO THEY ARE
            </Text>
            <TextInput
              value={bio}
              onChangeText={setBio}
              multiline
              placeholder="What you know about them so far"
              placeholderTextColor={color.wood}
              style={[
                bioFont,
                {
                  minHeight: 80,
                  padding: space.md,
                  borderWidth: 1,
                  borderColor: color.paperRule,
                  borderRadius: radius.button,
                  color: color.inkOnPaper,
                  textAlignVertical: 'top',
                },
              ]}
            />

            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: 1,
                color: color.wood,
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
                  borderColor: color.paperRule,
                  borderRadius: radius.button,
                  gap: space.sm,
                }}
              >
                <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                {isBookmark(note) ? (
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.wood }}>
                    bookmark
                  </Text>
                ) : (
                  <>
                    <NoteText style={{ color: color.inkOnPaper }}>{note.text}</NoteText>
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
                  <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.wood }}>
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
      </KeyboardAvoidingView>
    </Modal>
  );
}
