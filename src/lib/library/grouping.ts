/**
 * Turning a tree of files into books.
 *
 * The rule is folder-per-book: every folder that directly contains supported
 * audio is one book. Filename-based splitting is a fallback used only when a
 * single folder clearly holds several distinct books.
 */

import { isDrmContainer, isSupportedAudio, isUnsupportedAudio } from '../metadata/index.ts';
import { naturalCompare } from './names.ts';

/** A file as the platform access layer reports it. */
export type ScannedFile = {
  /** Path relative to the library root, using forward slashes. */
  relPath: string;
  name: string;
  uri: string;
  sizeBytes: number;
  modifiedMs: number;
};

export type FileGroup = {
  /** Folder path relative to the root. Empty string for the root itself. */
  folderRelPath: string;
  folderName: string;
  files: ScannedFile[];
  /** Supported audio that v1 cannot read, counted for the dev screen. */
  skippedUnsupported: number;
  /** Files that are DRM containers (.aa/.aax). */
  drmFiles: number;
  /**
   * True when filename grouping split one folder into several books, which
   * means the folder path alone is not enough to identify this book.
   */
  split: boolean;
};

/**
 * Files that are not content and should never be seen again after this point —
 * not as books, not as parts, not as skipped files, not as warnings.
 *
 * Drives that have been near a Mac are full of `._Something` AppleDouble
 * siblings and `.DS_Store`; Windows leaves `Thumbs.db` and `desktop.ini`.
 * Counting them as "skipped" was technically true and completely useless.
 */
export function isJunkFile(name: string): boolean {
  // Anything hidden: covers ._AppleDouble, .DS_Store, .Trashes, .fseventsd.
  if (name.startsWith('.')) return true;
  return /^(?:thumbs\.db|desktop\.ini|album ?art.*\.ini)$/i.test(name);
}

/**
 * Folder names that mean "one disc of the book in the folder above" rather than
 * a book in their own right, so `Dune/CD 1` and `Dune/CD 2` are one Dune.
 *
 * Deliberately narrow. `Part 1` is excluded on purpose: a folder called that is
 * as likely to be the first book of a series as the first half of one, and
 * wrongly merging two books is much harder to notice than wrongly splitting
 * one.
 */
const DISC_FOLDER =
  /^(?:cd|disc|disk)[\s._-]*\d{1,3}(?:[\s._-]*(?:of|\/)[\s._-]*\d{1,3})?$/i;

export function isDiscFolder(name: string): boolean {
  return DISC_FOLDER.test(name.trim());
}

/**
 * Walks a folder path up past any disc folders, so every disc of a book lands
 * on the same parent. Never collapses into the library root: a top-level
 * `CD 1` has no parent book to belong to.
 */
/**
 * The key an incremental scan files a book's fingerprint under.
 *
 * Normally the folder: one folder can hold several books — a shelf of short
 * works splits by album tag — and the decision to re-read has to be made
 * before the albums have been read, so the whole folder is judged together.
 *
 * A file sitting directly in the library root is the exception. Those are
 * books in their own right, identified by their own path, and keying them by
 * folder filed every one of them under the same empty string: one merged
 * fingerprint, one shared list of ids, and no way to tell which book a change
 * belonged to. They are keyed by their own path instead.
 *
 * Both the scanner and the database must agree on this, which is why it lives
 * here rather than in either of them.
 */
export function fingerprintKey(folderRelPath: string, firstPartRelPath: string): string {
  if (folderRelPath !== '') return folderRelPath;
  // The prefix cannot collide with a folder path, which never starts with a
  // null byte.
  return `\u0000root:${firstPartRelPath}`;
}

export function discParentOf(folderRelPath: string): string {
  let current = folderRelPath;
  for (;;) {
    const slash = current.lastIndexOf('/');
    if (slash < 0) return current;
    const name = current.slice(slash + 1);
    if (!isDiscFolder(name)) return current;
    current = current.slice(0, slash);
  }
}

/**
 * Markers that identify which part of a book a file is, so that stripping them
 * reveals whether several files belong to the same work.
 */
const PART_MARKERS = [
  /\b(?:part|pt|chapter|ch|track|trk|disc|disk|cd|side|file|section)\b[\s._-]*\d+/gi,
  /\b\d+\s*of\s*\d+\b/gi,
  /\[\s*\d+\s*\]/g,
  /\(\s*\d+\s*\)/g,
];

/** Strips part markers and trailing numbers to get a file's "work key". */
export function workKey(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '');
  for (const p of PART_MARKERS) s = s.replace(p, ' ');
  s = s.replace(/\d+/g, ' ');
  return s.replace(/[\s._-]+/g, ' ').trim().toLowerCase();
}

/**
 * Groups files into books, one book per folder.
 *
 * There used to be a second rule here that split a folder whenever its
 * filenames varied once digits and part markers were stripped out. It was
 * wrong in both directions: it shattered a self-recorded book into one book per
 * recording, turned `00 - Intro`, `01`…`10`, `99 - Credits` into three books,
 * and split a book whose parts were named `01 Prologue`, `02 Chapter 1` because
 * "Chapter 1" stripped to nothing and "Prologue" did not. Yet two unrelated
 * files in one folder were left merged, because it also demanded more files
 * than distinct keys.
 *
 * Album tags are now the only evidence used to split a folder, and that happens
 * in the scanner where the tags have actually been read. A folder with no tags
 * at all is one book.
 *
 * The exception is the library root, which is not a book folder: audio sitting
 * loose at the top of the drive is one book per file.
 */
export function groupIntoBooks(files: ScannedFile[]): FileGroup[] {
  const byFolder = new Map<string, ScannedFile[]>();
  const unsupported = new Map<string, number>();
  const drm = new Map<string, number>();

  for (const f of files) {
    if (isJunkFile(f.name)) continue;
    const slash = f.relPath.lastIndexOf('/');
    const ownFolder = slash < 0 ? '' : f.relPath.slice(0, slash);
    // Every disc of a set is filed under the book's own folder, so the discs
    // become one book rather than one book each.
    const folder = discParentOf(ownFolder);
    if (isSupportedAudio(f.name)) {
      const list = byFolder.get(folder);
      if (list) list.push(f);
      else byFolder.set(folder, [f]);
    } else if (isDrmContainer(f.name)) {
      drm.set(folder, (drm.get(folder) ?? 0) + 1);
      // A DRM book still needs a row, so the folder must exist in the map.
      if (!byFolder.has(folder)) byFolder.set(folder, []);
    } else if (isUnsupportedAudio(f.name)) {
      unsupported.set(folder, (unsupported.get(folder) ?? 0) + 1);
    }
    // Everything else — ebooks, images, .txt, .nfo — is silently ignored.
  }

  const groups: FileGroup[] = [];
  for (const [folder, folderFiles] of byFolder) {
    const folderName = folder === '' ? '' : folder.slice(folder.lastIndexOf('/') + 1);
    // Sorted by path, not by name: once discs are merged the names repeat
    // (`CD 1/Track 01.mp3` and `CD 2/Track 01.mp3`), and sorting on the name
    // alone would interleave the two discs.
    const sorted = [...folderFiles].sort((a, b) => naturalCompare(a.relPath, b.relPath));

    // The library root holds books, not audio. A file sitting directly in it
    // belongs to no book folder, so it is a book in its own right, identified
    // by its own path rather than by the folder it shares with everything else.
    if (folder === '' && sorted.length > 0) {
      sorted.forEach((file, index) => {
        groups.push({
          folderRelPath: '',
          folderName: file.name.replace(/\.[^.]+$/, ''),
          files: [file],
          // Root-level counts belong to the first book only, so they are not
          // reported once per loose file.
          skippedUnsupported: index === 0 ? unsupported.get(folder) ?? 0 : 0,
          drmFiles: index === 0 ? drm.get(folder) ?? 0 : 0,
          split: true,
        });
      });
      continue;
    }

    groups.push({
      folderRelPath: folder,
      folderName,
      files: sorted,
      skippedUnsupported: unsupported.get(folder) ?? 0,
      drmFiles: drm.get(folder) ?? 0,
      split: false,
    });
  }

  return groups.sort((a, b) => naturalCompare(a.folderRelPath, b.folderRelPath));
}

export type OrderedPart = {
  file: ScannedFile;
  trackNumber?: number;
};

export type PartOrder = {
  parts: OrderedPart[];
  /** 'tags' when track numbers were used, 'filename' for natural sort. */
  basis: 'tags' | 'filename';
  /** Set when the two orderings disagreed and tags won. */
  warning?: string;
};

/**
 * Orders the parts of a book.
 *
 * Natural filename order is the default. Track numbers are preferred when every
 * file has one and they are all distinct — note that they need not be
 * contiguous, since real collections have gaps. When the two orderings
 * disagree, tags win and the difference is recorded as a warning.
 */
export function orderParts(parts: OrderedPart[]): PartOrder {
  // By path rather than by name, so a merged CD set orders disc-then-track
  // instead of interleaving two discs that both start at "Track 01".
  const byFilename = [...parts].sort((a, b) => naturalCompare(a.file.relPath, b.file.relPath));
  if (parts.length < 2) return { parts: byFilename, basis: 'filename' };

  const numbers = parts.map((p) => p.trackNumber);
  const allPresent = numbers.every((n) => typeof n === 'number' && n > 0);
  const allDistinct = new Set(numbers).size === numbers.length;

  if (!allPresent || !allDistinct) return { parts: byFilename, basis: 'filename' };

  const byTrack = [...parts].sort((a, b) => (a.trackNumber! - b.trackNumber!));
  const same = byTrack.every((p, i) => p.file.relPath === byFilename[i].file.relPath);
  if (same) return { parts: byTrack, basis: 'tags' };

  const firstDiff = byTrack.findIndex((p, i) => p.file.relPath !== byFilename[i].file.relPath);
  return {
    parts: byTrack,
    basis: 'tags',
    warning:
      `Track tags and filenames disagree on order (first difference at position ${firstDiff + 1}: ` +
      `tags say "${byTrack[firstDiff].file.name}", filenames say "${byFilename[firstDiff].file.name}"). ` +
      'Using the track tags.',
  };
}

/** Cover art files that sit beside the audio, preferred over embedded art. */
const COVER_NAME = /(cover|folder|front|artwork|albumart)/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

function coverIn(allFiles: ScannedFile[], folderRelPath: string): ScannedFile | null {
  const inFolder = allFiles.filter((f) => {
    if (isJunkFile(f.name)) return false;
    const slash = f.relPath.lastIndexOf('/');
    const folder = slash < 0 ? '' : f.relPath.slice(0, slash);
    return folder === folderRelPath && IMAGE_EXT.test(f.name);
  });
  if (inFolder.length === 0) return null;
  const named = inFolder.filter((f) => COVER_NAME.test(f.name));
  const pool = named.length > 0 ? named : inFolder;
  // Largest wins: thumbnails and icons sit beside the real artwork.
  return pool.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
}

/**
 * The cover for a book, searched outwards from its own folder.
 *
 * A set ripped as `Dune/CD 1`, `Dune/CD 2` usually keeps its artwork in `Dune`,
 * and a series folder may hold one image for everything inside it, so a parent
 * folder's cover is used by any book below it that has none of its own.
 *
 * The search stops before the library root. A stray image at the top of a drive
 * is far more often a logo, a screenshot or an unrelated download than it is
 * artwork, and stamping it across every coverless book would be worse than
 * leaving them with the generated covers they already get.
 */
export function findCoverFile(allFiles: ScannedFile[], folderRelPath: string): ScannedFile | null {
  let folder = folderRelPath;
  for (;;) {
    const found = coverIn(allFiles, folder);
    if (found) return found;
    const slash = folder.lastIndexOf('/');
    if (slash < 0) return null;
    folder = folder.slice(0, slash);
  }
}
