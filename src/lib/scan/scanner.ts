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
import { unvouchedFolders, wasUnseen } from './coverage';
import { newUuid, pathKeyFor } from '@/lib/library/ids';
import { sampleBook } from './sample';
import {
  claimedDriveFolders,
  existingFingerprints,
  markMissingExcept,
  upsertBook,
  type ScannedBook,
} from '@/db/books';
import { SETTING_KEYS, setSetting } from '@/db/schema';
import {
  seedRestoredIdentities,
  loadPathKeyIndex,
  loadVanishedBooks,
  reconnectBook,
  type ReconnectQuestion,
} from '@/db/identity';
import { planReconnection, shapeOf } from '@/lib/library/identity';
import { readDrive } from '@/lib/sync/driveSync';
import { resolveLibraryId } from '@/lib/sync/libraryIdentity';

/**
 * Where every book this library knows about was last found.
 *
 * The phone's own record first, then the drive's. The drive's identity
 * manifest is what makes a restore possible at all: a phone that has never
 * seen this library would otherwise mint a fresh uuid for every folder, and
 * the notes in the backup — keyed to the old uuids — would have nothing to
 * belong to. Taking the drive's word for who a book is means the writing
 * lands back on it.
 *
 * The phone wins where both have an answer. It has been scanning this drive
 * and the manifest may be from before a book moved.
 */
async function seedIdentity(rootUri: string, libraryId: string): Promise<Map<string, string>> {
  const drive = await readDrive(rootUri, libraryId);
  await seedRestoredIdentities(libraryId, drive.payload?.identity ?? []);
  return loadPathKeyIndex(libraryId);
}


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
  /** Books recognised as a folder that had moved, and reconnected silently. */
  reconnected: number;
  /**
   * Books that may have moved, where the scan declined to decide.
   *
   * Reconnecting the wrong book moves someone's place, their history and
   * everything they wrote onto a book that is not theirs, and there is no undo
   * for that worth the name. So anything short of one candidate proved by its
   * content comes back here for the user to answer.
   */
  reconnectQuestions: ReconnectQuestion[];
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
/** What a scan needs to know about books it has already seen before. */
export type IdentityContext = {
  /** This library, so books stay attached to it across a change of path. */
  libraryId: string | null;
  /** Where a book was last found, to its uuid. */
  byPathKey: Map<string, string>;
};

async function readGroup(
  group: FileGroup,
  allFiles: ScannedFile[],
  /** Folders an existing book already claims; see `claimedDriveFolders`. */
  claimed: Map<string, string>,
  identity: IdentityContext,
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
    const pathKey = pathKeyFor(group.folderRelPath, group.files, { split: group.split });
    /*
     * Three ways to be a book that already exists, in order of how sure we
     * are: a folder this app wrote to the drive itself (it carries the id of
     * the book it was copied from), a folder we have walked before, and
     * otherwise a brand-new identity that reconciliation may later recognise
     * as a book that has moved.
     */
    const id =
      claimed.get(group.folderRelPath) ?? identity.byPathKey.get(pathKey) ?? newUuid();
    return [await buildBook(group, units[0], allFiles, id, coverImage, pathKey, identity)];
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
    // One folder, several books: the first file's name tells them apart, and
    // each keeps its own identity across a rename of the folder around them.
    const pathKey = pathKeyFor(group.folderRelPath, files, { split: true });
    const id = identity.byPathKey.get(pathKey) ?? newUuid();
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
        pathKey,
        identity,
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
  pathKey: string,
  identity: IdentityContext,
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

  /*
   * The content sample, taken here because this is the only moment the book is
   * known to be readable. It is what lets a folder renamed tomorrow be
   * recognised as this book rather than a stranger. `npm run kb identity`.
   */
  const sampled = await sampleBook(parts);
  if (sampled) {
    bytesRead += sampled.bytesRead;
    readCount += sampled.readCount;
  }

  return {
    id: bookId,
    pathKey,
    libraryId: identity.libraryId,
    partSizes: parts.map((p) => p.sizeBytes),
    sampleHash: sampled?.hash ?? null,
    sampleVersion: sampled?.version ?? 0,
    folderRelPath: group.folderRelPath,
    rawFolderName: group.folderName,
    title: name.title,
    author: name.author,
    narrator: meta?.narrator,
    series: meta?.series,
    seriesIndex: meta?.seriesIndex,
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
  /*
   * Identity is settled before anything is read, so that a folder walked
   * before keeps its uuid and a folder that is new gets one of its own — and
   * the two can be told apart afterwards, which is what makes recognising a
   * renamed folder possible at all.
   */
  const libraryId = await resolveLibraryId(options.rootUri);
  const identity: IdentityContext = {
    libraryId,
    byPathKey: await seedIdentity(options.rootUri, libraryId),
  };
  /** Books with no prior row: the only things a vanished book could become. */
  const freshlyFound: { id: string; title: string; folderRelPath: string }[] = [];
  /** Their shapes, so a vanished book can be matched without re-reading. */
  const scannedShapes = new Map<string, { shape: ReturnType<typeof shapeOf>; sampleHash: string | null }>();
  const fingerprints = await existingFingerprints(libraryId);
  const claimed = await claimedDriveFolders(libraryId);
  if (__DEV__) {
    console.log(
      `[scan] root=${options.rootUri} files=${listing.files.length} ` +
        `groups=${groups.length} unsupported=${listing.unsupportedCount} ` +
        `unreadable=${listing.unreadableFolders.length} ` +
        `sample=${listing.files.slice(0, 3).map((f) => f.relPath).join(' | ')}`,
    );
  }

  const errors: string[] = [];
  /*
   * The folders whose books threw while being read.
   *
   * Kept beside `errors`, which is for showing a person: these are paths, for
   * `markMissingExcept`. A book that failed to parse never reaches `seenIds`,
   * and the sweep would otherwise read that absence as the book having gone
   * from the drive.
   */
  const erroredFolders: string[] = [];
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
      const books = await readGroup(group, listing.files, claimed, identity);
      for (const book of books) {
        const isNew = !identity.byPathKey.has(book.pathKey ?? '');
        await upsertBook(book);
        if (isNew) {
          freshlyFound.push({
            id: book.id,
            title: book.title,
            folderRelPath: book.folderRelPath,
          });
          scannedShapes.set(book.id, {
            shape: shapeOf({
              sizeBytes: book.sizeBytes,
              durationSec: book.durationSec,
              partSizes: book.partSizes ?? [],
            }),
            sampleHash: book.sampleHash ?? null,
          });
        }
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
      erroredFolders.push(group.folderRelPath);
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
  /*
   * Books that did not turn up, against folders that were not there before.
   *
   * Only worth asking when the scan actually walked the whole of a readable
   * root: a cancelled scan or an unplugged drive has not shown that anything
   * is missing, and offering to reconnect on that evidence would be inviting
   * someone to merge two books because the cable was loose.
   */
  /*
   * What this scan is entitled to conclude.
   *
   * `completed` and `rootReadable` say the walk ran to the end over a root it
   * could read. They do not say it saw everything: a subfolder that would not
   * list, a subtree past the depth limit, and a book that threw while being
   * read all leave the scan with a gap — and both of the things below read a
   * gap as proof that a book is gone. These are the folders it cannot vouch
   * for, and a book in one of them is left exactly as it was.
   */
  const unvouched = unvouchedFolders(listing.unseenFolders, erroredFolders);

  let reconnected = 0;
  const reconnectQuestions: ReconnectQuestion[] = [];
  if (completed && rootReadable && freshlyFound.length > 0) {
    /*
     * A book whose folder was never read has not vanished, so it is not a
     * candidate for being reconnected to something else. The comment above
     * applies at folder granularity too: offering to merge a book with an
     * unrelated one because its subfolder would not list is the same mistake
     * as doing it because the cable was loose.
     */
    const vanished = (await loadVanishedBooks(seenIds)).filter(
      (gone) => !wasUnseen(gone.folderRelPath, unvouched),
    );
    const unclaimed = new Set(freshlyFound.map((b) => b.id));

    for (const gone of vanished) {
      const candidates = freshlyFound
        .filter((found) => unclaimed.has(found.id))
        .map((found) => {
          const row = scannedShapes.get(found.id);
          return {
            book: found,
            shape: row?.shape ?? { sizeBytes: -1, durationSec: -1, partCount: -1, partSizes: [] },
            sampleHash: row?.sampleHash ?? null,
          };
        });

      const plan = planReconnection(gone, candidates);
      if (plan.kind === 'reconnect') {
        await reconnectBook(plan.to.id, gone.id);
        unclaimed.delete(plan.to.id);
        // The found row is gone; the identity that kept its place is seen.
        const at = seenIds.indexOf(plan.to.id);
        if (at >= 0) seenIds[at] = gone.id;
        reconnected += 1;
      } else if (plan.kind === 'ask') {
        reconnectQuestions.push({
          missingId: gone.id,
          missingTitle: gone.title,
          missingFolder: gone.folderRelPath,
          candidates: plan.candidates,
          reason: plan.reason,
        });
      }
    }
  }

  await markMissingExcept(seenIds, { completed, rootReadable, unvouched });

  const now = new Date().toISOString();
  // A partial or failed scan is not "last scanned at", either.
  if (completed && rootReadable) {
    await setSetting(SETTING_KEYS.lastScanAt, now);
    await setSetting(SETTING_KEYS.lastSeenAt, now);
  }

  const result: ScanResult = {
    completed,
    rootReadable,
    reconnected,
    reconnectQuestions,
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
