/** Decouples database writes from the backup store. Fires only after a successful write. */
let listener: (() => void) | undefined;
export function onReadingDataChanged(callback: () => void) { listener = callback; }
export function readingDataChanged() { listener?.(); }
