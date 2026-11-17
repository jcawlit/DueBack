/**
 * The colour schemes.
 *
 * Derived schemes are the reason this file matters. A hand-written palette is
 * wrong in ways you can see; a generated one is wrong in ways you only see on
 * the screen nobody opened — a token that silently became `undefined`, a wash
 * that lost its transparency and turned opaque over the thing it was meant to
 * let through, a paper that ended up darker than the ground it sits on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THEME,
  LAMPLIGHT,
  THEMES,
  themeById,
  tinted,
  type Palette,
} from '../src/theme/palettes.ts';

const KEYS = Object.keys(LAMPLIGHT) as (keyof Palette)[];

/** Lightness, 0–1, from either shape a token can take. */
function lightness(value: string): number {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  let r: number, g: number, b: number;
  if (hex) [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16));
  else if (rgba) [r, g, b] = rgba[1].split(',').map((n) => Number(n.trim()));
  else throw new Error(`unreadable colour: ${value}`);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}

describe('every scheme is complete', () => {
  it('has at least the original and three seasons', () => {
    assert.ok(THEMES.length >= 4, `only ${THEMES.length} schemes`);
    assert.ok(THEMES.some((t) => t.id === DEFAULT_THEME), 'the default is one of them');
  });

  it('gives every scheme every token, with nothing missing or empty', () => {
    for (const theme of THEMES) {
      const keys = Object.keys(theme.palette);
      assert.deepEqual(
        keys.sort(),
        [...KEYS].sort(),
        `${theme.id} does not have the same tokens as the base`,
      );
      for (const key of KEYS) {
        const value = theme.palette[key];
        assert.equal(typeof value, 'string', `${theme.id}.${key} is not a string`);
        assert.ok(value.length > 0, `${theme.id}.${key} is empty`);
        assert.ok(
          /^#[0-9a-f]{6}$/i.test(value) || /^rgba?\(/i.test(value),
          `${theme.id}.${key} is not a colour: ${value}`,
        );
      }
    }
  });

  it('gives every scheme a distinct id and a name worth reading', () => {
    const ids = THEMES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate scheme id');
    for (const theme of THEMES) {
      assert.ok(theme.name.length > 0, `${theme.id} has no name`);
      assert.ok(theme.note.length > 0, `${theme.id} has no note`);
    }
  });

  it('falls back to a real scheme for an id it does not know', () => {
    // A choice stored by a build that had a scheme this one does not. Trusting
    // the string would hand every component `undefined` for every colour.
    assert.equal(themeById('a scheme from the future').id, THEMES[0].id);
    assert.equal(themeById('').id, THEMES[0].id);
  });
});

describe('what the tint preserves', () => {
  it('keeps a wash transparent, so it still shows what is under it', () => {
    // The opaque version of a scrim is a solid block over the thing it was
    // meant to veil, which is a screen you cannot read.
    const washes = KEYS.filter((k) => /^rgba/i.test(LAMPLIGHT[k]));
    assert.ok(washes.length > 0, 'the base has washes to check');
    for (const theme of THEMES) {
      for (const key of washes) {
        assert.ok(
          /^rgba\(/i.test(theme.palette[key]),
          `${theme.id}.${key} lost its transparency: ${theme.palette[key]}`,
        );
      }
    }
  });

  it('keeps paper lighter than the ground it sits on', () => {
    for (const theme of THEMES) {
      assert.ok(
        lightness(theme.palette.paper) > lightness(theme.palette.ground) + 0.3,
        `${theme.id}: paper ${theme.palette.paper} against ground ${theme.palette.ground}`,
      );
    }
  });

  it('keeps ink on paper dark enough to read', () => {
    for (const theme of THEMES) {
      for (const key of ['inkOnPaper', 'inkOnPaperBody', 'inkOnPaperSoft'] as const) {
        assert.ok(
          lightness(theme.palette.paper) - lightness(theme.palette[key]) > 0.25,
          `${theme.id}.${key} is too close to its paper`,
        );
      }
    }
  });

  it('leaves the colours that carry a meaning alone', () => {
    // A red that means "this costs you something" means it in every season.
    for (const theme of THEMES) {
      for (const key of ['warning', 'warningInk', 'checkout', 'checkoutInk'] as const) {
        assert.equal(
          theme.palette[key],
          LAMPLIGHT[key],
          `${theme.id} moved ${key}, which is a meaning rather than a mood`,
        );
      }
    }
  });

  it('actually changes something', () => {
    for (const theme of THEMES.filter((t) => t.id !== THEMES[0].id)) {
      const moved = KEYS.filter((k) => theme.palette[k] !== LAMPLIGHT[k]);
      assert.ok(moved.length > KEYS.length / 2, `${theme.id} barely differs`);
    }
  });

  it('leaves a value it cannot read exactly as it was', () => {
    // One unreadable string must not become black, and must not take the rest
    // of the palette down with it.
    const odd = { ...LAMPLIGHT, ground: 'not a colour' } as Palette;
    const out = tinted(odd, { hueShift: 100, satScale: 1 });
    assert.equal(out.ground, 'not a colour');
    assert.notEqual(out.paper, LAMPLIGHT.paper, 'the rest still tinted');
  });

  it('is a pure function of its input', () => {
    const before = { ...LAMPLIGHT };
    tinted(LAMPLIGHT, { hueShift: 90, satScale: 2, accent: '#123456' });
    assert.deepEqual({ ...LAMPLIGHT }, before, 'the base was mutated');
  });

  it('takes the named accent literally, and derives its glow', () => {
    const out = tinted(LAMPLIGHT, { hueShift: 0, satScale: 1, accent: '#7fb2d9' });
    assert.equal(out.accent, '#7fb2d9');
    assert.ok(/^rgba\(127,178,217,0\.22\)$/.test(out.accentGlow), out.accentGlow);
  });
});

describe('no colour is written where it cannot be themed', () => {
  /*
   * A guard, not a style rule. A raw `#4a3c28` in a component is a colour
   * that stays warm brown in a winter scheme — and it fails silently, on
   * whichever screen nobody checked. There were sixty of them before the
   * schemes went in, and finding them was most of the work.
   *
   * Four places are allowed a literal, each for a reason:
   */
  const ALLOWED = new Set([
    // The schemes themselves have to say the colours out loud.
    'src/theme/palettes.ts',
    'src/theme/tokens.ts',
    // A book's jacket, picked by its id so a cover always looks the same. It
    // belongs to the book rather than the app, and recolouring it per season
    // would change what every unillustrated book looks like.
    'src/lib/library/palette.ts',
    // These must equal the native splash, which is set in `app.json` and is
    // not a token. A scheme moving them would open a seam in the handoff.
    'src/components/LoadingScreen.tsx',
  ]);

  it('finds no raw colours outside those four', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, sep } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const offenders: string[] = [];
    for (const file of await walk('src')) {
      const rel = file.split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const text = await readFile(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        const found = line.match(/'#[0-9a-fA-F]{6}'|'rgba?\([^)]*\)'/g);
        if (found) offenders.push(`${rel}:${i + 1}  ${found.join(' ')}`);
      }
    }
    assert.deepEqual(offenders, [], `raw colours found:\n${offenders.join('\n')}`);
  });
});
