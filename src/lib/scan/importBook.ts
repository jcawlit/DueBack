/**
 * Indexing a book that was imported from the phone.
 *
 * This runs the same metadata, naming and chapter pipeline the scanner uses,
 * so an imported book is indistinguishable from a scanned one once it is in
 * the database — except that it knows it is not on the drive yet.
 */

import type { Chapter } from '@/data/types';
import { readFileMetadata } from '@/lib/files/access';
import { storeCover } from '@/lib/files/covers';
import type { ImportedFile } from '@/lib/files/import';
import { orderParts } from '@/lib/library/grouping';
import { resolveName } from '@/lib/library/names';
import { sanitiseChapters } from '@/lib/library/chapters';
import { upsertBook, type ScannedBook } from '@/db/books';

export async function buildImportedBook(
  bookId: string,
  folderName: string,
  files: ImportedFile[],
): Promise<ScannedBook> {
  const started = Date.now();
  const warnings: string[] = [];
  let bytesRead = 0;
  let readCount = 0;

  // One pass, cover from the first file only — the same economy the scanner
  // uses, and the reason a 127-part book does not read its artwork 127 times.
  const reads = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const read = await readFileMetadata(file.uri, file.name, { cover: i === 0 });
    bytesRead += read.bytesRead;
    readCount += read.readCount;
    if (read.error) warnings.push(`${file.name}: ${read.error}`);
    reads.push({ file, read });
  }

  /*
   * The same "is there anything in it to play" test the drive scanner applies.
   *
   * These two paths had drifted: a zero-length or unreadable file picked off
   * the drive was never made a part, but the very same file imported from the
   * phone was laid into the timeline with a duration of zero. That gave the
   * book phantom parts that played silence and pushed every later part's
   * start time out of step with the real audio.
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
    warnings.push('Nothing here could be read as audio.');
  }

  const ordered = orderParts(
    playable.map(({ file, read }) => ({
      file: {
        relPath: file.relPath,
        name: file.name,
        uri: file.uri,
        sizeBytes: file.sizeBytes,
        modifiedMs: 0,
      },
      trackNumber: read.metadata.trackNumber,
    })),
  );
  if (ordered.warning) warnings.push(ordered.warning);

  const readByPath = new Map(playable.map((r) => [r.file.relPath, r.read]));

  let cursor = 0;
  const parts = ordered.parts.map((p) => {
    const read = readByPath.get(p.file.relPath);
    const durationSec = read?.metadata.durationSec ?? 0;
    const part = {
      relPath: p.file.relPath,
      name: p.file.name,
      uri: p.file.uri,
      sizeBytes: p.file.sizeBytes,
      modifiedMs: 0,
      durationSec,
      startSec: cursor,
      trackNumber: p.trackNumber,
      error: read?.error,
    };
    cursor += durationSec;
    return part;
  });

  const multi = parts.length > 1;
  const meta = readByPath.get(parts[0]?.relPath ?? '')?.metadata;

  let chapters: Chapter[] = [];
  /** Set when the chapters are one-per-file stand-ins. */
  let chaptersFromParts = false;
  if (!multi) {
    chapters = meta?.chapters ?? [];
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
    if (!anyEmbedded) warnings.push('No embedded chapters; using one chapter per file.');
  }

  chapters = sanitiseChapters(chapters, cursor);

  const name = resolveName({
    folderName,
    embeddedTitle: multi ? meta?.album : (meta?.title ?? meta?.album),
    embeddedAuthor: meta?.author,
  });

  let coverFile: string | undefined;
  let coverSource: string | undefined;
  const embeddedCover = reads.find((r) => r.read.metadata.cover)?.read.metadata.cover;
  if (embeddedCover) {
    const stored = await storeCover(bookId, embeddedCover.bytes, 'embedded');
    if (stored) {
      coverFile = stored.fileName;
      coverSource = 'embedded';
    }
  }

  warnings.push('Added from this phone. Not on the drive yet.');

  return {
    id: bookId,
    folderRelPath: folderName,
    rawFolderName: folderName,
    title: name.title,
    author: name.author,
    narrator: meta?.narrator,
    titleSource: name.titleSource,
    authorSource: name.authorSource,
    durationSec: cursor,
    sizeBytes: parts.reduce((n, p) => n + p.sizeBytes, 0),
    // Shape, so an import pushed to the drive is recognisable as the same
    // book when it is read back from there.
    partSizes: parts.map((p) => p.sizeBytes),
    coverFile,
    coverSource,
    chaptersFromParts,
    drm: !!meta?.drm,
    warnings,
    skippedFiles: 0,
    scanMs: Date.now() - started,
    bytesRead,
    readCount,
    parts,
    chapters,
  };
}

/** Writes an imported book, marking it as not yet on the drive. */
export async function saveImportedBook(book: ScannedBook, localRelPaths: string[]) {
  await upsertBook(book, {
    sourceKind: 'imported',
    onDrive: false,
    // The files are already on the phone, so it is checked out by definition.
    localRelPaths,
  });
}
