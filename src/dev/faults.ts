/**
 * Hooks for pretending the phone is nearly full, or that a write fails.
 *
 * Written for the on-device suites, which have since been removed. The
 * setters now have no callers; the two readers are still wired into the real
 * code — `diskFault()` in `src/lib/files/copy.ts` and
 * `libraryOnDeviceOverride()` in `src/store/library.ts` — and both return
 * "nothing set", so the app asks the filesystem and behaves normally.
 *
 * It is kept rather than torn out because removing it means editing the copy
 * path and the library store to no end. If a way to provoke a full disk is
 * ever wanted again, this is where it goes.
 */

export type DiskFault = {
  /** Reported as the phone's free space instead of asking the filesystem. */
  freeBytes?: number;
  /**
   * Writing this part index throws, as a disk filling mid-copy does. Zero
   * based, so `0` fails the first part.
   */
  failWriteAtPart?: number;
};

let disk: DiskFault = {};

export function setDiskFault(next: DiskFault) {
  disk = next;
}

export function clearDiskFaults() {
  disk = {};
}

export function diskFault(): Readonly<DiskFault> {
  return disk;
}

/** The message a full Android filesystem actually produces. */
export const ENOSPC_MESSAGE = 'ENOSPC: No space left on device, write';

/**
 * Forces the library to be treated as on a drive, or on the phone.
 *
 * The suites run against a root inside the app's own storage, because that is
 * the only place a script can write fixtures — which means `isDeviceStorage`
 * reports the library as phone-local, and the check-out, hold, return and
 * budget suites would all be refused by a rule meant for a different mode.
 * This lets a test say which mode it is exercising instead of inheriting one
 * from where the fixtures happen to live.
 *
 * `undefined` means "ask the real root", which is what the app always does.
 */
let onDeviceOverride: boolean | undefined;

export function setLibraryOnDeviceOverride(value: boolean | undefined) {
  onDeviceOverride = value;
}

export function libraryOnDeviceOverride(): boolean | undefined {
  return onDeviceOverride;
}
