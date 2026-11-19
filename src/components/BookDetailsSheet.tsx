/**
 * Correcting what a book says about itself.
 *
 * Metadata comes from the files, and files lie — "Hyperion" arrives filed
 * under the author "Top 100 scifi books" because that is what the tags say.
 * Nothing a scanner can do fixes that: the tag is not malformed, it is wrong.
 *
 * The same sheet and the same stock as the character card, because it is the
 * same kind of object: a record about a thing, laid on paper, with the app's
 * chrome around it. What is different is the hint under each field, which
 * says what the files claim wherever the listener has overruled them. That is
 * the whole safety net here — an edit you can see is an edit you can undo,
 * and these corrections outlive every rescan.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Book } from '@/data/types';
import type { BookOverride, TextOverrideField } from '@/lib/library/overrides';
import { editsToOverride } from '@/lib/library/overrides';
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { CoverFace } from './CoverFace';

/** What the files say, which is what a correction is measured against. */
export type ScannedDetails = {
  title: string;
  author: string;
  narrator?: string;
  series?: string;
  seriesIndex?: number;
};

export function BookDetailsSheet({
  book,
  scanned,
  override,
  onSave,
  onPickCover,
  onClearCover,
  onRevertAll,
  onClose,
}: {
  /** The book as it is shown, corrections already applied. */
  book: Book;
  /**
   * The same book as the files describe it.
   *
   * Passed in rather than read here: this sheet shows the difference between
   * the two, and it cannot show a difference it has to infer.
   */
  scanned: ScannedDetails;
  override: BookOverride | null;
  onSave: (patch: Omit<BookOverride, 'coverFile'>) => void;
  onPickCover: () => void;
  onClearCover: () => void;
  onRevertAll: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [narrator, setNarrator] = useState(book.narrator ?? '');
  const [series, setSeries] = useState(book.series ?? '');
  const [seriesIndex, setSeriesIndex] = useState(
    book.seriesIndex === undefined ? '' : String(book.seriesIndex),
  );
  const [confirmingRevert, setConfirmingRevert] = useState(false);

  const patch = editsToOverride({ title, author, narrator, series, seriesIndex }, scanned);
  const corrected = (Object.keys(patch) as TextOverrideField[]).filter(
    (field) => patch[field] !== null,
  );
  const coverCorrected = override?.coverFile !== null && override?.coverFile !== undefined;
  const anything = corrected.length > 0 || coverCorrected;

  /*
   * A title is the one thing a book cannot do without. Everything else may be
   * cleared — clearing is the honest fix for a bogus author, and the point of
   * being able to say "nothing" rather than guess again.
   */
  const canSave = title.trim().length > 0;

  const commit = () => {
    if (!canSave) return;
    onSave(patch);
    onClose();
  };

  /** "the files say Top 100 scifi books", shown only where it differs. */
  const fromFiles = (field: TextOverrideField, value: string | number | undefined) => {
    if (patch[field] === null) return null;
    const text = value === undefined || String(value).trim() === '' ? 'nothing' : String(value);
    return (
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warningInk }}>
        {`the files say ${text}`}
      </Text>
    );
  };

  return (
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      {/* Its own provider: a Modal is a separate window and cannot see the
          app's insets. Same reason as the character sheet. */}
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: color.scrimSoft }}>
          {/* Pressing away keeps nothing, so the backdrop is never a second
              Save button for a thumb to find by accident. */}
          <Pressable
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
            onPress={onClose}
            accessibilityLabel="Close without saving"
          />

          <KeyboardAvoidingView behavior="padding">
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
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel, and leave this book as it was"
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
                  DETAILS
                </Text>

                <Pressable
                  onPress={commit}
                  disabled={!canSave}
                  accessibilityRole="button"
                  accessibilityLabel="Save these details"
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
                  {/* The cover, with the two things anyone would want to do to
                      it. Shown at the size a shelf shows it, because that is
                      where a wrong one gets noticed. */}
                  <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
                    <View>
                      <CoverFace book={book} size="tray" />
                    </View>
                    <View style={{ flex: 1, gap: 8, paddingTop: 2 }}>
                      <Text style={LABEL}>COVER</Text>
                      <Pressable
                        onPress={onPickCover}
                        accessibilityRole="button"
                        accessibilityLabel="Choose a cover picture for this book"
                        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 32 })}
                      >
                        <Text style={ACTION}>
                          {coverCorrected ? 'Choose a different picture' : 'Choose a picture'}
                        </Text>
                      </Pressable>
                      {coverCorrected ? (
                        <Pressable
                          onPress={onClearCover}
                          accessibilityRole="button"
                          accessibilityLabel="Go back to the cover from the files"
                          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 32 })}
                        >
                          <Text style={ACTION}>Use the one from the files</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>

                  <View
                    style={{
                      gap: 4,
                      paddingBottom: 8,
                      borderBottomWidth: 1.5,
                      borderBottomColor: color.warningInk,
                    }}
                  >
                    <Text style={LABEL}>TITLE</Text>
                    <TextInput
                      value={title}
                      onChangeText={setTitle}
                      placeholder="Title"
                      placeholderTextColor={color.inkOnPaperFaint}
                      selectionColor={color.stampOut}
                      accessibilityLabel="Title"
                      style={{
                        paddingVertical: 2,
                        fontFamily: font.serif,
                        fontSize: 26,
                        color: color.inkOnPaper,
                      }}
                    />
                    {title.trim().length === 0 ? (
                      <Text
                        style={{ fontFamily: font.mono, fontSize: 11, color: color.warningInk }}
                      >
                        A book needs a title
                      </Text>
                    ) : (
                      fromFiles('title', scanned.title)
                    )}
                  </View>

                  <Field
                    label="AUTHOR"
                    value={author}
                    onChange={setAuthor}
                    placeholder="Unknown"
                    hint={fromFiles('author', scanned.author)}
                  />
                  <Field
                    label="NARRATOR"
                    value={narrator}
                    onChange={setNarrator}
                    placeholder="Unknown"
                    hint={fromFiles('narrator', scanned.narrator)}
                  />
                  <Field
                    label="SERIES"
                    value={series}
                    onChange={setSeries}
                    placeholder="Not in a series"
                    hint={fromFiles('series', scanned.series)}
                  />
                  <Field
                    label="NUMBER IN THE SERIES"
                    value={seriesIndex}
                    onChange={setSeriesIndex}
                    placeholder="—"
                    keyboardType="decimal-pad"
                    hint={fromFiles('seriesIndex', scanned.seriesIndex)}
                  />

                  {/* Said plainly, because it is the question anybody would
                      have: does scanning the drive again undo this? */}
                  <Text
                    style={{
                      fontFamily: font.mono,
                      fontSize: 11,
                      color: color.inkOnPaperFaint,
                      paddingTop: 2,
                    }}
                  >
                    Kept when the library is scanned again, and carried in the backup. Emptying a
                    field leaves it empty rather than bringing back what the files say.
                  </Text>
                </View>

                {anything ? (
                  <View style={{ paddingTop: space.md, alignItems: 'center' }}>
                    {confirmingRevert ? (
                      <View style={{ alignItems: 'center', gap: 8 }}>
                        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
                          Put this book back the way the files describe it?
                        </Text>
                        <View style={{ flexDirection: 'row', gap: space.lg }}>
                          <Pressable
                            onPress={() => setConfirmingRevert(false)}
                            accessibilityRole="button"
                            accessibilityLabel="Keep my corrections"
                            style={({ pressed }) => ({
                              minHeight: TOUCH,
                              justifyContent: 'center',
                              opacity: pressed ? 0.6 : 1,
                            })}
                          >
                            <Text
                              style={{ fontFamily: font.mono, fontSize: 13, color: color.muted }}
                            >
                              Keep them
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              onRevertAll();
                              onClose();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Discard my corrections to this book"
                            style={({ pressed }) => ({
                              minHeight: TOUCH,
                              justifyContent: 'center',
                              opacity: pressed ? 0.6 : 1,
                            })}
                          >
                            <Text
                              style={{
                                fontFamily: font.monoMedium,
                                fontSize: 13,
                                color: color.stampOut,
                              }}
                            >
                              Put it back
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => setConfirmingRevert(true)}
                        accessibilityRole="button"
                        accessibilityLabel="Put this book back the way the files describe it"
                        style={({ pressed }) => ({
                          minHeight: TOUCH,
                          justifyContent: 'center',
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
                          Use what the files say
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ) : null}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </KeyboardProvider>
    </Modal>
  );
}

/** One labelled line on the card, with its hint underneath. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  hint: React.ReactNode;
  keyboardType?: 'decimal-pad';
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={LABEL}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.inkOnPaperFaint}
        selectionColor={color.stampOut}
        accessibilityLabel={label.toLowerCase()}
        keyboardType={keyboardType}
        style={{
          paddingVertical: 2,
          fontFamily: font.serif,
          fontSize: 17,
          color: color.inkOnPaper,
        }}
      />
      {hint}
    </View>
  );
}

const LABEL = {
  fontFamily: font.mono,
  fontSize: 10,
  letterSpacing: 1,
  color: color.inkOnPaperFaint,
} as const;

/** A thing to press, on paper. */
const ACTION = {
  fontFamily: font.monoMedium,
  fontSize: 12,
  color: color.stampOut,
} as const;
