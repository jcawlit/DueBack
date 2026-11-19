/**
 * Choosing a font size that keeps one line on one line.
 *
 * `adjustsFontSizeToFit` is iOS-only, and this app is Android, so the
 * shrinking is done here. Pure, so the arithmetic can be tested: the
 * component around it is a measurement and a `<Text>`.
 *
 * The estimate is character count times an average glyph width, which is
 * exact for a monospaced face and close enough for a display line in a
 * proportional one. It errs small — a slightly smaller title is invisible,
 * where one line too many is the thing being fixed.
 */

/**
 * Average glyph width as a fraction of font size.
 *
 * IBM Plex Mono is monospaced, so 0.6 is its real advance width rather than
 * an average. The others are measured-by-eye averages over mixed-case text
 * and rounded up, because rounding up shrinks and rounding down wraps.
 */
export const GLYPH_WIDTH = {
  mono: 0.6,
  serif: 0.58,
  sans: 0.54,
} as const;

export type GlyphWidth = keyof typeof GLYPH_WIDTH;

/**
 * The largest size at or below `maxSize` that should keep `text` on one line.
 *
 * Returns `maxSize` when the width is not known yet — the first render, before
 * layout has run. Starting at full size and shrinking once measured means the
 * common case, where the text already fits, never changes size at all.
 */
export function fittedFontSize(
  text: string,
  availableWidth: number,
  maxSize: number,
  minSize: number,
  face: GlyphWidth = 'sans',
): number {
  if (!text || availableWidth <= 0) return maxSize;
  const perChar = GLYPH_WIDTH[face];
  // Width the text would need at one point of font size.
  const needed = text.length * perChar;
  if (needed <= 0) return maxSize;
  const fits = Math.floor(availableWidth / needed);
  return Math.max(minSize, Math.min(maxSize, fits));
}

/**
 * The size the text wears, and the room kept for it.
 *
 * These two come apart deliberately. The font size shrinks to fit; the line
 * height **does not follow it down** — it is always the full size's, so the
 * box is the same height whatever string is in it.
 *
 * Letting the line height shrink too is what made the Library header change
 * height when the source was switched: "Library" sat at full size, a server's
 * library name shrank to fit, and the nine pixels between them moved the
 * divider and the sort chips every time. Reserving the full line means the
 * text gets smaller inside a box that stays put.
 */
export function fittedText(
  text: string,
  availableWidth: number,
  maxSize: number,
  minSize: number,
  face: GlyphWidth,
  lineHeightRatio: number,
): { fontSize: number; lineHeight: number } {
  return {
    fontSize: fittedFontSize(text, availableWidth, maxSize, minSize, face),
    lineHeight: Math.round(maxSize * lineHeightRatio),
  };
}
