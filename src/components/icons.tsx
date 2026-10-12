/**
 * The mockups' inline SVGs, transcribed to react-native-svg with identical path
 * data so the line weights and proportions carry across unchanged.
 */

import Svg, { Path, Rect } from 'react-native-svg';
import { color } from '@/theme/tokens';

type IconProps = {
  size?: number;
  stroke?: string;
};

/** The USB drawer: a slot with a latch. */
export function DrawerIcon({ size = 20, stroke = 'currentColor' }: IconProps) {
  return (
    <Svg width={size} height={size * 0.8} viewBox="0 0 20 16" fill="none">
      <Rect x={1} y={1} width={18} height={14} rx={1.5} stroke={stroke} strokeWidth={1.5} />
      <Path d="M1 6h18" stroke={stroke} strokeWidth={1.5} />
      <Path d="M8 10.5h4" stroke={stroke} strokeWidth={1.5} />
    </Svg>
  );
}

export function ChevronDown({ size = 16, stroke = color.muted }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path d="M3 6l5 5 5-5" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

export function ChevronLeft({ size = 16, stroke = color.muted }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path d="M10 3L5 8l5 5" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

/** Back 30: an anticlockwise loop with a tail arrow. */
export function Replay30({ size = 34, stroke = color.paper }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 34 34" fill="none">
      <Path d="M8 11a12 12 0 1 1-2 8" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M8 4v7h7" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

export function Forward30({ size = 34, stroke = color.paper }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 34 34" fill="none">
      <Path d="M26 11a12 12 0 1 0 2 8" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M26 4v7h-7" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

export function PlayIcon({ size = 30, fill = color.ground }: { size?: number; fill?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 30 30">
      <Path d="M9 5l16 10-16 10z" fill={fill} />
    </Svg>
  );
}

export function PauseIcon({ size = 30, fill = color.ground }: { size?: number; fill?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 30 30">
      <Rect x={6} y={5} width={6} height={20} rx={1} fill={fill} />
      <Rect x={18} y={5} width={6} height={20} rx={1} fill={fill} />
    </Svg>
  );
}

/** Contents: three ruled lines, the last one short. */
export function ContentsIcon({ size = 20, stroke = color.muted }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path d="M3 5h14M3 10h14M3 15h9" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

/** The reading lamp, which doubles as the sleep-timer icon. */
export function LampIcon({ size = 20, stroke = color.muted }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path d="M6 3h8l3 7H3z" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      <Path d="M10 10v6M6 17h8" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

/** Skip to the start of the next chapter: a triangle against a bar. */
export function SkipNextIcon({ size = 22, stroke = color.paper }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path d="M4 4l10 7-10 7z" fill={stroke} />
      <Path d="M17 4v14" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/** Back to the start of this chapter, or the previous one. */
export function SkipPreviousIcon({ size = 22, stroke = color.paper }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path d="M18 4L8 11l10 7z" fill={stroke} />
      <Path d="M5 4v14" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function PlusIcon({ size = 14, stroke = color.ground }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path d="M7 2v10M2 7h10" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function CheckIcon({ size = 14, stroke = color.ground }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path
        d="M2.5 7.5l3 3 6-7"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** An hourglass, for a book waiting on the drive. */
export function HoldIcon({ size = 14, stroke = color.ground }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path
        d="M4 2h6M4 12h6M4.5 2c0 3 5 4 5 5s-5 2-5 5"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <Path d="M9.5 2c0 3-5 4-5 5s5 2 5 5" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
