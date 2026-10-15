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

let listener: ((kind: ChangeKind) => void) | undefined;

export function onReadingDataChanged(callback: (kind: ChangeKind) => void) {
  listener = callback;
}

export function readingDataChanged(kind: ChangeKind = 'authored') {
  listener?.(kind);
}
