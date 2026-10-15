/**
 * Design tokens. These are the values from HANDOFF.md's token table, and they are
 * the only place raw colours should appear — components reference them by name.
 */

export const color = {
  ground: '#1b1410',
  groundDeep: '#120d0a',
  /** The checked-out tray at the bottom of the Library, and button fills. */
  panel: '#2a1e15',
  line: '#3a2a1e',
  border: '#5a4330',
  borderSoft: '#4a3626',
  wood: '#6a4529',
  woodHighlight: '#8f6039',
  woodDeep: '#5a3b24',
  woodEdge: '#7a5232',
  paper: '#efe3cc',
  paperCard: '#e9dcc0',
  paperCardAlt: '#ece0c4',
  paperRule: '#c9b996',
  muted: '#b9a88c',
  faint: '#9c8b70',
  /** The lamp: play button, status tags, the budget ruler's fill. */
  accent: '#e8a23a',
  accentGlow: 'rgba(232,162,58,0.22)',
  /** Bookmark ribbons, the player playhead. */
  ribbon: '#c8402f',
  /** Over-budget warning: the ruler past 85%, the "won't fit" stamp. */
  warning: '#d0553e',
  warningInk: '#b8402f',
  stampOut: '#5b3a8a',
  stampBack: '#a8352a',
  stampFaded: '#8a7a5e',
  trough: '#2e2219',
  troughDeep: '#17110d',
  bookLine: '#8a7658',
  inkOnPaper: '#2a1d10',
  inkOnLabel: '#3a2a1a',
} as const;

/** Page-edge stripes, used for the thickness block beside every cover. */
export const edge = {
  light: '#efe6d2',
  dark: '#c9bb9b',
} as const;

export const font = {
  /** Titles, the play button label, shelf-empty asides. */
  serif: 'YoungSerif_400Regular',
  /** Every number, all metadata, chips and labels. */
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
  /** Body copy. */
  sans: 'InstrumentSans_400Regular',
  /**
   * The listener's own hand: notes and character bios, and nothing else.
   *
   * Names, times, tags and controls stay in the existing faces — the point is
   * that what someone wrote looks different from what the app wrote, which
   * only works if the app resists writing in it too.
   *
   * No longer the default. Notes and bios are set in `sans` unless the
   * listener turns the handwriting on in Settings, because a page of Caveat
   * is harder to re-read than it is charming to write. See `src/store/ui.ts`.
   */
  hand: 'Caveat_400Regular',
} as const;

export const space = {
  xs: 4,
  sm: 6,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

/** Minimum touch target, per the handoff's character rules. */
export const TOUCH = 44;

export const radius = {
  cover: 2,
  tag: 2,
  chip: 16,
  button: 6,
  play: 22,
} as const;

/**
 * Cross-platform drop shadow. React Native's `boxShadow` is still uneven across
 * platforms, so this emits the classic iOS shadow props alongside an Android
 * elevation that approximates the same depth.
 */
export function shadow(elevation: number, opacity = 0.5) {
  return {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: Math.round(elevation * 0.6) },
    shadowOpacity: opacity,
    shadowRadius: elevation,
    elevation,
  } as const;
}
