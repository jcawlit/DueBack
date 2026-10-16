/**
 * One person, turned over: the card you get from the Characters tab, or
 * when you have just invented someone and they need a name.
 *
 * A sheet on the app's own surface with the form on paper inside it. The
 * two are doing different jobs — the sheet is chrome and belongs to the
 * app, the card is a record about a person and is the one thing here that
 * should look like it came out of a catalogue. Their notes sit below it on
 * the app's ground, because those are the listener's voice rather than a
 * record, and "add to bio" is the way across.
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
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { NoteText, useNoteFont } from './NoteText';
import { useKeyboardInset } from './useKeyboardInset';
import { PaperRules, RULE_PITCH } from './PaperCard';
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
     * Edge-to-edge Android does not resize a window for the keyboard, so
     * the height is read and applied as padding — the same arrangement as
     * `NoteSheet`, which explains it.
     */
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={commit}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,7,5,.6)' }}
      >
        <Pressable
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          onPress={commit}
          accessibilityLabel="Close"
        />

        {/*
          A sheet on the app's own surface, with the form on paper inside
          it. The two are doing different jobs: the sheet is chrome and
          belongs to the app, the card is a record about a person and is
          the one thing here that should look like it came out of a
          catalogue.
        */}
        <View
          style={{
            backgroundColor: color.panel,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingTop: 10,
            paddingHorizontal: space.lg,
            paddingBottom: Math.max(22, insets.bottom + 10) + keyboard,
            gap: space.md,
            maxHeight: '92%',
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: color.border,
            }}
          />

          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel, and keep them as they were"
              style={({ pressed }) => ({
                minHeight: TOUCH,
                justifyContent: 'center',
                paddingHorizontal: 8,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.muted }}>
                Cancel
              </Text>
            </Pressable>

            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: 1,
                color: color.faint,
              }}
            >
              CHARACTER
            </Text>

            <Pressable
              onPress={commit}
              accessibilityRole="button"
              accessibilityLabel="Save this character"
              style={({ pressed }) => ({
                minHeight: 40,
                justifyContent: 'center',
                paddingHorizontal: 16,
                borderRadius: 8,
                backgroundColor: color.accent,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontFamily: font.monoMedium, fontSize: 13, color: color.ground }}>
                Save
              </Text>
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
            <View
              style={[
                {
                  gap: 14,
                  paddingTop: space.lg,
                  paddingHorizontal: space.lg,
                  paddingBottom: 14,
                  backgroundColor: color.paperCardAlt,
                  borderRadius: 3,
                },
                shadow(8, 0.45),
              ]}
            >
              <View
                style={{
                  gap: 4,
                  paddingBottom: 8,
                  borderBottomWidth: 1.5,
                  borderBottomColor: color.warningInk,
                }}
              >
                <Text style={LABEL}>NAME</Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Name"
                  placeholderTextColor={ON_PAPER_FAINT}
                  selectionColor={color.stampOut}
                  accessibilityLabel="Name"
                  style={{
                    paddingVertical: 2,
                    fontFamily: font.serif,
                    fontSize: 26,
                    color: color.inkOnPaper,
                  }}
                />
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: ON_PAPER_FAINT }}>
                  {heard === null
                    ? 'Not heard yet · tag them in a note to mark where they appear'
                    : heardLabel(heard)}
                </Text>
              </View>

              <View style={{ gap: 4 }}>
                <Text style={LABEL}>ALSO KNOWN AS</Text>
                <TextInput
                  value={aliases}
                  onChangeText={setAliases}
                  placeholder="Rosy, Miss Vincy"
                  placeholderTextColor={ON_PAPER_FAINT}
                  selectionColor={color.stampOut}
                  accessibilityLabel="Also known as"
                  style={{
                    minHeight: 40,
                    fontFamily: font.sans,
                    fontSize: 16,
                    color: color.inkOnPaper,
                    borderBottomWidth: 1,
                    borderBottomColor: color.paperRule,
                  }}
                />
                <Text style={{ fontFamily: font.mono, fontSize: 10, color: ON_PAPER_FAINT }}>
                  separate with commas · these also work with @
                </Text>
              </View>

              <View style={{ gap: 4 }}>
                <Text style={LABEL}>WHO THEY ARE</Text>
                <View>
                  <PaperRules />
                  <TextInput
                    value={bio}
                    onChangeText={setBio}
                    multiline
                    placeholder="What you know about them so far"
                    placeholderTextColor={ON_PAPER_FAINT}
                    selectionColor={color.stampOut}
                    accessibilityLabel="Who they are"
                    /*
                     * The line height is the rule pitch, not a number that
                     * happens to match it. Ruling that nearly lines up with
                     * the writing reads as a mistake.
                     */
                    style={[
                      bioFont,
                      {
                        minHeight: RULE_PITCH * 3.2,
                        lineHeight: RULE_PITCH,
                        padding: 0,
                        paddingTop: 3,
                        color: color.inkOnPaper,
                        textAlignVertical: 'top',
                      },
                    ]}
                  />
                </View>
              </View>
            </View>

            {/*
              Their notes, on the app's ground rather than on the card. The
              card is what you know about them; these are the moments you
              wrote it from, and "add to bio" is the way across.
            */}
            {mine.map((note) => (
              <View key={note.id} style={{ paddingTop: space.md, gap: space.sm }}>
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
                            : `${bio.trim()}\n\n${note.text.trim()}`;
                        setBio(next);
                        onAddToBio(note.text);
                      }}
                    />
                  </>
                )}
              </View>
            ))}
          </ScrollView>

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: 4,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              {mine.length} {mine.length === 1 ? 'note' : 'notes'}
            </Text>

            {confirmingDelete ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                <RowAction label="really remove" tone="warning" onPress={onDelete} />
                <RowAction label="keep" onPress={() => setConfirmingDelete(false)} />
              </View>
            ) : (
              <Pressable
                onPress={() => setConfirmingDelete(true)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${character.name} from this book`}
                style={({ pressed }) => ({
                  minHeight: TOUCH,
                  justifyContent: 'center',
                  paddingHorizontal: 12,
                  borderWidth: 1,
                  borderColor: color.warningInk,
                  borderRadius: 8,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.warning }}>
                  Delete character
                </Text>
              </Pressable>
            )}
          </View>

          {confirmingDelete ? (
            <Text style={{ fontFamily: font.sans, fontSize: 13, lineHeight: 19, color: color.muted }}>
              Your notes stay exactly as they are — only the tags go.
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A field's name: said once, quietly, above the thing it names. */
const LABEL = {
  fontFamily: font.mono,
  fontSize: 10,
  letterSpacing: 1,
  color: '#5f4f38',
} as const;

/** The ink a hint takes on this stock. */
const ON_PAPER_FAINT = '#5f4f38';
