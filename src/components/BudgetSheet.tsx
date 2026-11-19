/**
 * Setting the storage budget — how much of the phone checked-out books may use.
 *
 * A sheet rather than a text field. The budget is a round number of gigabytes
 * that someone nudges once and forgets, and a keyboard for that invites "4.7"
 * and a decimal point in a number the ruler draws tick marks from. Presets for
 * the common answers, a stepper for everything else, and nothing is written
 * until Save.
 *
 * It states the two facts that make a budget make sense — what is checked out
 * now, and what the phone actually has free — rather than silently refusing
 * figures it disagrees with. The budget is a preference; the copy path is what
 * enforces reality, and it does that on the day whatever this says.
 */

import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { bytes as formatBytes } from '@/lib/format';
import {
  BUDGET_PRESETS_GB,
  bytesToGB,
  gbToBytes,
  MAX_BUDGET_GB,
  MIN_BUDGET_GB,
  nextBudgetGB,
  previousBudgetGB,
} from '@/lib/library/budget';
import { budgetCeilingGB, FREE_BUDGET_CEILING_GB } from '@/lib/pro';
import { useGate, usePro } from '@/store/pro';
import { ProTag } from './ProTag';

type Props = {
  visible: boolean;
  budgetBytes: number;
  /** What checked-out books and holds already commit, for the warning. */
  committedBytes: number;
  /** Free space on the phone right now. */
  availableBytes: number;
  onSave: (budgetBytes: number) => void;
  onCancel: () => void;
};

function StepButton({
  label,
  hint,
  onPress,
  disabled,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        width: TOUCH,
        height: TOUCH,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: color.border,
        backgroundColor: pressed ? color.pressWashStrong : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 22, color: color.inkOnPaper }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function BudgetSheet({
  visible,
  budgetBytes,
  committedBytes,
  availableBytes,
  onSave,
  onCancel,
}: Props) {
  /*
   * `null` means untouched, and reads as whatever the stored budget is.
   *
   * Cleared when the sheet closes rather than set when it opens, so the reset
   * happens in an event handler instead of an effect reacting to `visible` —
   * and so a store update mid-edit cannot reach in and move the number under
   * the hand. Nothing is written until Save; this is what holds that.
   */
  const [draft, setDraft] = useState<number | null>(null);
  const draftGB = draft ?? bytesToGB(budgetBytes);
  /*
   * The dial is free to look at and free to use up to the ceiling. Hiding it
   * would hide the one number that explains why a book will not fit — seeing
   * the gauge fill at 2 GB is a better advertisement than a control nobody
   * can find.
   */
  const ceilingGB = useGate((e) => budgetCeilingGB(e, MAX_BUDGET_GB));
  const capped = ceilingGB < MAX_BUDGET_GB;
  const openProSheet = usePro((st) => st.openSheet);

  const cancel = () => {
    setDraft(null);
    onCancel();
  };
  const save = (next: number) => {
    setDraft(null);
    onSave(next);
  };

  const draftBytes = gbToBytes(draftGB);
  const belowCommitted = draftBytes < committedBytes;
  const beyondPhone = draftBytes > availableBytes + committedBytes;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel}>
      <Pressable
        onPress={cancel}
        accessibilityLabel="Dismiss"
        style={{
          flex: 1,
          backgroundColor: color.scrim,
          justifyContent: 'flex-end',
          padding: space.xl,
        }}
      >
        {/* Stop taps inside the card from dismissing it. */}
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
            Storage budget
          </Text>
          <Text
            style={{
              fontFamily: font.sans,
              fontSize: 14,
              lineHeight: 14 * 1.45,
              color: color.inkOnPaperBody,
            }}
          >
            How much of this phone checked-out books may fill. The ruler under the
            tray measures against it.
          </Text>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: space.sm,
            }}
          >
            <StepButton
              label="−"
              hint="Smaller budget"
              onPress={() => setDraft(previousBudgetGB(draftGB))}
              disabled={draftGB <= MIN_BUDGET_GB}
            />
            <View
              accessible
              accessibilityLabel={`Budget ${draftGB} gigabytes`}
              accessibilityLiveRegion="polite"
            >
              <Text
                style={{
                  fontFamily: font.serif,
                  fontSize: 38,
                  color: color.inkOnPaper,
                  textAlign: 'center',
                }}
              >
                {draftGB} GB
              </Text>
            </View>
            <StepButton
              label="+"
              hint={capped ? 'Bigger budget — part of Pro past the ceiling' : 'Bigger budget'}
              onPress={() => {
                const next = nextBudgetGB(draftGB);
                if (next > ceilingGB) {
                  openProSheet('budget');
                  return;
                }
                setDraft(next);
              }}
              disabled={draftGB >= MAX_BUDGET_GB}
            />
          </View>

          {capped ? (
            <Pressable
              onPress={() => openProSheet('budget')}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <ProTag />
              <Text
                style={{
                  flex: 1,
                  fontFamily: font.sans,
                  fontSize: 13,
                  lineHeight: 13 * 1.4,
                  color: color.inkOnPaperBody,
                }}
              >
                {`Free keeps ${FREE_BUDGET_CEILING_GB} GB of books on the phone at once. Pro takes the ceiling off.`}
              </Text>
            </Pressable>
          ) : null}

          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            {BUDGET_PRESETS_GB.map((preset) => {
              const active = preset === draftGB;
              return (
                <Pressable
                  key={preset}
                  onPress={() =>
                    preset > ceilingGB ? openProSheet('budget') : setDraft(preset)
                  }
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${preset} gigabytes`}
                  style={({ pressed }) => ({
                    minHeight: 36,
                    paddingHorizontal: space.md,
                    justifyContent: 'center',
                    borderRadius: radius.button,
                    borderWidth: 1,
                    borderColor: active ? color.inkOnPaper : color.border,
                    backgroundColor: active
                      ? color.inkOnPaper
                      : pressed
                        ? color.pressWash
                        : 'transparent',
                  })}
                >
                  <Text
                    style={{
                      fontFamily: font.mono,
                      fontSize: 13,
                      color: active ? color.paper : color.inkOnPaper,
                    }}
                  >
                    {preset} GB
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={{ gap: 3 }}>
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.inkOnPaperSoft }}>
              {formatBytes(committedBytes)} checked out now ·{' '}
              {formatBytes(availableBytes)} free on this phone
            </Text>
            {/*
              Said plainly rather than prevented. Both are legitimate things to
              want, and the copy path refuses what will not fit regardless.
            */}
            {belowCommitted ? (
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warningInk }}>
                Less than what is already out. Nothing is deleted — you just
                cannot check more out until you return something.
              </Text>
            ) : null}
            {beyondPhone ? (
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warningInk }}>
                More than this phone has free. Copies stop when the phone is
                full, whatever the budget says.
              </Text>
            ) : null}
          </View>

          <View style={{ gap: space.sm, marginTop: space.sm }}>
            <Pressable
              onPress={() => save(draftBytes)}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minHeight: TOUCH + 4,
                borderRadius: radius.button,
                backgroundColor: pressed ? color.inkOnPaperPressed : color.inkOnPaper,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              <Text style={{ fontFamily: font.monoMedium, fontSize: 14, color: color.paper }}>
                Save
              </Text>
            </Pressable>
            <Pressable
              onPress={cancel}
              accessibilityRole="button"
              style={{
                minHeight: TOUCH,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.inkOnPaperSoft }}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
