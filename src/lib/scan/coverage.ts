/**
 * What a scan actually looked at, and therefore what it can be evidence of.
 *
 * `markMissingExcept` works by marking every drive book missing and then
 * un-marking the ones the scan found. That is correct only where the scan
 * really looked: a book absent from the walk because its folder would not
 * list, because it sat deeper than the walk goes, or because reading it threw,
 * is a book nobody looked for — and "we did not look" is not "it has gone".
 *
 * Getting that wrong is quiet and then expensive. A wrongly-missing book keeps
 * its progress and its library-card history, so nothing is lost on the spot,
 * but Settings then offers to "Forget N missing books" — the most destructive
 * write in the app — and that offer looks perfectly reasonable.
 *
 * The protection here is deliberately **per folder** rather than per scan. The
 * obvious alternative is to treat any unreadable folder as making the whole
 * scan inconclusive, but a drive with one permanently unreadable folder — a
 * `System Volume Information`, a trashed folder, something with a broken
 * permission — would then never mark anything missing again, and books really
 * deleted would stay on the shelf forever. Narrowing it to the subtrees that
 * were not read keeps the answer right everywhere else.
 */

/**
 * A folder path as the walk and the database both spell it: relative to the
 * library root, `/`-separated, no leading or trailing slash. The root itself
 * is the empty string.
 */
export function normaliseFolder(path: string): string {
  return path.trim().replace(/^[./]+/, '').replace(/\/+$/, '');
}

/**
 * Whether `folder` is `subtree` or sits inside it.
 *
 * The `/` matters: `Hyperion` must not count as inside `Hyper`, which a plain
 * `startsWith` would say it was.
 */
export function isUnder(folder: string, subtree: string): boolean {
  const a = normaliseFolder(folder);
  const b = normaliseFolder(subtree);
  // The root contains everything, which is the unreadable-root case.
  if (b === '') return true;
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Whether a book in `folder` was somewhere this scan could not see.
 *
 * Takes the folders the walk reported as unseen, so a caller cannot forget to
 * normalise them.
 */
export function wasUnseen(folder: string | null | undefined, unseen: string[]): boolean {
  if (unseen.length === 0) return false;
  const where = normaliseFolder(folder ?? '');
  return unseen.some((subtree) => isUnder(where, subtree));
}

/**
 * Every folder a scan could not vouch for.
 *
 * `unseenFolders` is what the walk could not read or would not descend into.
 * `erroredFolders` is the groups that threw while being read: the files were
 * found, so the folder is not unseen, but the book never reached `seenIds` and
 * would be marked missing on the strength of a failure to parse it.
 */
export function unvouchedFolders(
  unseenFolders: string[],
  erroredFolders: string[],
): string[] {
  const all = [...unseenFolders, ...erroredFolders].map(normaliseFolder);
  return [...new Set(all)];
}
