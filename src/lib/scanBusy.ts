/**
 * A flag saying a library scan is writing to the database.
 *
 * It lives in its own module rather than in either store because the scan
 * store already imports the library store, so the library store cannot import
 * it back without a cycle.
 *
 * The need for it is specific: plugging the drive in starts a re-sync scan and
 * flushes any holds from the same event, so a scan writing a few hundred rows
 * and a copy recording where it put its files were hitting SQLite at the same
 * moment. One of them lost every time.
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
