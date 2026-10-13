/**
 * A flag saying a library scan is writing to the database, so that a copy can
 * wait for it: plugging the drive in starts a re-sync scan and flushes holds
 * from the same event, and the two were reaching SQLite together.
 *
 * Its own module because the scan store already imports the library store,
 * which could not import it back without a cycle.
 */

let scanning = false;

export function setScanning(value: boolean) {
  scanning = value;
}

export function isScanning(): boolean {
  return scanning;
}

/**
 * Waits for any running scan to finish.
 *
 * Bounded: a scan that somehow never clears the flag must not wedge a copy for
 * ever. Going ahead anyway is survivable — the busy timeout absorbs a short
 * overlap — whereas waiting indefinitely is not.
 */
export async function waitForScanToFinish(timeoutMs = 300000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (scanning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
