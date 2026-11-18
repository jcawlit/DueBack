/**
 * Correcting what a book says about itself.
 *
 * Metadata comes from the files, and files lie. "Hyperion" arrives filed
 * under the author "Top 100 scifi books" because that is what the tags say,
 * and nothing a scanner can do will fix it — the tag is not malformed, it is
 * wrong. So the listener gets to overrule it.
 *
 * The correction is a **layer**, never a write into the scanned row. Three
 * reasons, and the first is the one that decides it:
 *
 * 1. A rescan rewrites `books.title` unconditionally (`upsertBook`), so an
 *    edit written there survives only until the drive is plugged in again.
 * 2. The drive's value has to be kept, or "put it back the way it was" is
 *    not a thing the app can offer.
 * 3. A correction is something a person made, so it belongs on the drive with
 *    the notes and the shelves — and `src/lib/sync/records.ts` takes exactly
 *    that as its test of what is worth backing up.
 *
 * ## Null is not blank
 *
 * `null` means "not overridden, use what the files say". `''` means
 * "deliberately empty" — which has to be expressible, because the honest
 * correction for that bogus author is *no author at all*, not another guess.
 * Collapsing the two would make the one field people most want to clear the
 * one field they cannot.
 *
 * `seriesIndex` is stored as text for this reason alone: a REAL column has no
 * room for the distinction, and a sentinel number would be a worse lie than
 * the one being corrected.
 */

/** The fields a listener may overrule. Everything else is a fact about audio. */
export const OVERRIDE_FIELDS = [
  'title',
  'author',
  'narrator',
  'series',
  'seriesIndex',
  'coverFile',
] as const;

export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/**
 * The fields a form submits together.
 *
 * The cover is saved on its own — picking a picture is one gesture and
 * typing a title is another, and a patch that carried both would mean
 * choosing a picture quietly reverted a title typed a moment earlier.
 */
export type TextOverrideField = Exclude<OverrideField, 'coverFile'>;

/**
 * One book's corrections, as stored.
 *
 * Every field is independently `null`: correcting a title says nothing about
 * the author, and a later rescan that finds a better author must still be
 * allowed to supply one.
 */
export type BookOverride = {
  title?: string | null;
  author?: string | null;
  narrator?: string | null;
  series?: string | null;
  /** Text. See the note on null and blank above. */
  seriesIndex?: string | null;
  /** A thumbnail in the covers directory, written by `storeUserCover`. */
  coverFile?: string | null;
};

/** What the scan found, and what a correction sits on top of. */
export type ScannedFacts = {
  title: string;
  author: string;
  narrator?: string;
  series?: string;
  seriesIndex?: number;
  coverFile?: string;
};

export type LayeredFacts = ScannedFacts & {
  /** Which fields the listener set, so the UI can say so and offer a revert. */
  overridden: OverrideField[];
};

/** True when this field carries a correction — including a deliberate blank. */
export function isOverridden(override: BookOverride | null | undefined, field: OverrideField) {
  if (!override) return false;
  const value = override[field];
  return value !== null && value !== undefined;
}

export function overriddenFields(override: BookOverride | null | undefined): OverrideField[] {
  return OVERRIDE_FIELDS.filter((field) => isOverridden(override, field));
}

/**
 * Reads a stored series index back.
 *
 * Anything that is not a finite number reads as "none", so a row hand-edited
 * to nonsense degrades to an unnumbered book rather than sorting a shelf by
 * `NaN`.
 */
export function parseSeriesIndex(text: string | null | undefined): number | undefined {
  if (text === null || text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The values to show, and which of them came from the listener.
 *
 * Empty strings survive as empty: the point of storing `''` is that it reaches
 * here and wins, so a cleared author renders as no author. `undefined` is used
 * for the absent optionals, because that is what the rest of the app already
 * treats as "nothing here".
 */
export function applyOverride(
  scanned: ScannedFacts,
  override: BookOverride | null | undefined,
): LayeredFacts {
  const overridden = overriddenFields(override);
  if (overridden.length === 0) return { ...scanned, overridden };

  const text = (field: 'title' | 'author' | 'narrator' | 'series' | 'coverFile') =>
    isOverridden(override, field) ? (override![field] as string) : undefined;

  const title = text('title');
  const author = text('author');
  const narrator = text('narrator');
  const series = text('series');
  const coverFile = text('coverFile');

  return {
    ...scanned,
    // Title and author are required, so a blank correction shows as blank
    // rather than falling back to the thing it was meant to remove.
    title: title ?? scanned.title,
    author: author ?? scanned.author,
    narrator: narrator === undefined ? scanned.narrator : orNothing(narrator),
    series: series === undefined ? scanned.series : orNothing(series),
    seriesIndex: isOverridden(override, 'seriesIndex')
      ? parseSeriesIndex(override!.seriesIndex)
      : scanned.seriesIndex,
    // A cleared cover means "no picture", which is a fallback cover drawn from
    // the book's colour, not the embedded art coming back.
    coverFile: coverFile === undefined ? scanned.coverFile : orNothing(coverFile),
    overridden,
  };
}

/** Blank reads as absent for the fields the app treats as optional. */
function orNothing(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * Turns what somebody typed into what should be stored.
 *
 * Returns `null` — store nothing — when the text matches what the files
 * already say. Opening the editor and saving it unchanged is not a
 * correction, and recording one anyway would quietly freeze that field
 * against every future rescan. The listener would have no way to know they
 * had done it, and no reason to look.
 */
export function normaliseEdit(
  typed: string,
  scanned: string | number | undefined,
): string | null {
  const text = typed.trim();
  const current = scanned === undefined ? '' : String(scanned);
  if (text === current.trim()) return null;
  return text;
}

/**
 * The patch to store for a whole form submission.
 *
 * Fields the person left matching the scan come back `null`, which clears any
 * correction that was there before — so retyping the drive's own value is how
 * a single field is reverted, and it does the same thing as the revert
 * button.
 */
export function editsToOverride(
  typed: { title: string; author: string; narrator: string; series: string; seriesIndex: string },
  scanned: ScannedFacts,
): Omit<BookOverride, 'coverFile'> {
  return {
    title: normaliseEdit(typed.title, scanned.title),
    author: normaliseEdit(typed.author, scanned.author),
    narrator: normaliseEdit(typed.narrator, scanned.narrator),
    series: normaliseEdit(typed.series, scanned.series),
    seriesIndex: normaliseEdit(typed.seriesIndex, scanned.seriesIndex),
  };
}
