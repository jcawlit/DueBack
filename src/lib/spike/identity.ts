/**
 * SPIKE — throwaway, with the rest of `src/lib/spike/`.
 *
 * The one piece of the Drive probe that is pure reasoning rather than a
 * measurement, split out so it can be tested without loading the file
 * system and the SAF layer behind it.
 */

/**
 * Whether two listings of the same folder describe the same books.
 *
 * Question (f) of the spike: is a cloud folder's identity as stable as a
 * drive's? Compared as a set, not a sequence — a provider is under no
 * obligation to list twice in the same order, and treating that as
 * instability would condemn Drive for nothing. What would matter is a
 * book arriving under a different identity, because to the scanner that
 * reads as the old one having gone and a new one having appeared.
 */
export function sameBooks(a: string[], b: string[]): { same: boolean; detail: string } {
  if (a.length !== b.length) {
    return { same: false, detail: `${a.length} books, then ${b.length}` };
  }
  const missing = a.filter((key) => !b.includes(key));
  const added = b.filter((key) => !a.includes(key));
  if (missing.length === 0 && added.length === 0) {
    return { same: true, detail: `${a.length} books, same identities both times` };
  }
  return {
    same: false,
    detail: `${missing.length} vanished, ${added.length} appeared — identity is not stable`,
  };
}
