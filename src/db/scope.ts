/**
 * Which books a given piece of housekeeping is allowed to speak for.
 *
 * Its own file, with no imports, so that a test can hold the real predicate
 * rather than a copy of it — everything else in `src/db/` reaches
 * `expo-sqlite` and cannot be loaded off-device.
 */

/**
 * Books on the USB drive, which is the implicit source and has no row.
 *
 * A drive scan walked a drive. That is evidence about the drive and about
 * nothing else, so every query that acts on "what the scan found" has to say
 * so — a scan that marked a server's books missing had "Forget missing
 * books" offering to delete a library it had never looked at.
 */
export const DRIVE_BOOKS = 'source_id IS NULL';

/**
 * Drive books with nothing of themselves on the phone: an index entry, and
 * no audio.
 *
 * The distinction a root switch turns on. A book whose parts carry a
 * `local_rel_path` plays with no drive attached at all, so a different drive
 * is no reason to take it away. A book without one is a row describing a
 * folder somewhere else, and after a switch that folder is not in this
 * library any more.
 *
 * Imports never pushed to a drive are excluded outright rather than left to
 * the parts check: their audio is on the phone by definition and they belong
 * to no drive, so no drive's departure can speak for them.
 */
export const PLACEHOLDER_DRIVE_BOOKS =
  `${DRIVE_BOOKS}
     AND NOT (COALESCE(source_kind, 'library') = 'imported' AND COALESCE(on_drive, 1) = 0)
     AND NOT EXISTS (
       SELECT 1 FROM parts
        WHERE parts.book_id = books.id AND parts.local_rel_path IS NOT NULL
     )`;
