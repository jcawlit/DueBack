/**
 * Telling the backup that something worth copying has changed.
 *
 * A callback rather than an import, so `src/db/*` never has to know the
 * backup store exists. Fires only after a write has actually succeeded.
 *
 * The kind matters, and getting it wrong is expensive. A **progress** write
 * happens every five seconds for as long as a book is playing; an
 * **authored** one happens when somebody writes a note, adds a character or
 * returns a book. Treating them alike meant a full read-merge-write-validate
 * cycle on the USB drive every few seconds of listening.
 */

export type ChangeKind = 'authored' | 'progress';

/*
 * A set, not a single callback. There are two listeners now — the drive
 * backup and the push of progress to an Audiobookshelf server — and the
 * single-slot version silently replaced one with the other depending on
 * which module happened to be imported second.
 */
const listeners = new Set<(kind: ChangeKind, bookId?: string) => void>();

/**
 * Registers a listener. The returned function removes it again.
 *
 * `bookId` is present on a progress change and says which book moved. The
 * backup does not care — it copies everything — but pushing a position to a
 * server does, and guessing it from whatever is playing would be wrong the
 * moment anything else writes progress.
 */
export function onReadingDataChanged(
  callback: (kind: ChangeKind, bookId?: string) => void,
): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function readingDataChanged(kind: ChangeKind = 'authored', bookId?: string) {
  for (const listener of listeners) {
    try {
      listener(kind, bookId);
    } catch (error) {
      // One listener failing must not stop the others being told.
      console.warn('[dueback] a reading-data listener threw', error);
    }
  }
}
