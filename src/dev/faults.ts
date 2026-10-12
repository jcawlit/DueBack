/**
 * Fault injection for the on-device suites.
 *
 * Some failures cannot honestly be provoked on an emulator. Filling a userdata
 * image to within a gigabyte of full takes minutes, needs gigabytes of junk
 * written and deleted, and risks taking the test run down with it. These hooks
 * let a test say "the phone is nearly full" or "the write fails on part two"
 * and then exercise the real recovery path — the same staging folder is
 * deleted, the same book goes back on the shelf, the same message is shown.
 *
 * What is deliberately *not* faked is the recovery itself. Only the two facts
 * the filesystem reports are substituted; everything downstream is the
 * production code path.
 *
 * Inert unless a test sets something. No app code ever writes here.
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
