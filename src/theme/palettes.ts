/**
 * Colour schemes.
 *
 * `LAMPLIGHT` is the original: lamp amber on dark wood and warm paper, and the
 * values from HANDOFF.md's token table. Every other scheme is **derived** from
 * it rather than written out by hand.
 *
 * That is deliberate. A palette here is sixty-odd values whose relationships
 * carry the design — paper reads lighter than the ground it sits on, a rule is
 * a shade off the card it rules, a wash is the ground at low opacity. Choosing
 * them all again per scheme means sixty chances to break one of those, and no
 * amount of care catches it on a screen nobody opened. Rotating hue and
 * scaling saturation moves every colour together, so the relationships survive
 * by construction and a new scheme is three numbers.
 *
 * What does not rotate is anything carrying a meaning rather than a mood: the
 * warning red, the check-out green. A red that means "this costs you
 * something" should mean it in every season.
 */
export const LAMPLIGHT = {
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
  /**
   * Taking a book: the check-out button, and the line that offers to.
   *
   * The one green thing in a palette of lamp amber, paper and wood, so it
   * reads as the agreeing action without shouting. Olive rather than a
   * signal green, which beside this paper would look like a different app.
   */
  checkout: '#6d9a4f',
  checkoutInk: '#5b8341',
  /** Over-budget warning: the ruler past 85%, the "won't fit" stamp. */
  warning: '#d0553e',
  warningInk: '#b8402f',
  stampOut: '#5b3a8a',
  /**
   * A character's name where it appears inside a note.
   *
   * The same purple as the stamps, lifted far enough to read on the dark
   * ground and washed behind so a name is visibly a thing you can press.
   * The wash deepens for whoever the list is currently filtered to.
   */
  mentionInk: '#d9c2f5',
  mentionWash: 'rgba(160,120,220,0.16)',
  mentionWashOn: 'rgba(160,120,220,0.32)',
  stampBack: '#a8352a',
  stampFaded: '#8a7a5e',
  trough: '#2e2219',
  troughDeep: '#17110d',
  bookLine: '#8a7658',
  inkOnPaper: '#2a1d10',
  inkOnLabel: '#3a2a1a',
  /** Body copy on a paper card, and the quieter line under it. */
  inkOnPaperBody: '#4a3c28',
  inkOnPaperSoft: '#6b5a42',
  /** Placeholder text waiting to be typed over. */
  inkOnPaperFaint: '#5f4f38',
  /** A dark button on paper, held down. */
  inkOnPaperPressed: '#2f2416',
  /** Paper tones used *on* the dark ground, between `muted` and `paper`. */
  paperSoft: '#cbbb9e',
  paperWarm: '#d3c4a2',
  paperWarmer: '#e3d5b5',
  /** The library card: its ruled lines and the metadata written on them. */
  cardInk: '#5a4a32',
  cardInkSoft: '#7a6446',
  cardRule: '#b5a384',
  /** The drive-is-missing screen, which is warmer than the rest. */
  driveInk: '#a8916a',
  driveAccent: '#c9a466',
  driveDeep: '#3a2616',
  /** Metadata in the Library header. */
  headerSoft: '#a8906c',
  /** A character's name on paper, where the dark version would glare. */
  mentionDeep: '#7a5aa8',
  mentionWashFaint: 'rgba(91,58,138,0.14)',
  /** Behind a modal. The soft one is for sheets you can see past. */
  scrim: 'rgba(10,7,5,0.72)',
  scrimSoft: 'rgba(10,7,5,0.6)',
  /** Over a cover: the copy overlay, and the tag behind a badge. */
  coverScrim: 'rgba(18,13,10,0.74)',
  coverScrimSoft: 'rgba(18,13,10,0.62)',
  /** The ground, laid over something: a grip, a scrubber, a badge. */
  groundWash: 'rgba(27,20,16,0.82)',
  groundWashSoft: 'rgba(27,20,16,0.55)',
  groundWashFaint: 'rgba(27,20,16,0.45)',
  /** Held down, on paper. */
  pressWash: 'rgba(0,0,0,0.08)',
  pressWashStrong: 'rgba(0,0,0,0.12)',
  /** Plain shade: a ruler's ticks, a gradient down a cover. */
  shade: 'rgba(0,0,0,0.25)',
  shadeSoft: 'rgba(0,0,0,0.2)',
  shadeStrong: 'rgba(0,0,0,0.5)',
  /** A highlight along the lit edge of a cover. */
  sheen: 'rgba(255,255,255,0.08)',
};

/** Every colour the app can name. */
export type Palette = Record<keyof typeof LAMPLIGHT, string>;

/** A colour's hue, saturation and lightness, from `#rrggbb` or `rgba(...)`. */
type Hsl = { h: number; s: number; l: number; a: number };

function parse(value: string): Hsl | null {
  let r: number, g: number, b: number, a = 1;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (hex) {
    [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16));
  } else {
    const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
    if (!rgba) return null;
    const parts = rgba[1].split(',').map((n) => Number(n.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    [r, g, b] = parts;
    a = parts.length > 3 ? parts[3] : 1;
  }
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l, a };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l, a };
}

function format({ h, s, l, a }: Hsl): string {
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  const [r, g, b] = [channel(0), channel(8), channel(4)];
  if (a >= 1) {
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  // Still rgba: the washes work by letting what is under them show through.
  return `rgba(${r},${g},${b},${a})`;
}

/** Tokens whose colour *is* their meaning, and so never move. */
const FIXED: readonly string[] = ['warning', 'warningInk', 'checkout', 'checkoutInk'];

export type Tint = {
  /** Degrees around the wheel. The base is a warm brown at about 25 degrees. */
  hueShift: number;
  /** Multiplies saturation. Under 1 is greyer, over 1 richer. */
  satScale: number;
  /** The lamp, named outright: it is the colour anyone will actually notice. */
  accent?: string;
};

export function tinted(base: Palette, tint: Tint): Palette {
  const out = { ...base };
  for (const key of Object.keys(out) as (keyof Palette)[]) {
    if (FIXED.includes(key)) continue;
    const hsl = parse(out[key]);
    // A value this cannot read is left exactly as it was, which is what stops
    // one unreadable string from turning a colour into black.
    if (!hsl) continue;
    out[key] = format({
      ...hsl,
      h: (hsl.h + tint.hueShift + 360) % 360,
      s: Math.max(0, Math.min(1, hsl.s * tint.satScale)),
    });
  }
  if (tint.accent) {
    out.accent = tint.accent;
    const accent = parse(tint.accent);
    if (accent) out.accentGlow = format({ ...accent, a: 0.22 });
  }
  return out;
}

export type ThemeId = 'lamplight' | 'frost' | 'ember' | 'orchard';

export type Theme = { id: ThemeId; name: string; note: string; palette: Palette };

/**
 * The schemes, in the order Settings lists them.
 *
 * A seasonal one is a tint and a lamp colour; adding another is four lines.
 */
export const THEMES: Theme[] = [
  {
    id: 'lamplight',
    name: 'Lamplight',
    note: 'Amber on dark wood. The original.',
    palette: LAMPLIGHT,
  },
  {
    id: 'frost',
    name: 'Frost',
    note: 'Winter. Cold slate, a pale lamp.',
    palette: tinted(LAMPLIGHT, { hueShift: 185, satScale: 0.72, accent: '#7fb2d9' }),
  },
  {
    id: 'ember',
    name: 'Ember',
    note: 'Autumn. Deeper reds, a low fire.',
    palette: tinted(LAMPLIGHT, { hueShift: -18, satScale: 1.18, accent: '#e2703a' }),
  },
  {
    id: 'orchard',
    name: 'Orchard',
    note: 'Spring. Green shade, afternoon light.',
    palette: tinted(LAMPLIGHT, { hueShift: 86, satScale: 0.8, accent: '#d8c24a' }),
  },
];

export const DEFAULT_THEME: ThemeId = 'lamplight';

export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];
