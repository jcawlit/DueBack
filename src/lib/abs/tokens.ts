/**
 * Where the server tokens live, which is not the database.
 *
 * SQLite here is a plain file inside the app's sandbox and is copied to the
 * drive by the backup. A token in it would be a token on a USB stick. These
 * go to SecureStore instead, which on Android is backed by the keystore, and
 * are keyed by the source's id so removing a source removes its credentials.
 *
 * The password never arrives here at all. It is a parameter to `login` and
 * nothing else — there is deliberately no function in this file to store one,
 * because a stored password is a thing a background retry could spend.
 */

import * as SecureStore from 'expo-secure-store';
import type { AbsTokens } from './client';

/**
 * SecureStore keys may only contain letters, digits, dot, dash and
 * underscore. Source ids are uuids, so the prefix is the whole of the
 * formatting — but a stray id would fail the write silently enough to be
 * worth refusing here.
 */
function keyFor(sourceId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sourceId)) {
    throw new Error(`[abs] source id is not usable as a SecureStore key: ${sourceId}`);
  }
  return `abs.tokens.${sourceId}`;
}

export async function saveTokens(sourceId: string, tokens: AbsTokens): Promise<void> {
  await SecureStore.setItemAsync(keyFor(sourceId), JSON.stringify(tokens), {
    // The default already requires the device to be unlocked once since
    // boot; naming it keeps the next reader from wondering.
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadTokens(sourceId: string): Promise<AbsTokens | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(keyFor(sourceId));
  } catch (error) {
    // A keystore that cannot be read is the same as no token: the person
    // signs in again. Worth a line in the log, not a crash.
    console.warn(`[abs] could not read the token for ${sourceId}`, error);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AbsTokens;
    return parsed.accessToken ? parsed : null;
  } catch {
    console.warn(`[abs] stored token for ${sourceId} was unreadable`);
    return null;
  }
}

export async function forgetTokens(sourceId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyFor(sourceId));
  } catch (error) {
    console.warn(`[abs] could not clear the token for ${sourceId}`, error);
  }
}

/** An API key is a standing credential, so it lives beside the tokens. */
export async function saveApiKey(sourceId: string, apiKey: string): Promise<void> {
  await saveTokens(sourceId, { accessToken: apiKey });
}
