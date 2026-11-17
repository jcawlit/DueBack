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
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  firstHeardSec,
  isBookmark,
  notesForCharacter,
  type Character,
  type Note,
} from '@/data/notes';
import { chapterAt, type Book } from '@/data/types';
import { timestamp } from '@/lib/format';
import { bioTextFrom } from './mentionText';
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { NoteText, useNoteFont } from './NoteText';
import { PaperRules, RULE_PITCH } from './PaperCard';
import { RowAction, TimeChip } from './NotesCard';

/**
 * "first heard Ch. 11 · 4:31:55".
 *
 * The chapter first, because that is where someone remembers meeting a
 * character; the time is what plays it back.
 */
function heardLabel(book: Book, sec: number | null): string {
  if (sec === null) return 'not heard yet';
  const chapter = book.chapters.length > 0 ? `Ch. ${chapterAt(book, sec).index + 1} · ` : '';
  return `first heard ${chapter}${timestamp(sec)}`;
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
  book,
  character,
  creating = false,
  characters,
  notes,
  onSave,
  onDelete,
  onPlayFrom,
  onAddToBio,
  onClose,
}: {
  book: Book;
  /** The character being edited, or null while one is being invented. */
  character: Character | null;
  /**
   * Making somebody new.
   *
   * Nothing is written until Save. The old flow created the row first with
   * the placeholder name "New character", which meant backing out left one
   * behind — and a book could end up with several of them.
   */
  creating?: boolean;
  /** Everyone already in this book, so a name cannot be used twice. */
  characters: Character[];
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

  if (!creating && !character) return null;

  const mine = character ? notesForCharacter(character.id, notes) : [];
  const heard = character ? firstHeardSec(character.id, notes) : null;

  /*
   * Save is off until the name is both there and this book's own.
   *
   * Two characters with the same name cannot be told apart in a mention,
   * in the strip, or in the list — the tag would be ambiguous at the exact
   * moment it is supposed to be doing work.
   */
  const trimmed = name.trim();
  const clash = characters.some(
    (c) => c.id !== character?.id && c.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  const canSave = trimmed.length > 0 && !clash;

  const commit = () => {
    if (!canSave) return;
    onSave({ name: trimmed, aliases, bio });
    onClose();
  };

  return (
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      {/*
        A provider of its own: a Modal is a separate window, and the one
        wrapping the app cannot see this one's insets. The keyboard is read
        from its own animation, because an edge-to-edge Android window is
        never resized for it.
      */}
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: color.scrimSoft }}>
        {/*
          Pressing away from the sheet closes it and keeps nothing. It used
          to save, which made the backdrop a hidden second Save button — and
          a dangerous one, since it is what a thumb finds by accident.
        */}
        <Pressable
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          onPress={onClose}
          accessibilityLabel="Close without saving"
        />

        <KeyboardAvoidingView behavior="padding">
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
            paddingBottom: Math.max(22, insets.bottom + 10),
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
              {creating ? 'NEW CHARACTER' : 'CHARACTER'}
            </Text>

            <Pressable
              onPress={commit}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="Save this character"
              accessibilityState={{ disabled: !canSave }}
              style={({ pressed }) => ({
                minHeight: 40,
                justifyContent: 'center',
                paddingHorizontal: 16,
                borderRadius: 8,
                backgroundColor: color.accent,
                opacity: !canSave ? 0.35 : pressed ? 0.85 : 1,
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
                <Text
                  style={{
                    fontFamily: font.mono,
                    fontSize: 11,
                    color: clash ? color.warningInk : ON_PAPER_FAINT,
                  }}
                >
                  {clash
                    ? 'Somebody in this book already has that name'
                    : trimmed.length === 0
                      ? 'A name is needed before this can be saved'
                      : heard === null
                        ? 'Not heard yet · tag them in a note to mark where they appear'
                        : heardLabel(book, heard)}
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
                        // As prose, not as the note was typed: mentions
                        // become names and a half-written one is dropped.
                        const clean = bioTextFrom(note.text, characters);
                        if (!clean) return;
                        const next = bio.trim().length === 0
                          ? clean
                          : bio.includes(clean)
                            ? bio
                            : `${bio.trim()}\n\n${clean}`;
                        setBio(next);
                        onAddToBio(clean);
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

            {!character ? null : confirmingDelete ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                <RowAction label="really remove" tone="warning" onPress={onDelete} />
                <RowAction label="keep" onPress={() => setConfirmingDelete(false)} />
              </View>
            ) : (
              /* Nothing to delete while somebody is still being invented. */
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
      </View>
      </KeyboardProvider>
    </Modal>
  );
}

/** A field's name: said once, quietly, above the thing it names. */
const LABEL = {
  fontFamily: font.mono,
  fontSize: 10,
  letterSpacing: 1,
  color: color.inkOnPaperFaint,
} as const;

/** The ink a hint takes on this stock. */
const ON_PAPER_FAINT = color.inkOnPaperFaint;
