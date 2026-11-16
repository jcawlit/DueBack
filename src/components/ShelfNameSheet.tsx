/**
 * Naming a shelf, and the row that offers to make one.
 *
 * The same sheet does both, because they are the same question with a
 * different starting value — and a second screen for "what should this be
 * called" would be a screen to maintain for one text field.
 *
 * Delete only appears when there is something to delete, and it says what it
 * will not do: a shelf going away does not take its books anywhere. They go
 * back to the pile at the bottom of the Library, which is where they came
 * from, and nothing about the books themselves changes.
 */

import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';

export function NewShelfRow({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="New shelf"
      style={({ pressed }) => ({
        marginTop: space.xl,
        marginHorizontal: space.xl,
        minHeight: TOUCH,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: color.checkout,
        borderStyle: 'dashed',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.checkout }}>
        + new shelf
      </Text>
    </Pressable>
  );
}

export function ShelfNameSheet({
  visible,
  /** The shelf being renamed, or null when making one. */
  shelfId,
  initialName,
  onSave,
  onDelete,
  onCancel,
}: {
  visible: boolean;
  shelfId: string | null;
  initialName: string;
  onSave: (name: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  /*
   * `null` means untouched, so the field reads the name it was opened with.
   * Cleared when the sheet closes rather than set when it opens, which keeps
   * the reset in an event handler instead of an effect watching `visible`.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? initialName;

  const close = () => {
    setDraft(null);
    onCancel();
  };
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setDraft(null);
    onSave(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        onPress={close}
        accessibilityLabel="Dismiss"
        style={{
          flex: 1,
          backgroundColor: 'rgba(10,7,5,0.72)',
          justifyContent: 'flex-end',
          padding: space.xl,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={[
            {
              backgroundColor: color.paper,
              borderRadius: 4,
              padding: space.xl,
              gap: space.md,
            },
            shadow(20, 0.6),
          ]}
        >
          <Text
            accessibilityRole="header"
            style={{ fontFamily: font.serif, fontSize: 21, color: color.inkOnPaper }}
          >
            {shelfId ? 'Rename shelf' : 'New shelf'}
          </Text>

          <TextInput
            value={name}
            onChangeText={setDraft}
            autoFocus
            placeholder="Re-reads"
            placeholderTextColor="#9a876a"
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel="Shelf name"
            style={{
              fontFamily: font.sans,
              fontSize: 17,
              color: color.inkOnPaper,
              borderBottomWidth: 1,
              borderBottomColor: color.border,
              paddingVertical: space.sm,
            }}
          />

          <View style={{ gap: space.sm, marginTop: space.sm }}>
            <Pressable
              onPress={save}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minHeight: TOUCH + 4,
                borderRadius: radius.button,
                backgroundColor: pressed ? '#5b8341' : color.checkout,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              <Text style={{ fontFamily: font.monoMedium, fontSize: 14, color: color.paper }}>
                Save
              </Text>
            </Pressable>

            {shelfId ? (
              <Pressable
                onPress={() => {
                  setDraft(null);
                  onDelete();
                }}
                accessibilityRole="button"
                accessibilityLabel="Delete this shelf. The books on it go back to the pile."
                style={{
                  minHeight: TOUCH,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.warningInk }}>
                  Delete shelf · the books stay
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              onPress={close}
              accessibilityRole="button"
              style={{ minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 13, color: '#6b5a42' }}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
