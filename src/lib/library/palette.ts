/**
 * Fallback cover colours.
 *
 * A book with no artwork still needs to look like a book on the shelf. Rather
 * than analysing pixels, each book gets a stable colour from this palette,
 * chosen by its id — so a cover always looks the same, and a shelf looks varied.
 * The palette is the one from the mockups.
 */

const PALETTE: { bg: string; ink: string }[] = [
  { bg: '#2f4a3a', ink: '#f0e6cf' },
  { bg: '#8a2f24', ink: '#f3e2c2' },
  { bg: '#1f3550', ink: '#e9dcc0' },
  { bg: '#c9a24a', ink: '#2a1d10' },
  { bg: '#3d5a6b', ink: '#f2ead8' },
  { bg: '#6b2c3e', ink: '#f0dfd0' },
  { bg: '#d8c7a3', ink: '#3a2a1a' },
  { bg: '#141414', ink: '#e0503d' },
  { bg: '#b5582b', ink: '#1c120a' },
  { bg: '#8fa38a', ink: '#1f2a1d' },
  { bg: '#4a4a3a', ink: '#e3dcc0' },
  { bg: '#e7e0cf', ink: '#2b2b2b' },
];

export function fallbackPalette(id: string): { bg: string; ink: string } {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
