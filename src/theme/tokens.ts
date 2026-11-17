import { DEFAULT_THEME, themeById, type Palette } from './palettes';

/**
 * Design tokens. These are the values from HANDOFF.md's token table, and they are
 * the only place raw colours should appear — components reference them by name.
 */

/**
 * The colours in force right now.
 *
 * A live object, not a constant, and that is the whole trick: every one of the
 * 500-odd `color.x` reads in this app happens while a component renders, so
 * replacing the values in place changes the app's colours without touching a
 * single one of those reads.
 *
 * What it does **not** do is make anything re-render. A component that does not
 * run again keeps the colours it painted with, which is why the theme store
 * exists and why screens subscribe to it. `src/store/theme.ts` has the rest.
 */
export const color: Palette = { ...themeById(DEFAULT_THEME).palette };

/**
 * Swaps the colours in force.
 *
 * In place, deliberately: handing back a new object would leave every module
 * that imported the old one pointing at the old colours.
 */
export function applyPalette(palette: Palette) {
  Object.assign(color, palette);
}

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
