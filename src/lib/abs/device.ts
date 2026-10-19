/**
 * This installation's identity, as the server knows it.
 *
 * Audiobookshelf dedupes playback sessions per (user, device). Without a
 * stable `deviceId` every `/play` invents a new device, every session is a
 * new row, and nothing is ever cleaned up — the server accumulates one
 * phantom device per press of Play.
 *
 * One UUID, generated the first time it is needed and kept in SecureStore
 * beside the tokens. Not in SQLite: the database is copied to the drive by
 * the backup, and two phones restoring the same backup would then claim to
 * be the same device and silently close each other's sessions.
 */

import * as SecureStore from 'expo-secure-store';
import { newUuid } from '@/lib/library/ids';

const KEY = 'abs.deviceId';

let cached: string | null = null;

export async function absDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch (error) {
    console.warn('[abs] could not read the device id', error);
  }

  const made = newUuid();
  try {
    await SecureStore.setItemAsync(KEY, made, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    /*
     * A device id that cannot be stored is still better than none for the
     * life of this process: sessions opened now will at least dedupe
     * against each other. The next launch will try again.
     */
    console.warn('[abs] could not store the device id', error);
  }
  cached = made;
  return made;
}

/** For tests and "forget this server". */
export async function forgetDeviceId(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Nothing to do.
  }
}
