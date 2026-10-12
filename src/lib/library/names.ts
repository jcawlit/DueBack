/**
 * Turning messy folder names and tags into a title and an author.
 *
 * The rules here are deliberately dull and predictable rather than clever. The
 * dev screen shows the raw folder name beside the result so the effect of each
 * rule is visible on a real drive.
 */

/** Junk that appears in scene-release style folder names. */
const NOISE_PATTERNS: RegExp[] = [
  /\[[^\]]*\]/g, // [Unabridged], [64kbps], [M4B]
  /\((?:unabridged|abridged|audiobook|audio\s*book|retail|complete)\)/gi,
  /\b(?:unabridged|abridged)\b/gi,
  /\b(?:mp3|m4b|m4a|aac|flac|ogg|opus)\b/gi,
  /\b\d{2,4}\s?k(?:bps)?\b/gi, // 64kbps, 128k
  /\b(?:v?br|cbr|mono|stereo)\b/gi,
  /\b(?:audiobook|audio\s*book)\b/gi,
];

/** A year in brackets or standing alone at the end: (2019), 1989 */
const YEAR_PATTERN = /[([]?\b(19|20)\d{2}\b[)\]]?/g;

/** A leading series or disc number: "04 - ", "15. ", "07_" */
const LEADING_NUMBER = /^\s*\d{1,3}\s*[-._)\]]\s*/;

/**
 * Normalises separators. Underscores and dots are routinely used where spaces
 * or colons belong, because many filesystems disallow the real character.
 */
function normaliseSeparators(input: string): string {
  let s = input;
  // Dots as word separators, but not a decimal point or a file extension.
  if (!s.includes(' ') && s.includes('.')) s = s.replace(/\./g, ' ');
  s = s.replace(/_/g, ' ');
  return s;
}

function collapse(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
}

/**
 * Strips the junk listed above from a name. Used on folder names and on tag
 * values alike, since tags from the same sources carry the same noise.
 */
export function cleanName(raw: string): string {
  let s = normaliseSeparators(raw);
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
  s = s.replace(YEAR_PATTERN, ' ');
  s = collapse(s);
  s = s.replace(LEADING_NUMBER, '');
  return collapse(s);
}

export type NameParts = { title: string; author?: string };

/**
 * Splits "Author - Title" when the pattern is unambiguous: exactly one
 * separator, and both sides look like real text. Anything with several
 * separators is left alone rather than guessed at.
 */
export function splitAuthorTitle(raw: string): NameParts {
  const cleaned = cleanName(raw);
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length !== 2) return { title: cleaned };
  const [left, right] = parts.map((p) => p.trim());
  if (!left || !right) return { title: cleaned };
  // A side that is only digits is a disc or part marker, not an author.
  if (/^\d+$/.test(left) || /^\d+$/.test(right)) return { title: cleaned };
  // Authors are short; a long left side is far more likely to be the title.
  if (left.length > 40) return { title: cleaned };
  return { title: right, author: left };
}

export type TitleSources = {
  /** The book's folder name, as it appears on the drive. */
  folderName: string;
  /** `album` for a multi-part book, `title` for a single file. */
  embeddedTitle?: string;
  embeddedAuthor?: string;
};

/**
 * Tag values that stand in for an author rather than naming one.
 *
 * Rippers write these by the thousand. "Various Artists" on an audiobook means
 * the ripper had nothing to put there, not that a committee wrote it.
 */
const PLACEHOLDER_AUTHOR =
  /^(?:various(?:\s+artists?)?|va|unknown(?:\s+artists?)?|unknown|n\/?a|none|untitled|artist|audiobook|audiobooks)$/i;

export function isPlaceholderAuthor(author: string | undefined): boolean {
  if (!author) return false;
  return PLACEHOLDER_AUTHOR.test(author.trim().replace(/[._-]+/g, ' '));
}

export type ResolvedName = {
  title: string;
  author?: string;
  /** Where each value came from, shown on the dev screen. */
  titleSource: 'embedded' | 'folder' | 'folder-split';
  authorSource: 'embedded' | 'folder-split' | 'none';
  rawFolderName: string;
  cleanedFolderName: string;
  rawEmbeddedTitle?: string;
};

/**
 * Does the embedded title look like the folder name with metadata tacked on?
 *
 * It counts only when the embedded title *starts with* the folder name and the
 * remainder opens with a dash — the separator people use when appending an
 * author or a year, as in "Hyperion - Dan Simmons - 1989". A colon is left
 * alone, because that introduces a subtitle which is part of the real title:
 * "Sharp Ends: Stories from the World of the First Law" must not be cut down to
 * "Sharp Ends" just because a folder happens to be named that.
 */
function isFolderNameWithTrailingMetadata(folder: string, embedded: string): boolean {
  if (!folder || folder.length >= embedded.length) return false;
  if (!embedded.toLowerCase().startsWith(folder.toLowerCase())) return false;
  const remainder = embedded.slice(folder.length);
  return /^\s*[-–—]\s/.test(remainder);
}

/**
 * Embedded metadata wins, with one exception: when the embedded title is just
 * the folder name with metadata appended after a dash, the folder name is the
 * cleaner of the two. That turns an album tag of
 * "15 - Hyperion - Dan Simmons - 1989" into "Hyperion" when the folder already
 * says so, while leaving real subtitles intact.
 */
export function resolveName(sources: TitleSources): ResolvedName {
  const cleanedFolder = cleanName(sources.folderName);
  const folderSplit = splitAuthorTitle(sources.folderName);
  const cleanedEmbedded = sources.embeddedTitle ? cleanName(sources.embeddedTitle) : '';
  const rawAuthor = sources.embeddedAuthor ? cleanName(sources.embeddedAuthor) : '';
  // A placeholder is worse than nothing: it fills the author line with a word
  // that is not a name, and it stops the folder — which often does carry the
  // real author — from being consulted at all.
  const cleanedAuthor = isPlaceholderAuthor(rawAuthor) ? '' : rawAuthor;

  let title = '';
  let titleSource: ResolvedName['titleSource'] = 'folder';

  if (cleanedEmbedded) {
    title = cleanedEmbedded;
    titleSource = 'embedded';
    if (isFolderNameWithTrailingMetadata(cleanedFolder, cleanedEmbedded)) {
      title = cleanedFolder;
      titleSource = 'folder';
    }
  } else if (folderSplit.author) {
    title = folderSplit.title;
    titleSource = 'folder-split';
  } else {
    title = cleanedFolder;
    titleSource = 'folder';
  }

  let author: string | undefined;
  let authorSource: ResolvedName['authorSource'] = 'none';
  if (cleanedAuthor) {
    author = cleanedAuthor;
    authorSource = 'embedded';
  } else if (folderSplit.author) {
    author = folderSplit.author;
    authorSource = 'folder-split';
  }

  return {
    title: title || sources.folderName,
    author,
    titleSource,
    authorSource,
    rawFolderName: sources.folderName,
    cleanedFolderName: cleanedFolder,
    rawEmbeddedTitle: sources.embeddedTitle,
  };
}

/**
 * Natural ordering, so "Part 2" precedes "Part 10". Compares runs of digits
 * numerically and everything else as text.
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  const bx = b.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const x = ax[i];
    const y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
