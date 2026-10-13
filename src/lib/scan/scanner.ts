/**
 * The scan: walk the library root, group files into books, read each book's
 * metadata, and write the result to SQLite.
 *
 * Two rules shape the whole thing. A scan never copies audio — it only indexes
 * and caches a thumbnail, so the shelves work with the drive unplugged. And one
 * bad file never stops it: every per-file failure is recorded on the book and
 * the scan carries on.
 */

import type { Chapter } from '@/data/types';
import {
  listTree,
  readFileMetadata,
  readImageFile,
} from '@/lib/files/access';
import { storeCover, type CoverSource } from '@/lib/files/covers';
import {
  fingerprintKey,
  findCoverFile,
  groupIntoBooks,
  orderParts,
  workKey,
  type FileGroup,
  type ScannedFile,
} from '@/lib/library/grouping';
import { resolveName } from '@/lib/library/names';
import { sanitiseChapters } from '@/lib/library/chapters';
import { bookIdFor } from '@/lib/library/ids';
import {
  claimedDriveFolders,
  existingFingerprints,
  markMissingExcept,
  upsertBook,
  type ScannedBook,
} from '@/db/books';
import { SETTING_KEYS, setSetting } from '@/db/schema';

export type ScanPhase = 'listing' | 'grouping' | 'reading' | 'saving' | 'done' | 'failed';

export type ScanProgress = {
  phase: ScanPhase;
  /** Human-readable line for the UI: "Found 212 books… reading covers". */
  message: string;
  booksTotal: number;
  booksDone: number;
  filesSeen: number;
  skippedUnsupported: number;
  errors: number;
};

export type ScanResult = {
  books: number;
  updated: number;
  unchanged: number;
  filesSeen: number;
  skippedUnsupported: number;
  unreadableFolders: string[];
  errors: string[];
  /**
   * Files the scan could not read, as "name: reason". Kept apart from `errors`,
   * which is for a whole book failing: a book with one unreadable part is still
   * indexed and playable, but a scan that reports "0 errors" while two files
   * failed is lying about what happened.
   */
  unreadableFiles: string[];
  /** False when the user stopped the scan partway through. */
  completed: boolean;
  /**
   * False when the root itself could not be listed — an unplugged drive, a
   * revoked permission, a folder deleted on a computer. Distinct from an empty
   * library, which is a readable root with nothing in it.
   */
  rootReadable: boolean;
  ms: number;
  bytesRead: number;
  readCount: number;
};

export type ScanOptions = {
  rootUri: string;
  /** Re-read every book even if its files look unchanged. */
  force?: boolean;
  onProgress?: (p: ScanProgress) => void;
  /** Checked between books so a scan can be abandoned. */
  shouldCancel?: () => boolean;
};

/** Identifies a book's files well enough to tell whether anything changed. */
function fingerprintOf(files: ScannedFile[]): string {
  return [...files]
    .map((f) => `${f.relPath}:${f.sizeBytes}:${f.modifiedMs}`)
    .sort()
    .join('|');
}

/**
 * Reads one group of files into a book. Per-file errors are attached to the
 * part and to the book's warnings rather than thrown.
 */
type GroupRead = { file: ScannedFile; read: Awaited<ReturnType<typeof readFileMetadata>> };

/**
 * Splits one folder's files into the books they actually hold.
 *
 * A folder is normally one book, but a shelf of short works gives every file
 * its own album tag; when those name different works, each album is a book.
 *
 * Disc markers are stripped before the albums are compared — a CD rip tags its
 * discs "Dune, CD 1" and "Dune, CD 2", and splitting a book in half is a far
 * more visible mistake than leaving a shelf unsplit.
 */
function partitionByAlbum(reads: GroupRead[]): GroupRead[][] {
  if (reads.length < 2) return [reads];

  const albums = reads.map((r) => r.read.metadata.album?.trim() ?? '');
  if (albums.some((a) => a === '')) return [reads];

  const byWork = new Map<string, GroupRead[]>();
  reads.forEach((r, i) => {
    const key = workKey(albums[i]) || albums[i].toLowerCase();
    const list = byWork.get(key);
    if (list) list.push(r);
    else byWork.set(key, [r]);
  });

  if (byWork.size < 2) return [reads];
  return [...byWork.values()];
}

/**
 * Reads one folder and returns every book it contains — usually one.
 */
async function readGroup(
  group: FileGroup,
  allFiles: ScannedFile[],
  /** Folders an existing book already claims; see `claimedDriveFolders`. */
  claimed: Map<string, string>,
): Promise<ScannedBook[]> {
  // An image beside the audio beats embedded artwork, and knowing that up front
  // means the embedded cover can be skipped entirely.
  const coverImage = findCoverFile(allFiles, group.folderRelPath);

  // One pass over every part. The cover is requested from the first file only:
  // each part of a multi-file book usually embeds the same artwork, and reading
  // all of them turns a 127-part book into tens of megabytes.
  const reads: GroupRead[] = [];
  for (let i = 0; i < group.files.length; i += 1) {
    const file = group.files[i];
    const wantCover = !coverImage && i === 0;
    const read = await readFileMetadata(file.uri, file.name, { cover: wantCover });
    reads.push({ file, read });
  }

  const units = partitionByAlbum(reads);
  if (units.length === 1) {
    // A folder this app put on the drive itself keeps the id of the book it
    // was copied from, rather than being read back as a new one.
    const id =
      claimed.get(group.folderRelPath) ??
      bookIdFor(group.folderRelPath, group.files, { split: group.split });
    return [await buildBook(group, units[0], allFiles, id, coverImage)];
  }

  // The folder turned out to be a shelf. Each book past the first needs its own
  // artwork, which the single cover read above did not fetch.
  const books: ScannedBook[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (!coverImage && i > 0) {
      const first = unit[0];
      const reread = await readFileMetadata(first.file.uri, first.file.name, { cover: true });
      unit[0] = { file: first.file, read: reread };
    }
    const files = unit.map((u) => u.file);
    const id = bookIdFor(group.folderRelPath, files, { split: true });
    books.push(
      await buildBook(
        {
          ...group,
          split: true,
          folderName: unit[0].read.metadata.album?.trim() || group.folderName,
          files,
          // Folder-level counts belong to the first book only, so they are not
          // reported once per book.
          skippedUnsupported: i === 0 ? group.skippedUnsupported : 0,
          drmFiles: i === 0 ? group.drmFiles : 0,
        },
        unit,
        allFiles,
        id,
        coverImage,
      ),
    );
  }
  return books;
}

async function buildBook(
  group: FileGroup,
  reads: GroupRead[],
  allFiles: ScannedFile[],
  bookId: string,
  coverImage: ScannedFile | null,
): Promise<ScannedBook> {
  const started = Date.now();
  const warnings: string[] = [];
  let bytesRead = 0;
  let readCount = 0;
  for (const { file, read } of reads) {
    bytesRead += read.bytesRead;
    readCount += read.readCount;
    if (read.error) warnings.push(`${file.name}: ${read.error}`);
  }

  /**
   * A file only becomes a part if there is something in it to play. Anything
   * unplayable laid into the timeline gives the book phantom parts that play
   * silence and push every later part out of step.
   *
   * A book left with no parts at all is still recorded, flagged and refused at
   * check-out, rather than quietly vanishing from the library.
   */
  const playable = reads.filter(({ file, read }) => {
    if (file.sizeBytes === 0) {
      warnings.push(`${file.name}: the file is empty.`);
      return false;
    }
    if (read.error) return false;
    if (read.metadata.durationSec <= 0) {
      warnings.push(`${file.name}: no readable audio.`);
      return false;
    }
    return true;
  });

  if (playable.length === 0 && reads.length > 0) {
    warnings.push('Nothing in this folder could be read as audio.');
  }

  const ordered = orderParts(
    playable.map(({ file, read }) => ({ file, trackNumber: read.metadata.trackNumber })),
  );
  if (ordered.warning) warnings.push(ordered.warning);

  const readByPath = new Map(reads.map((r) => [r.file.relPath, r.read]));

  // Lay the parts end to end so a single position spans the whole book.
  let cursor = 0;
  const parts = ordered.parts.map((p) => {
    const read = readByPath.get(p.file.relPath);
    const durationSec = read?.metadata.durationSec ?? 0;
    const part = {
      relPath: p.file.relPath,
      name: p.file.name,
      uri: p.file.uri,
      sizeBytes: p.file.sizeBytes,
      modifiedMs: p.file.modifiedMs,
      durationSec,
      startSec: cursor,
      trackNumber: p.trackNumber,
      error: read?.error,
    };
    cursor += durationSec;
    return part;
  });

  const durationSec = cursor;
  const sizeBytes = parts.reduce((n, p) => n + p.sizeBytes, 0);

  // Chapters, best effort. Embedded chapters when they parse; otherwise one
  // chapter per part for a multi-file book; otherwise none at all.
  let chapters: Chapter[] = [];
  /** Set when the chapters are one-per-file stand-ins. */
  let chaptersFromParts = false;
  const multi = parts.length > 1;
  if (!multi) {
    chapters = readByPath.get(parts[0]?.relPath ?? '')?.metadata.chapters ?? [];
  } else {
    const combined: Chapter[] = [];
    let anyEmbedded = false;
    for (const part of parts) {
      const embedded = readByPath.get(part.relPath)?.metadata.chapters ?? [];
      if (embedded.length > 0) {
        anyEmbedded = true;
        for (const c of embedded) {
          combined.push({ title: c.title, startSec: part.startSec + c.startSec });
        }
      } else {
        combined.push({ title: part.name.replace(/\.[^.]+$/, ''), startSec: part.startSec });
      }
    }
    chapters = combined;
    chaptersFromParts = !anyEmbedded;
    if (!anyEmbedded) {
      // Not a warning — this is the documented fallback, worth showing though.
      warnings.push('No embedded chapters; using one chapter per file.');
    }
  }

  // Sorted, deduplicated and named once, here, because everything downstream
  // assumes an ordered list and none of it re-sorts.
  chapters = sanitiseChapters(chapters, durationSec);

  const firstRead = readByPath.get(parts[0]?.relPath ?? '');
  const meta = firstRead?.metadata;

  const name = resolveName({
    folderName: group.folderName,
    // For a multi-file book the per-file title is the part name, so the book's
    // own title comes from the album tag.
    embeddedTitle: multi ? meta?.album : meta?.title ?? meta?.album,
    embeddedAuthor: meta?.author,
  });

  let coverFile: string | undefined;
  let coverSource: CoverSource = 'none';

  if (coverImage) {
    const raw = await readImageFile(coverImage.uri);
    if (raw) {
      const stored = await storeCover(bookId, raw, 'folder-image');
      if (stored) {
        coverFile = stored.fileName;
        coverSource = 'folder-image';
      } else {
        warnings.push(`Cover image ${coverImage.name} could not be resized or saved.`);
      }
    } else {
      warnings.push(`Cover image ${coverImage.name} could not be read.`);
    }
  }

  if (!coverFile) {
    const embedded = reads.find((r) => r.read.metadata.cover)?.read.metadata.cover;
    if (embedded) {
      const stored = await storeCover(bookId, embedded.bytes, 'embedded');
      if (stored) {
        coverFile = stored.fileName;
        coverSource = 'embedded';
      } else {
        // Distinguishing "no artwork" from "artwork we failed to store" is the
        // difference between a data problem and a bug.
        warnings.push(
          `Embedded cover found (${Math.round(embedded.bytes.length / 1024)} KB ` +
            `${embedded.mime}) but could not be saved.`,
        );
      }
    }
  }

  const drm = group.drmFiles > 0 || !!meta?.drm;
  if (drm) warnings.push("Can't play: protected by DRM");

  return {
    id: bookId,
    folderRelPath: group.folderRelPath,
    rawFolderName: group.folderName,
    title: name.title,
    author: name.author,
    narrator: meta?.narrator,
    titleSource: name.titleSource,
    authorSource: name.authorSource,
    durationSec,
    sizeBytes,
    coverFile,
    coverSource,
    chaptersFromParts,
    drm,
    warnings,
    skippedFiles: group.skippedUnsupported,
    scanMs: Date.now() - started,
    bytesRead,
    readCount,
    parts,
    chapters,
  };
}

export async function scanLibrary(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const report = (p: Partial<ScanProgress> & { phase: ScanPhase; message: string }) =>
    options.onProgress?.({
      booksTotal: 0,
      booksDone: 0,
      filesSeen: 0,
      skippedUnsupported: 0,
      errors: 0,
      ...p,
    });

  report({ phase: 'listing', message: 'Looking through the drive…' });

  const listing = await listTree(options.rootUri, {
    onProgress: (n) =>
      report({ phase: 'listing', message: `Found ${n} files…`, filesSeen: n }),
  });

  report({
    phase: 'grouping',
    message: 'Working out which files belong together…',
    filesSeen: listing.files.length,
    skippedUnsupported: listing.unsupportedCount,
  });

  const groups = groupIntoBooks(listing.files);
  const fingerprints = await existingFingerprints();
  const claimed = await claimedDriveFolders();
  console.log(
    `[scan] root=${options.rootUri} files=${listing.files.length} ` +
      `groups=${groups.length} unsupported=${listing.unsupportedCount} ` +
      `unreadable=${listing.unreadableFolders.length} ` +
      `sample=${listing.files.slice(0, 3).map((f) => f.relPath).join(' | ')}`,
  );

  const errors: string[] = [];
  const unreadableFiles: string[] = [];
  const seenIds: string[] = [];
  let updated = 0;
  let unchanged = 0;
  let bytesRead = 0;
  let readCount = 0;

  let cancelled = false;
  for (let i = 0; i < groups.length; i += 1) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const group = groups[i];

    report({
      phase: 'reading',
      message: `Found ${groups.length} books… reading ${group.folderName || 'the root folder'}`,
      booksTotal: groups.length,
      booksDone: i,
      filesSeen: listing.files.length,
      skippedUnsupported: listing.unsupportedCount,
      errors: errors.length,
    });

    // Incremental: skip a folder whose files all have the same size and mtime.
    //
    // Keyed on the folder, not on a book id, because one folder can hold more
    // than one book — a shelf of short works splits by album tag — and the
    // decision to re-read has to be made before the albums have been read.
    // The ids of a skipped folder come from the database, so the books it holds
    // still count as seen and are not swept up as missing.
    const fingerprint = fingerprintOf(group.files);
    const known = fingerprints.get(
      fingerprintKey(group.folderRelPath, group.files[0]?.relPath ?? ''),
    );
    if (!options.force && known && known.fingerprint === fingerprint && fingerprint !== '') {
      seenIds.push(...known.ids);
      unchanged += known.ids.length;
      continue;
    }

    try {
      const books = await readGroup(group, listing.files, claimed);
      for (const book of books) {
        await upsertBook(book);
        seenIds.push(book.id);
        bytesRead += book.bytesRead;
        readCount += book.readCount;
        for (const part of book.parts) {
          if (part.error) unreadableFiles.push(`${part.name}: ${part.error}`);
        }
      }
      updated += books.length;
    } catch (err) {
      // A whole book failing is still not a reason to abandon the scan.
      errors.push(`${group.folderName || group.folderRelPath}: ${(err as Error).message}`);
    }
  }

  report({
    phase: 'saving',
    message: 'Tidying up…',
    booksTotal: groups.length,
    booksDone: groups.length,
  });

  /*
   * Only a scan that walked the whole of a readable root is evidence about
   * what is no longer there. A cancelled scan says nothing about the 90% it
   * never reached, and an unreadable root is not an empty library.
   */
  const rootReadable = listing.rootReadable;
  const completed = !cancelled;
  // The evidence travels with the call; `markMissingExcept` declines without it.
  await markMissingExcept(seenIds, { completed, rootReadable });

  const now = new Date().toISOString();
  // A partial or failed scan is not "last scanned at", either.
  if (completed && rootReadable) {
    await setSetting(SETTING_KEYS.lastScanAt, now);
    await setSetting(SETTING_KEYS.lastSeenAt, now);
  }

  const result: ScanResult = {
    completed,
    rootReadable,
    books: groups.length,
    updated,
    unchanged,
    filesSeen: listing.files.length,
    skippedUnsupported: listing.unsupportedCount,
    unreadableFolders: listing.unreadableFolders,
    errors,
    unreadableFiles,
    ms: Date.now() - started,
    bytesRead,
    readCount,
  };

  report({
    phase: 'done',
    message: `${result.books} books · ${updated} updated · ${unchanged} unchanged`,
    booksTotal: groups.length,
    booksDone: groups.length,
    filesSeen: result.filesSeen,
    skippedUnsupported: result.skippedUnsupported,
    errors: errors.length + unreadableFiles.length,
  });

  return result;
}
