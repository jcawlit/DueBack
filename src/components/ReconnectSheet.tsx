/**
 * "Is this the same book?"
 *
 * Raised when a scan finds a folder that looks like a book it can no longer
 * account for, but cannot prove it. The app reconnects on its own only when
 * there is exactly one candidate and its content sample matches; everything
 * else arrives here, because joining the wrong two books moves someone's
 * place, their library-card history and everything they wrote onto a book
 * that is not theirs, and nothing undoes that properly.
 *
 * Keeping them apart is the safe answer and is always offered first by
 * position — the question is phrased so that doing nothing loses nothing.
 */

import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReconnectQuestion } from '@/db/identity';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';

export function ReconnectSheet({
  question,
  onAnswer,
}: {
  question: ReconnectQuestion | null;
  /** `null` keeps them separate. */
  onAnswer: (candidateId: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  if (!question) return null;

  const many = question.candidates.length > 1;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onAnswer(null)}>
      <View
        style={{
          flex: 1,
          backgroundColor: color.scrim,
          justifyContent: 'flex-end',
          padding: space.xl,
          paddingBottom: Math.max(space.xl, insets.bottom + space.md),
        }}
      >
        <View
          style={{
            backgroundColor: color.ground,
            borderRadius: radius.button,
            borderWidth: 1,
            borderColor: color.border,
            padding: space.xl,
            gap: space.md,
            maxHeight: '80%',
          }}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.accent }}>
            MOVED?
          </Text>
          <Text style={{ fontFamily: font.serif, fontSize: 20, color: color.paper }}>
            {question.missingTitle} isn’t where it was.
          </Text>
          <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.muted }}>
            {many
              ? 'More than one folder matches it exactly, so I can’t tell which is the one you were listening to. Picking brings your place, your history and your notes across.'
              : 'This folder is the same size and length, but I couldn’t read enough of it to be sure it’s the same audio. Joining them brings your place, your history and your notes across.'}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
            was in {question.missingFolder || 'the library root'}
          </Text>

          <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={{ gap: space.sm }}>
            {question.candidates.map((candidate) => (
              <Pressable
                key={candidate.id}
                onPress={() => onAnswer(candidate.id)}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  minHeight: TOUCH,
                  justifyContent: 'center',
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderWidth: 1,
                  borderColor: color.accent,
                  borderRadius: radius.button,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ fontFamily: font.sans, fontSize: 15, color: color.paper }}>
                  Yes — it’s {candidate.title}
                </Text>
                <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
                  {candidate.folderRelPath || 'the library root'}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            onPress={() => onAnswer(null)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: TOUCH,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: color.border,
              borderRadius: radius.button,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.paper }}>
              Keep them separate
            </Text>
          </Pressable>

          <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint, textAlign: 'center' }}>
            Nothing is lost either way — I’ll ask again next scan.
          </Text>
        </View>
      </View>
    </Modal>
  );
}
