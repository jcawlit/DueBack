/**
 * One person, turned over: the card you get when you tap About, or when you
 * have just invented someone and they need a name.
 *
 * On the app's own dark surface, not an index card. It used to carry the
 * same paper stock as the margins; the margins have since come off the
 * paper, and a person was never a card in a catalogue anyway — the frame
 * round them made this read as a form to fill in.
 *
 * The list that used to live here — everyone in the book, with a "+ Add
 * character" at the bottom — is gone. The margins are one section now and
 * the people are the medallion strip along its top; the strip's trailing
 * disc is where someone new comes from.
 */

import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  firstHeardSec,
  isBookmark,
  notesForCharacter,
  type Character,
  type Note,
} from '@/data/notes';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { NoteText, useNoteFont } from './NoteText';
import { useKeyboardInset } from './useKeyboardInset';
import { RowAction, TimeChip } from './NotesCard';

function heardLabel(sec: number | null): string {
  return sec === null ? 'not heard yet' : `first heard ${timestamp(sec)}`;
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
  /** The same inset the note sheet rides on; this one has fields too. */
  const keyboard = useKeyboardInset(!!character);
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
    /*
     * Edge-to-edge Android does not resize a window for the keyboard, so the
     * height is read and applied as padding — the same arrangement as
     * `NoteSheet`, which explains it. This sheet keeps its slide: nothing is
     * focused as it opens, so there is no keyboard motion to run against.
     */
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={commit}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{
          flex: 1,
          paddingTop: insets.top + space.md,
          paddingBottom: keyboard > 0 ? keyboard : Math.max(insets.bottom, space.md),
          paddingHorizontal: space.lg,
          backgroundColor: 'rgba(10,7,5,0.6)',
        }}
      >
        <Pressable style={{ height: 24 }} onPress={commit} accessibilityLabel="Close" />

        {/*
          The app's own surface, not an index card. The library card is the
          one place the paper is the point; a person is not a card in a
          catalogue, and framing them as one made this read as a form.
        */}
        <View
          style={{
            flex: 1,
            backgroundColor: color.panel,
            borderWidth: 1,
            borderColor: color.line,
            borderRadius: radius.button,
            overflow: 'hidden',
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
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              {heardLabel(heard)}
            </Text>
            <Pressable
              onPress={commit}
              accessibilityRole="button"
              hitSlop={8}
              style={{ minHeight: TOUCH, justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>done</Text>
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: space.xl, gap: space.md }}
          >
            {/* The name is the heading, so it is not dressed as a field. */}
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor={color.faint}
              selectionColor={color.accent}
              accessibilityLabel="Name"
              style={{
                fontFamily: font.serif,
                fontSize: 22,
                color: color.paper,
                paddingVertical: space.xs,
              }}
            />

            <View style={{ gap: space.xs }}>
              <Text style={LABEL}>ALSO KNOWN AS</Text>
              <TextInput
                value={aliases}
                onChangeText={setAliases}
                placeholder="Comma separated"
                placeholderTextColor={color.faint}
                selectionColor={color.accent}
                accessibilityLabel="Also known as"
                style={[FIELD, { fontFamily: font.mono, fontSize: 12 }]}
              />
            </View>

            <View style={{ gap: space.xs }}>
              <Text style={LABEL}>WHO THEY ARE</Text>
              <TextInput
                value={bio}
                onChangeText={setBio}
                multiline
                placeholder="What you know about them so far"
                placeholderTextColor={color.faint}
                selectionColor={color.accent}
                accessibilityLabel="Who they are"
                style={[bioFont, FIELD, { minHeight: 80, textAlignVertical: 'top' }]}
              />
            </View>

            <Text style={[LABEL, { paddingTop: space.md }]}>
              {mine.length} {mine.length === 1 ? 'NOTE' : 'NOTES'}
            </Text>

            {/*
              The same quiet setting as the margins: no box round a note, no
              rule under it. Space is what separates them.
            */}
            {mine.map((note) => (
              <View key={note.id} style={{ paddingVertical: space.sm, gap: space.sm }}>
                <TimeChip atSec={note.positionSec} onPress={() => onPlayFrom(note.positionSec)} />
                {isBookmark(note) ? (
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                    bookmark
                  </Text>
                ) : (
                  <>
                    <NoteText size={15}>{note.text}</NoteText>
                    <RowAction
                      label="+ add to bio"
                      onPress={() => {
                        const next = bio.trim().length === 0
                          ? note.text.trim()
                          : bio.includes(note.text.trim())
                            ? bio
                            : `${bio.trim()}

${note.text.trim()}`;
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
                  <Text style={{ fontFamily: font.sans, fontSize: 13, lineHeight: 19, color: color.muted }}>
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

/** A field's name: said once, quietly, above the thing it names. */
const LABEL = {
  fontFamily: font.mono,
  fontSize: 11,
  letterSpacing: 1,
  color: color.faint,
} as const;

/** An input on the dark surface: a line under it, and no box round it. */
const FIELD = {
  paddingVertical: space.sm,
  borderBottomWidth: 1,
  borderBottomColor: color.line,
  color: color.paper,
} as const;
