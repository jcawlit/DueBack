/**
 * What the checked-out tray shows, and in what order.
 *
 * The tray was global once — what is on the phone is on the phone — and that
 * held while the drive was the only thing that could put a book there. With a
 * server it stopped holding, so the tray was scoped to the active source
 * instead: stand in a server's library and you saw only its downloads.
 *
 * That traded one wrong answer for another, and the second one cost real
 * storage. Remove a server and its downloaded books belonged to no source you
 * could switch to, so they appeared **nowhere** — still on the phone, still
 * taking gigabytes, with no screen offering to release them. Invisible
 * storage is worse than storage in the wrong place.
 *
 * So the tray shows everything again, in groups: the drive first, then each
 * server, then anything from a server that is no longer signed into. One view,
 * with the labels doing the work the scoping used to do badly.
 *
 * Nothing here knows about React. The rule is the thing worth pinning.
 */

import type { Book } from '@/data/types';

export type TrayGroup = {
  /** The source this group is, or `driveSourceId` for the drive. */
  id: string;
  label: string;
  books: Book[];
  /**
   * True when this group's books came from a server that is not signed into.
   *
   * They can be released and they can be played — the audio is on the phone —
   * but nothing can be fetched for them, so a screen must not offer to.
   */
  signedOut: boolean;
};

/**
 * Groups the books on the phone by where they came from.
 *
 * Empty groups are dropped, so a listener with no server sees exactly one
 * group and the tray looks as it always has.
 */
export function trayGroups(
  books: Book[],
  options: {
    driveSourceId: string;
    /** The servers currently signed into, in the order they should appear. */
    servers: { id: string; label: string }[];
    /** What to call the drive. */
    driveLabel?: string;
  },
): TrayGroup[] {
  const { driveSourceId, servers, driveLabel = 'Drive' } = options;
  const live = new Set(servers.map((s) => s.id));

  /*
   * Anything not on a shelf, which is what the tray has always shown: checked
   * out, on hold, or a copy in flight. `isCheckedOut` is narrower — it means
   * only the finished state — and using it here would drop a book on hold,
   * which is part of what somebody is taking with them even though no bytes
   * have moved, and a copy mid-flight, which is the one you are most likely
   * to be looking at.
   */
  const held = books.filter((b) => b.local.status !== 'on-shelf');

  const groups: TrayGroup[] = [
    {
      id: driveSourceId,
      label: driveLabel,
      // No source id means the drive, which is the implicit source and has no
      // row. An import is one of these: it is checked out from the moment it
      // exists, and belongs to no server.
      books: held.filter((b) => !b.sourceId),
      signedOut: false,
    },
    ...servers.map((server) => ({
      id: server.id,
      label: server.label,
      books: held.filter((b) => b.sourceId === server.id),
      signedOut: false,
    })),
    {
      /*
       * The group that exists because of the bug. A book whose source has
       * been removed keeps its `source_id` — that is its identity, not a link
       * to tidy up — so it matches no live server and would otherwise fall
       * out of every view while still occupying the phone.
       */
      id: 'signed-out',
      label: 'Signed out',
      books: held.filter((b) => b.sourceId !== undefined && !live.has(b.sourceId)),
      signedOut: true,
    },
  ];

  return groups.filter((group) => group.books.length > 0);
}

/** Every book the tray is showing, for the count and the storage ruler. */
export function trayBooks(groups: TrayGroup[]): Book[] {
  return groups.flatMap((group) => group.books);
}

/**
 * Whether the groups should be named on screen.
 *
 * Only when there is more than one. With a single group the heading and the
 * size already say everything, and naming the drive it came from would be
 * telling somebody where their only library is.
 *
 * The names used to be collected into one line beside the heading — "4 books
 * · 12.1 of 32 GB · 3 Drive · 1 Home" — which did not fit across a phone and
 * lost its end. They sit over their own covers instead, where the count is the
 * stack underneath them and does not need saying twice.
 */
export function showsGroupLabels(groups: TrayGroup[]): boolean {
  return groups.length > 1;
}
