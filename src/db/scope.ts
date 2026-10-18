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
