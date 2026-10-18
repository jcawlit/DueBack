/**
 * Which position wins when a phone and a server disagree.
 *
 * Pure, and in its own file so it can be tested without a database or a
 * server — the rule is the valuable part, and reaching it should not mean
 * loading expo-sqlite.
 *
 * The position is always `currentTime`. Audiobookshelf computes its own
 * `progress` fraction and ignores the one a client sends, which Step 0
 * proved against 2.37.1, so treating that fraction as a position would be
 * reading back a number we never wrote.
 */

export type ServerPlace = { currentTime: number; lastUpdate: number };
export type LocalPlace = { positionSec: number; updatedAt: string | null };

/**
 * The newer write wins.
 *
 * "No local stamp" means this phone has never recorded a position for this
 * book, so anything the server holds is newer by definition. An equal stamp
 * keeps the local position: the two are the same moment, and preferring the
 * server there would make every comparison a round trip that changes
 * nothing.
 */
export function chooseProgress(
  server: ServerPlace | null,
  local: LocalPlace | null,
): { take: 'server' | 'local'; positionSec: number } {
  if (!server) return { take: 'local', positionSec: local?.positionSec ?? 0 };
  if (!local || !local.updatedAt) return { take: 'server', positionSec: server.currentTime };

  const localMs = Date.parse(local.updatedAt);
  // An unparseable stamp is not evidence of being newer.
  if (!Number.isFinite(localMs) || server.lastUpdate > localMs) {
    return { take: 'server', positionSec: server.currentTime };
  }
  return { take: 'local', positionSec: local.positionSec };
}
