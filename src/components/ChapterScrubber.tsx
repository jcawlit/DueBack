/**
 * The chapter scrubber: a trough notched once per minute, filled to the current
 * position, with the bookmark ribbon as the playhead.
 *
 * Built on PanResponder rather than a slider library so the ticks and the ribbon
 * can be drawn exactly as the mockup has them. Every child is `pointerEvents:
 * none`, which keeps `locationX` measured against this view and nothing else.
 */

import { useState } from 'react';
import { PanResponder, View } from 'react-native';
import { color, shadow } from '@/theme/tokens';
import { clock } from '@/lib/format';
import { Ribbon } from './Ribbon';

const TRACK_HEIGHT = 8;
const ROW_HEIGHT = 22;
const RIBBON_WIDTH = 10;
/** Vertical slop, so the thin track is comfortably grabbable. */
const HIT_SLOP = { top: 12, bottom: 12, left: 0, right: 0 };

type Props = {
  /** Seconds into the current chapter. */
  positionSec: number;
  /** Length of the current chapter, in seconds. */
  lengthSec: number;
  onSeek: (positionSec: number) => void;
};

export function ChapterScrubber({ positionSec, lengthSec, onSeek }: Props) {
  const [width, setWidth] = useState(0);
  /** Non-null while a drag is in flight; it overrides the playing position. */
  const [dragSec, setDragSec] = useState<number | null>(null);

  const shown = dragSec ?? positionSec;
  const fraction = lengthSec > 0 ? Math.min(1, Math.max(0, shown / lengthSec)) : 0;

  /** Where along the chapter a touch at `x` falls. */
  const secondsAt = (x: number) => {
    if (width <= 0) return 0;
    return (Math.min(width, Math.max(0, x)) / width) * lengthSec;
  };

  // Rebuilt every render rather than memoised: the handlers then close over the
  // current width and chapter with no refs, and React Native only reads
  // `panHandlers` when a gesture begins, so the fresh object costs nothing.
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => setDragSec(secondsAt(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setDragSec(secondsAt(e.nativeEvent.locationX)),
    // `dragSec` here is this render's value, which is the last position the
    // drag reported. Seeking from inside a `setState` updater instead would
    // run `onSeek` during render and update another component mid-render.
    onPanResponderRelease: () => {
      if (dragSec !== null) onSeek(dragSec);
      setDragSec(null);
    },
    onPanResponderTerminate: () => setDragSec(null),
  });

  const minutes = Math.max(1, Math.round(lengthSec / 60));

  return (
    <View
      {...responder.panHandlers}
      hitSlop={HIT_SLOP}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Position in chapter"
      accessibilityValue={{
        min: 0,
        max: Math.round(lengthSec),
        now: Math.round(shown),
        text: `${clock(shown)} of ${clock(lengthSec)}`,
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') {
          onSeek(Math.min(lengthSec, positionSec + 30));
        } else if (e.nativeEvent.actionName === 'decrement') {
          onSeek(Math.max(0, positionSec - 30));
        }
      }}
      style={{ height: ROW_HEIGHT, justifyContent: 'center' }}
    >
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 8,
          height: TRACK_HEIGHT,
          borderRadius: 1,
          backgroundColor: color.trough,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${fraction * 100}%`,
            height: '100%',
            backgroundColor: color.accent,
          }}
        />
        {/* One notch per minute, so a long chapter reads as a long chapter. */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: 'row',
          }}
        >
          {Array.from({ length: minutes }, (_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                borderLeftWidth: i === 0 ? 0 : 1,
                borderLeftColor: 'rgba(27,20,16,0.75)',
              }}
            />
          ))}
        </View>
      </View>

      {width > 0 ? (
        <View
          pointerEvents="none"
          style={[
            { position: 'absolute', top: -2, left: fraction * width - RIBBON_WIDTH / 2 },
            shadow(2, 0.4),
          ]}
        >
          <Ribbon width={RIBBON_WIDTH} height={26} notch={0.2} />
        </View>
      ) : null}
    </View>
  );
}
