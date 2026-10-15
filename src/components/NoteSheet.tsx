import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Character, Note } from '@/data/notes';
import { insertMention, mentionQueryAt, suggestCharacters } from '@/lib/notes/mentions';
import { timestamp } from '@/lib/format';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { useNoteFont } from './NoteText';
import { PaperCard, PaperRules, RULE_PITCH } from './PaperCard';

type Props = {
  visible: boolean;
  note: Note | null;
  characters: Character[];
  canTag: boolean;
  justSaved: boolean;
  onChangeText: (text: string) => void;
  onAddCharacter: (name: string, bio: string) => Promise<Character | null>;
  onUndo: () => void;
  /**
   * Throw this note away.
   *
   * It lives in here rather than on the note in the list. A delete sitting
   * permanently beside every note is a row of loaded buttons under the
   * thumb; opening the note first means the thing being deleted is on
   * screen and being read at the moment it goes.
   */
  onDelete: (note: Note) => void;
  onClose: () => void;
};

export function NoteSheet({ visible, note, characters, canTag, justSaved,
  onChangeText, onAddCharacter, onUndo, onDelete, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [selection, setSelection] = useState(0);
  const [cursorTarget, setCursorTarget] = useState<{ start: number; end: number }>();
  const [showSaved, setShowSaved] = useState(justSaved);
  const [newName, setNewName] = useState<string | null>(null);
  const [newBio, setNewBio] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const noteFont = useNoteFont(17);

  useEffect(() => {
    if (!justSaved) return;
    const id = setTimeout(() => setShowSaved(false), 4000);
    return () => clearTimeout(id);
  }, [justSaved]);

  const text = note?.text ?? '';
  const mention = canTag ? mentionQueryAt(text, selection) : null;
  const matches = mention ? suggestCharacters(mention.query, characters) : [];
  const exact = matches.some((c) => c.name.toLowerCase() === mention?.query.trim().toLowerCase());
  const refocus = () => requestAnimationFrame(() => inputRef.current?.focus());
  const pick = (name: string) => {
    const next = insertMention(text, selection, name);
    onChangeText(next.text);
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

  return (
    /*
     * No `statusBarTranslucent`, deliberately.
     *
     * It puts the modal's window into layout-no-limits, and an Android window
     * laid out past its limits is never resized for the keyboard — which left
     * the JavaScript `KeyboardAvoidingView` as the only thing able to lift the
     * sheet. That runs a beat after the keyboard is already up, so the
     * keyboard arrived first and the note followed about a second later.
     *
     * Without the flag the dialog resizes natively and instantly, and because
     * the sheet is anchored to the bottom it is simply already there. The cost
     * is that the dim backdrop stops at the status bar on Android.
     */
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/*
        iOS has no such resize, so it keeps the padding behaviour. On Android
        this is a plain View: a second, slower adjustment on top of the
        window's own is what caused the lag, not a missing one.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: 'rgba(10,7,5,0.6)' }}>
        <View style={{ flex: 1, justifyContent: 'flex-end', paddingTop: insets.top + space.md,
          paddingBottom: Math.max(insets.bottom, space.md), paddingHorizontal: space.lg }}>
          <Pressable style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
            onPress={onClose} accessibilityLabel="Close note" />
          <PaperCard style={{ maxHeight: '95%', flexShrink: 1, padding: 0, gap: 0 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
              paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: color.paperRule }}>
              <Text style={{ fontFamily: font.monoMedium, fontSize: 11, letterSpacing: 1, color: color.stampOut }}>
                {newName === null ? 'NOTE' : 'NEW CHARACTER'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                {note && newName === null ? (
                  <SheetButton
                    label="Delete"
                    tone="warning"
                    onPress={() => {
                      onDelete(note);
                      onClose();
                    }}
                  />
                ) : null}
                {/*
                  One action, whichever state the sheet is in. The create
                  form used to carry a header "Done" and a footer "Add
                  character" at the same time, which are different promises:
                  one closes the note, the other makes a person. Here the
                  header action *is* the state's action.
                */}
                {newName === null ? (
                  <SheetButton label="Done" onPress={onClose} />
                ) : (
                  <SheetButton
                    label={creating ? 'Adding…' : 'Add character'}
                    disabled={creating || !newName.trim()}
                    onPress={() => void createAndPick()}
                  />
                )}
              </View>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}
              contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
              {newName === null ? (
                <>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md }}>
                    <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampOut }}>
                      {note ? timestamp(note.positionSec) : ''}
                    </Text>
                    {showSaved ? <>
                      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.inkOnPaper }}>Bookmark saved</Text>
                      <SheetButton label="Undo" onPress={() => { setShowSaved(false); onUndo(); }} />
                    </> : null}
                  </View>
                  <View>
                    <PaperRules />
                    <TextInput ref={inputRef} value={text} selection={cursorTarget}
                      onChangeText={(value) => { setCursorTarget(undefined); onChangeText(value); }}
                      onSelectionChange={(e) => { setSelection(e.nativeEvent.selection.start); setCursorTarget(undefined); }}
                      autoFocus={false} multiline scrollEnabled
                      accessibilityLabel="Note text" placeholder="Leave a thought here…"
                      placeholderTextColor={color.wood} selectionColor={color.stampOut}
                      /*
                       * The line height is the rule pitch, not a number that
                       * happens to match it. Ruling that nearly lines up with
                       * the writing reads as a mistake.
                       */
                      style={[noteFont, { minHeight: RULE_PITCH * 4.4, maxHeight: RULE_PITCH * 7.4,
                        lineHeight: RULE_PITCH, padding: 0, paddingTop: 3,
                        color: color.inkOnPaper, textAlignVertical: 'top' }]} />
                  </View>
                </>
              ) : (
                <>
                  <TextInput value={newName} onChangeText={setNewName} autoFocus accessibilityLabel="Character name"
                    placeholder="Name" placeholderTextColor={color.wood} style={fieldStyle} />
                  <TextInput value={newBio} onChangeText={setNewBio} accessibilityLabel="Character bio"
                    placeholder="Who are they? (optional)" placeholderTextColor={color.wood} style={[fieldStyle, noteFont]} />
                  {createError ? <Text accessibilityRole="alert" style={{ color: color.warningInk }}>{createError}</Text> : null}
                  {/* Adding is the header's job now; this is only the way out. */}
                  <View style={{ flexDirection: 'row', gap: space.md }}>
                    <SheetButton label="Cancel" disabled={creating} onPress={() => { setNewName(null); refocus(); }} />
                  </View>
                </>
              )}
            </ScrollView>
            {canTag && newName === null ? (
              <View style={{ borderTopWidth: 1, borderTopColor: color.paperRule, paddingHorizontal: space.lg }}>
                {mention ? (
                  <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
                    style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.md, alignItems: 'center' }}>
                    {matches.map((character) => <SheetButton key={character.id} label={character.name} onPress={() => pick(character.name)} />)}
                    {exact ? null : <SheetButton label="+ New character" onPress={() => {
                      setNewName(mention.query.trim()); setNewBio(''); setCreateError('');
                    }} />}
                  </ScrollView>
                ) : <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.wood, paddingVertical: space.md }}>
                  @ to tag a character · saved as you write
                </Text>}
              </View>
            ) : null}
          </PaperCard>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const fieldStyle = {
  minHeight: TOUCH, paddingHorizontal: space.sm, borderBottomWidth: 1,
  borderBottomColor: color.paperRule, fontFamily: font.sans, fontSize: 16, color: color.inkOnPaper,
} as const;

function SheetButton({ label, onPress, disabled = false, tone = 'normal' }: {
  label: string; onPress: () => void; disabled?: boolean; tone?: 'normal' | 'warning';
}) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }}
    style={({ pressed }) => ({ minHeight: TOUCH, paddingHorizontal: space.sm, justifyContent: 'center',
      opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}>
    <Text style={{ fontFamily: font.monoMedium, fontSize: 11,
      color: tone === 'warning' ? color.warningInk : color.stampOut }}>{label}</Text>
  </Pressable>;
}
