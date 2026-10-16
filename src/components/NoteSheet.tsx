/**
 * Writing a note, on a slip of paper that rides the keyboard.
 *
 * **Nothing is written until Save.** The pencil used to save the bookmark
 * first and ask afterwards, which meant a sheet opened by accident left a
 * bookmark behind, and there was no way to change your mind except to find
 * the thing and delete it. Save with nothing typed is a bookmark; Save with
 * something typed is a note; anything else — the backdrop, the back button,
 * the screen moving on — keeps nothing.
 *
 * The text is therefore held here, not in the store, until it is saved.
 *
 * The field is **not** focused on open, deliberately. A keyboard that
 * arrives uninvited while you are walking is a keyboard in the way of the
 * thing you wanted to read.
 */

import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Character, Note } from '@/data/notes';
import { insertMention, mentionQueryAt, suggestCharacters } from '@/lib/notes/mentions';
import { timestamp } from '@/lib/format';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { useNoteFont } from './NoteText';
import { mentionSegments } from './mentionText';

/** The ruled line, and the line height anything written on it must use. */
const RULE = 27;
/** Three lines to start, six before it scrolls. */
const MIN_LINES = 3;
const MAX_LINES = 6;

/** The ink a label takes on this stock. */
const ON_PAPER_FAINT = '#5f4f38';
const ON_PAPER_RULE = '#d3c4a2';

type Props = {
  visible: boolean;
  /** The note being edited, or null when this is a new one. */
  note: Note | null;
  /** Where a new one would land, for the header. */
  atSec: number;
  /** The chapter it sits in, for the header. */
  chapterLabel: string | null;
  characters: Character[];
  canTag: boolean;
  /** Commits it: empty text is a bookmark, anything else is a note. */
  onSave: (text: string) => void;
  onAddCharacter: (name: string, bio: string) => Promise<Character | null>;
  /**
   * Throw this note away.
   *
   * Behind the ⋯ and a confirmation, not beside Save. A delete sitting next
   * to the way out is a delete somebody will press on their way out. Only
   * for a note that exists; a draft is discarded by leaving.
   */
  onDelete: (note: Note) => void;
  onClose: () => void;
};

export function NoteSheet({ visible, note, atSec, chapterLabel, characters, canTag,
  onSave, onAddCharacter, onDelete, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [selection, setSelection] = useState(0);
  const [cursorTarget, setCursorTarget] = useState<{ start: number; end: number }>();
  /*
   * The draft lives here until Save. The component is keyed on the note it
   * is editing, so a different note is a different component and this is
   * initialised fresh rather than synchronised in an effect.
   */
  const [text, setText] = useState(note?.text ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [newBio, setNewBio] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const noteFont = useNoteFont(17);

  const mention = canTag ? mentionQueryAt(text, selection) : null;
  const matches = mention ? suggestCharacters(mention.query, characters) : [];
  const exact = matches.some((c) => c.name.toLowerCase() === mention?.query.trim().toLowerCase());
  const refocus = () => requestAnimationFrame(() => inputRef.current?.focus());

  /** Who this note already names, read back out of what was typed. */
  const tagged = mentionSegments(text, characters)
    .map((segment) => segment.characterId)
    .filter((id, i, all): id is string => !!id && all.indexOf(id) === i)
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => !!c);

  const pick = (name: string) => {
    const next = insertMention(text, selection, name);
    setText(next.text);
    setSelection(next.cursor);
    setCursorTarget({ start: next.cursor, end: next.cursor });
    refocus();
  };

  const createAndPick = async () => {
    const name = (newName ?? '').trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const character = await onAddCharacter(name, newBio.trim());
      if (!character) { setCreateError('Could not add the character. Try again.'); return; }
      setNewName(null);
      setNewBio('');
      pick(character.name);
    } catch {
      setCreateError('Could not add the character. Try again.');
    } finally { setCreating(false); }
  };

  const header = [chapterLabel, timestamp(note?.positionSec ?? atSec)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={onClose}>
      {/*
        A provider of its own: a Modal is a separate window, and the one
        wrapping the app cannot see this one's insets.
      */}
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,7,5,0.55)' }}>
          <Pressable
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
            onPress={onClose}
            accessibilityLabel="Close note"
          />

          <KeyboardAvoidingView behavior="padding">
            <View
              style={{
                backgroundColor: color.paperCardAlt,
                borderTopLeftRadius: 14,
                borderTopRightRadius: 14,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingLeft: 18,
                  paddingRight: 10,
                  paddingTop: 8,
                  paddingBottom: 4,
                }}
              >
                <Text
                  style={{
                    fontFamily: font.monoMedium,
                    fontSize: 12,
                    letterSpacing: 0.5,
                    color: color.stampOut,
                  }}
                >
                  {header}
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  {note && newName === null ? (
                    <Pressable
                      onPress={() => setConfirmingDelete((on) => !on)}
                      accessibilityRole="button"
                      accessibilityLabel="More: delete this note"
                      accessibilityState={{ expanded: confirmingDelete }}
                      style={({ pressed }) => ({
                        width: TOUCH,
                        height: TOUCH,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Text style={{ fontFamily: font.monoMedium, fontSize: 18, color: ON_PAPER_FAINT }}>
                        ⋯
                      </Text>
                    </Pressable>
                  ) : null}

                  <Pressable
                    onPress={
                      newName === null ? () => onSave(text) : () => void createAndPick()
                    }
                    disabled={newName !== null && (creating || !newName.trim())}
                    accessibilityRole="button"
                    style={({ pressed }) => ({
                      minHeight: 38,
                      justifyContent: 'center',
                      paddingHorizontal: 16,
                      borderRadius: 8,
                      backgroundColor: color.inkOnPaper,
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.paperCardAlt }}>
                      {newName === null ? 'Save' : creating ? 'Adding…' : 'Add character'}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {confirmingDelete && note ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 18,
                    paddingBottom: 6,
                  }}
                >
                  <Text style={{ fontFamily: font.sans, fontSize: 13, color: ON_PAPER_FAINT }}>
                    Delete this note?
                  </Text>
                  <View style={{ flexDirection: 'row', gap: space.lg }}>
                    <Pressable
                      onPress={() => { onDelete(note); onClose(); }}
                      accessibilityRole="button"
                      hitSlop={8}
                      style={{ minHeight: TOUCH, justifyContent: 'center' }}
                    >
                      <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.warningInk }}>
                        delete
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setConfirmingDelete(false)}
                      accessibilityRole="button"
                      hitSlop={8}
                      style={{ minHeight: TOUCH, justifyContent: 'center' }}
                    >
                      <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.inkOnPaper }}>
                        keep
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {newName === null ? (
                <>
                  <TextInput
                    ref={inputRef}
                    value={text}
                    selection={cursorTarget}
                    onChangeText={(value) => { setCursorTarget(undefined); setText(value); }}
                    onSelectionChange={(e) => {
                      setSelection(e.nativeEvent.selection.start);
                      setCursorTarget(undefined);
                    }}
                    // Never on open: see the note at the top of this file.
                    autoFocus={false}
                    multiline
                    scrollEnabled
                    accessibilityLabel="Note text"
                    placeholder="Leave a thought here…"
                    placeholderTextColor={ON_PAPER_FAINT}
                    selectionColor={color.stampOut}
                    /*
                     * The line height is the rule pitch, not a number that
                     * happens to match it. Ruling that nearly lines up with
                     * the writing reads as a mistake.
                     */
                    style={[
                      noteFont,
                      {
                        marginHorizontal: 18,
                        minHeight: RULE * MIN_LINES,
                        maxHeight: RULE * MAX_LINES,
                        lineHeight: RULE,
                        padding: 0,
                        color: color.inkOnPaper,
                        textAlignVertical: 'top',
                      },
                    ]}
                  />

                  {tagged.length > 0 ? (
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        gap: 6,
                        paddingHorizontal: 18,
                        paddingTop: 8,
                      }}
                    >
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
                </>
              ) : (
                <View style={{ paddingHorizontal: 18, gap: space.sm }}>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    autoFocus
                    accessibilityLabel="Character name"
                    placeholder="Name"
                    placeholderTextColor={ON_PAPER_FAINT}
                    selectionColor={color.stampOut}
                    style={fieldStyle}
                  />
                  <TextInput
                    value={newBio}
                    onChangeText={setNewBio}
                    accessibilityLabel="Character bio"
                    placeholder="Who are they? (optional)"
                    placeholderTextColor={ON_PAPER_FAINT}
                    selectionColor={color.stampOut}
                    style={[fieldStyle, noteFont]}
                  />
                  {createError ? (
                    <Text accessibilityRole="alert" style={{ color: color.warningInk }}>
                      {createError}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={() => { setNewName(null); refocus(); }}
                    disabled={creating}
                    accessibilityRole="button"
                    style={{ minHeight: TOUCH, justifyContent: 'center' }}
                  >
                    <Text style={{ fontFamily: font.mono, fontSize: 12, color: ON_PAPER_FAINT }}>
                      Cancel
                    </Text>
                  </Pressable>
                </View>
              )}

              {/*
                The suggestions sit on the sheet's own bottom edge, directly
                above the keyboard — a strip, not a popup. A floating list
                over the text covers the sentence being written.
              */}
              {canTag && newName === null ? (
                <View
                  style={{
                    marginTop: 8,
                    borderTopWidth: 1,
                    borderTopColor: ON_PAPER_RULE,
                    backgroundColor: '#e3d5b5',
                    paddingBottom: Math.max(insets.bottom, 10),
                  }}
                >
                  {mention ? (
                    <ScrollView
                      horizontal
                      keyboardShouldPersistTaps="always"
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingVertical: 10 }}
                    >
                      {matches.map((character) => (
                        <Pressable
                          key={character.id}
                          onPress={() => pick(character.name)}
                          accessibilityRole="button"
                          style={({ pressed }) => ({
                            minHeight: 38,
                            justifyContent: 'center',
                            paddingHorizontal: 12,
                            borderRadius: 19,
                            backgroundColor: color.inkOnPaper,
                            opacity: pressed ? 0.8 : 1,
                          })}
                        >
                          <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.paperCardAlt }}>
                            {character.name}
                          </Text>
                        </Pressable>
                      ))}
                      {exact ? null : (
                        <Pressable
                          onPress={() => {
                            setNewName(mention.query.trim());
                            setNewBio('');
                            setCreateError('');
                          }}
                          accessibilityRole="button"
                          style={({ pressed }) => ({
                            minHeight: 38,
                            justifyContent: 'center',
                            paddingHorizontal: 12,
                            borderRadius: 19,
                            borderWidth: 1,
                            borderStyle: 'dashed',
                            borderColor: '#7a5aa8',
                            opacity: pressed ? 0.6 : 1,
                          })}
                        >
                          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.stampOut }}>
                            {`+ New "${mention.query.trim()}"`}
                          </Text>
                        </Pressable>
                      )}
                    </ScrollView>
                  ) : (
                    <Text
                      style={{
                        fontFamily: font.mono,
                        fontSize: 11,
                        color: ON_PAPER_FAINT,
                        paddingHorizontal: 18,
                        paddingVertical: 12,
                      }}
                    >
                      @ to tag a character · nothing is kept until Save
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          </KeyboardAvoidingView>
        </View>
      </KeyboardProvider>
    </Modal>
  );
}

const fieldStyle = {
  minHeight: TOUCH,
  borderBottomWidth: 1,
  borderBottomColor: ON_PAPER_RULE,
  fontFamily: font.sans,
  fontSize: 16,
  color: color.inkOnPaper,
} as const;
