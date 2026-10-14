/**
 * Writing in the margin, one-handed, while something is playing.
 *
 * The bookmark is already saved by the time this opens — the pencil writes it
 * on the way in, so the thing worth keeping survives whatever happens next,
 * including the listener changing their mind and swiping the sheet away.
 *
 * The keyboard deliberately does not come up with the sheet. Most taps of the
 * pencil are "mark this spot", not "write an essay", and half a screen of
 * keyboard for a gesture that is already finished is in the way. Tapping the
 * field is what asks for it.
 */

import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Character, Note } from '@/data/notes';
import { insertMention, mentionQueryAt, suggestCharacters } from '@/lib/notes/mentions';
import { timestamp } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { useNoteFont } from './NoteText';

/** How long the "saved" line stays up before getting out of the way. */
const CONFIRMATION_MS = 4000;

type Props = {
  visible: boolean;
  note: Note | null;
  characters: Character[];
  /** Whether the character index is available; see `isPro`. */
  canTag: boolean;
  /** Set when the sheet opened straight after the pencil, so Undo is offered. */
  justSaved: boolean;
  onChangeText: (text: string) => void;
  onAddCharacter: (name: string, bio: string) => Promise<Character | null>;
  onUndo: () => void;
  onClose: () => void;
};

export function NoteSheet({
  visible,
  note,
  characters,
  canTag,
  justSaved,
  onChangeText,
  onAddCharacter,
  onUndo,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [selection, setSelection] = useState(0);
  /*
   * Fresh state per note: the caller keys this component on the note's id, so
   * opening another one remounts rather than carrying the last one's
   * confirmation line and half-finished character form across.
   */
  const [showSaved, setShowSaved] = useState(justSaved);
  /** Non-null while the "new character" form is open; holds the typed name. */
  const [newName, setNewName] = useState<string | null>(null);
  const [newBio, setNewBio] = useState('');
  const noteFont = useNoteFont(17);

  useEffect(() => {
    if (!justSaved) return;
    const id = setTimeout(() => setShowSaved(false), CONFIRMATION_MS);
    return () => clearTimeout(id);
  }, [justSaved]);

  const text = note?.text ?? '';
  const mention = canTag ? mentionQueryAt(text, selection) : null;
  const matches = mention ? suggestCharacters(mention.query, characters) : [];
  const exact = matches.some(
    (c) => c.name.toLowerCase() === mention?.query.trim().toLowerCase(),
  );

  const pick = (name: string) => {
    const next = insertMention(text, selection, name);
    onChangeText(next.text);
    setSelection(next.cursor);
  };

  const createAndPick = async () => {
    const name = (newName ?? '').trim();
    if (name.length === 0) return;
    const character = await onAddCharacter(name, newBio.trim());
    setNewName(null);
    setNewBio('');
    if (character) pick(character.name);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,7,5,0.6)' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close note" />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: color.ground,
              borderTopLeftRadius: 14,
              borderTopRightRadius: 14,
              borderTopWidth: 1,
              borderColor: color.line,
              paddingBottom: Math.max(space.lg, insets.bottom + space.sm),
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
              }}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                {note ? timestamp(note.positionSec) : ''}
              </Text>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                hitSlop={12}
                style={{ minHeight: TOUCH, justifyContent: 'center' }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                  done
                </Text>
              </Pressable>
            </View>

            {showSaved ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingHorizontal: space.xl,
                  paddingBottom: space.sm,
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                  Bookmark saved
                </Text>
                <Pressable
                  onPress={() => {
                    setShowSaved(false);
                    onUndo();
                  }}
                  accessibilityRole="button"
                  hitSlop={12}
                >
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.ribbon }}>
                    Undo
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={onChangeText}
              onSelectionChange={(e) => setSelection(e.nativeEvent.selection.start)}
              /*
               * Never on open. The bookmark is already saved; raising the
               * keyboard would hide the book for a gesture that is finished.
               */
              autoFocus={false}
              multiline
              placeholder="Add a note, or leave it as a bookmark"
              placeholderTextColor={color.faint}
              // Dictation is the keyboard's own, so the app needs no
              // microphone permission to support speaking a note.
              style={[
                noteFont,
                {
                  minHeight: 96,
                  maxHeight: 200,
                  marginHorizontal: space.xl,
                  paddingHorizontal: space.md,
                  paddingTop: space.md,
                  paddingBottom: space.md,
                  borderWidth: 1,
                  borderColor: color.line,
                  borderRadius: radius.button,
                  color: color.paper,
                  textAlignVertical: 'top',
                },
              ]}
            />

            {canTag && newName === null ? (
              <Text
                style={{
                  fontFamily: font.mono,
                  fontSize: 10,
                  color: color.faint,
                  paddingHorizontal: space.xl,
                  paddingTop: space.sm,
                }}
              >
                type @ to tag someone
              </Text>
            ) : null}

            {canTag && newName !== null ? (
              <View style={{ paddingHorizontal: space.xl, paddingTop: space.md, gap: space.sm }}>
                <TextInput
                  value={newName}
                  onChangeText={setNewName}
                  autoFocus
                  placeholder="Name"
                  placeholderTextColor={color.faint}
                  style={fieldStyle}
                />
                <TextInput
                  value={newBio}
                  onChangeText={setNewBio}
                  placeholder="Who are they? (optional)"
                  placeholderTextColor={color.faint}
                  style={fieldStyle}
                />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <SheetButton label="Add" onPress={() => void createAndPick()} tone="accent" />
                  <SheetButton label="Cancel" onPress={() => setNewName(null)} />
                </View>
              </View>
            ) : null}

            {canTag && mention && newName === null ? (
              <ScrollView
                horizontal
                keyboardShouldPersistTaps="handled"
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  gap: space.sm,
                  paddingHorizontal: space.xl,
                  paddingTop: space.md,
                }}
              >
                {matches.map((character) => (
                  <SheetButton
                    key={character.id}
                    label={character.name}
                    onPress={() => pick(character.name)}
                  />
                ))}
                {exact ? null : (
                  <SheetButton
                    label={`+ New${mention.query.trim() ? ` “${mention.query.trim()}”` : ' character'}`}
                    tone="accent"
                    onPress={() => {
                      setNewName(mention.query.trim());
                      setNewBio('');
                    }}
                  />
                )}
              </ScrollView>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const fieldStyle = {
  minHeight: TOUCH,
  paddingHorizontal: space.md,
  borderWidth: 1,
  borderColor: color.line,
  borderRadius: radius.button,
  fontFamily: font.sans,
  fontSize: 15,
  color: color.paper,
} as const;

function SheetButton({
  label,
  onPress,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'accent';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: space.md,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: tone === 'accent' ? color.accent : color.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          fontFamily: font.mono,
          fontSize: 12,
          color: tone === 'accent' ? color.accent : color.paper,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
