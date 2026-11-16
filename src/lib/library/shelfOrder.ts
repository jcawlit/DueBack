/**
 * Where a dragged thing lands, as a number.
 *
 * Shelf and book positions are REAL, not an index, so dropping a book between
 * two others is one write of the midpoint instead of renumbering everything
 * below it. On a shelf of a hundred books that is the difference between one
 * write and a hundred, on every drag.
 *
 * The cost is that midpoints halve the gap each time. A double has enough
 * precision for about fifty halvings of the same gap, which no hand will ever
 * reach — but "never" is not a thing to rely on silently, so `needsRenumber`
 * says when a shelf should be spread out again and the caller does it.
 */

/** A gap this small means the midpoints have run out of room. */
export const MIN_GAP = 1e-6;

/** The step between positions when a shelf is renumbered, or appended to. */
export const STEP = 1;

/**
 * A position between two neighbours.
 *
 * `null` for either side means the end of the list — dropped above the first
 * book, or below the last. Both null means the shelf was empty.
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - STEP;
  if (after === null) return before + STEP;
  return (before + after) / 2;
}

/**
 * Whether the gap these two neighbours leave is too small to split again.
 *
 * Checked before the write, not after: the caller renumbers the shelf and
 * then asks for the position again, so the position it stores is always one
 * with room on both sides of it.
 */
export function needsRenumber(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  return Math.abs(after - before) < MIN_GAP * 2;
}

/**
 * Evenly spread positions for a list that has been squeezed flat.
 *
 * Returns one position per item, in the order given, so a caller can write
 * them back against the ids it already has.
 */
export function renumbered(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i * STEP);
}

/**
 * Where an item moves to within its own list.
 *
 * `toIndex` is read against the list **with the dragged item removed**, which
 * is what a drop target means: "put it here, between these two". Working it
 * out against the original list makes dragging an item one place down a no-op,
 * because the slot it is dropped into is the one it already occupies.
 */
export function moveWithin<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  const at = Math.max(0, Math.min(next.length, toIndex));
  next.splice(at, 0, moved);
  return next;
}
