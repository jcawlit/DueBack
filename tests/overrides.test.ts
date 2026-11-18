/**
 * Correcting a book's metadata without the drive overruling it.
 *
 * The rules under test are the ones that are easy to get subtly wrong and
 * impossible to notice afterwards: a blank that means "blank" rather than
 * "unset", a field left alone staying open to a future rescan, and an
 * unchanged save storing nothing at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverride,
  editsToOverride,
  isOverridden,
  normaliseEdit,
  overriddenFields,
  parseSeriesIndex,
  type ScannedFacts,
} from '../src/lib/library/overrides.ts';

const hyperion: ScannedFacts = {
  title: 'Hyperion',
  // What the tags actually say, and the reason this feature exists.
  author: 'Top 100 scifi books',
  narrator: 'Victor Bevine',
  series: 'Hyperion Cantos',
  seriesIndex: 1,
  coverFile: 'abc.123.jpg',
};

describe('what counts as overridden', () => {
  it('ignores a field that was never set', () => {
    assert.equal(isOverridden({ title: null }, 'title'), false);
    assert.equal(isOverridden({}, 'author'), false);
    assert.equal(isOverridden(null, 'title'), false);
  });

  it('counts a deliberate blank', () => {
    // The whole point: clearing the bogus author is a correction, not an
    // absence of one.
    assert.equal(isOverridden({ author: '' }, 'author'), true);
  });

  it('lists only the fields that were set', () => {
    assert.deepEqual(overriddenFields({ author: 'Dan Simmons', title: null }), ['author']);
    assert.deepEqual(overriddenFields({}), []);
  });
});

describe('layering a correction over the scan', () => {
  it('passes the scan through untouched when there is nothing to apply', () => {
    assert.deepEqual(applyOverride(hyperion, null), { ...hyperion, overridden: [] });
    assert.deepEqual(applyOverride(hyperion, { title: null }), { ...hyperion, overridden: [] });
  });

  it('replaces only the field that was corrected', () => {
    const out = applyOverride(hyperion, { author: 'Dan Simmons' });
    assert.equal(out.author, 'Dan Simmons');
    assert.equal(out.title, 'Hyperion', 'the title was not part of this');
    assert.equal(out.narrator, 'Victor Bevine');
    assert.deepEqual(out.overridden, ['author']);
  });

  it('shows a cleared optional field as absent, not as the old value', () => {
    /*
     * The failure this guards: falling back to the scan whenever the override
     * is falsy, which makes a cleared field spring back to exactly the thing
     * the listener was trying to get rid of.
     */
    const out = applyOverride(hyperion, { author: '', narrator: '', series: '' });
    assert.equal(out.author, '', 'author is required, so blank stays blank');
    assert.equal(out.narrator, undefined);
    assert.equal(out.series, undefined);
  });

  it('leaves a field open to a later rescan when it was not corrected', () => {
    // A scan that finds a real series later must be allowed to supply it.
    const found = applyOverride({ ...hyperion, series: 'Found On Rescan' }, { author: 'Dan Simmons' });
    assert.equal(found.series, 'Found On Rescan');
  });

  it('reads a corrected series index back as a number', () => {
    assert.equal(applyOverride(hyperion, { seriesIndex: '2' }).seriesIndex, 2);
    assert.equal(applyOverride(hyperion, { seriesIndex: '2.5' }).seriesIndex, 2.5);
  });

  it('reads a cleared series index as no number at all', () => {
    assert.equal(applyOverride(hyperion, { seriesIndex: '' }).seriesIndex, undefined);
  });

  it('degrades a nonsense series index to none rather than sorting by NaN', () => {
    assert.equal(parseSeriesIndex('book two'), undefined);
    assert.equal(applyOverride(hyperion, { seriesIndex: 'book two' }).seriesIndex, undefined);
  });

  it('swaps the cover, and a cleared cover means the drawn fallback', () => {
    assert.equal(applyOverride(hyperion, { coverFile: 'x.user.9.jpg' }).coverFile, 'x.user.9.jpg');
    assert.equal(applyOverride(hyperion, { coverFile: '' }).coverFile, undefined);
  });
});

describe('turning what somebody typed into what to store', () => {
  it('stores nothing when the text matches what the files say', () => {
    /*
     * Opening the editor and saving it unchanged must not freeze the field.
     * Nobody would know it had happened, and every future rescan would be
     * silently overruled by a correction that corrects nothing.
     */
    assert.equal(normaliseEdit('Hyperion', 'Hyperion'), null);
    assert.equal(normaliseEdit('  Hyperion  ', 'Hyperion'), null, 'whitespace is not an edit');
    assert.equal(normaliseEdit('1', 1), null, 'nor is retyping a number');
  });

  it('stores a blank as a blank, because that is a real correction', () => {
    assert.equal(normaliseEdit('', 'Top 100 scifi books'), '');
  });

  it('stores nothing when a field was empty and stayed empty', () => {
    assert.equal(normaliseEdit('', undefined), null);
  });

  it('reverts one field by retyping the drive’s own value', () => {
    // Same effect as the revert button, which is why it is the same code path.
    const patch = editsToOverride(
      { title: 'Hyperion', author: 'Dan Simmons', narrator: '', series: '', seriesIndex: '' },
      hyperion,
    );
    assert.equal(patch.title, null, 'unchanged, so no correction is kept');
    assert.equal(patch.author, 'Dan Simmons');
    assert.equal(patch.narrator, '', 'cleared');
    assert.equal(patch.series, '');
    assert.equal(patch.seriesIndex, '');
  });

  it('round-trips a form nobody touched into no corrections at all', () => {
    const patch = editsToOverride(
      {
        title: hyperion.title,
        author: hyperion.author,
        narrator: hyperion.narrator ?? '',
        series: hyperion.series ?? '',
        seriesIndex: String(hyperion.seriesIndex),
      },
      hyperion,
    );
    assert.deepEqual(overriddenFields(patch), []);
  });
});
