/**
 * What went wrong, in words rather than in numbers.
 *
 * One mapper for every surface — connecting, reading the catalogue,
 * downloading, streaming — so the same fault reads the same way wherever
 * it happens, and says what to do about it rather than what the server
 * said. The status code stays on the error for the log; it never reaches
 * the screen. "The server answered 403" tells somebody holding a phone
 * nothing they can act on.
 *
 * Pure, so every sentence in the app can be tested without a server.
 */

import { AbsError } from './client.ts';

/** Where the failure happened, which changes what the advice should be. */
export type AbsContext = 'connect' | 'catalogue' | 'checkout' | 'stream' | 'cover';

const WHAT: Record<AbsContext, string> = {
  connect: 'Could not reach that server',
  catalogue: 'Could not read the library',
  checkout: 'Could not download this book',
  stream: 'Could not play this book from the server',
  cover: 'Could not fetch the cover',
};

/**
 * The lowest server this app knows how to talk to.
 *
 * Reasoned from the endpoints it depends on rather than tested against an
 * old server — nobody here has one. The playback session API
 * (`/api/items/:id/play`, `/api/session/:id/sync`) is the oldest thing in
 * the list and arrived in 2.0.
 */
export const MIN_SERVER_VERSION = '2.0.0';

/**
 * The version that introduced the access/refresh token pair.
 *
 * Older servers issue one long-lived token and no way to renew it, which
 * works — the client reads whichever it is given — but means signing in
 * again whenever that token finally expires. Worth saying once, at
 * connect, rather than leaving as a mystery later.
 */
export const MIN_REFRESH_VERSION = '2.26.0';

/** -1, 0 or 1. Anything unparseable sorts as equal, so it never blocks. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.trim().replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * What to say about a server's version at connect time, or null if there
 * is nothing worth saying.
 *
 * An unknown version says nothing. A server that will not tell us its
 * version is far more likely to be a proxy in the way than a problem, and
 * refusing on silence would turn a working setup into a dead end.
 */
export function describeServerVersion(version: string | undefined): {
  tone: 'bad' | 'warn';
  text: string;
} | null {
  if (!version) return null;

  if (compareVersions(version, MIN_SERVER_VERSION) < 0) {
    return {
      tone: 'bad',
      text:
        `This server is running version ${version}, which is older than this app ` +
        'can talk to. Audiobookshelf needs to be upgraded before the library ' +
        'can be used here.',
    };
  }
  if (compareVersions(version, MIN_REFRESH_VERSION) < 0) {
    return {
      tone: 'warn',
      text:
        `This server is running version ${version}. It works, but it predates ` +
        'renewable sign-ins, so you will be asked to sign in again from time to ' +
        'time. Upgrading the server stops that.',
    };
  }
  return null;
}

/**
 * The one sentence to show somebody when a call to their server failed.
 *
 * Never includes a status code, and never passes the server's own words
 * through: both are developer information, and both are already in the
 * log via `console.warn` at the point of failure.
 */
export function describeAbsError(error: unknown, context: AbsContext): string {
  const what = WHAT[context];

  if (error instanceof AbsError) {
    switch (error.kind) {
      case 'unreachable':
        return (
          `${what}. Check the address, and that the phone is on the same ` +
          'network as the server.'
        );
      case 'insecure':
        // The client's own message already says what to do about it, and
        // repeating `what` in front of it adds nothing a reader needs.
        return error.message;
      case 'auth':
        return `${what} — the sign-in has expired. Sign in again in Settings.`;
      case 'forbidden':
        /*
         * 403 means signed in and refused, which on Audiobookshelf is
         * nearly always the download permission. Saying who can fix it
         * matters: the listener cannot, and will otherwise keep trying.
         */
        return context === 'checkout'
          ? 'This account is not allowed to download books from the server. An ' +
              'administrator has to turn the download permission on.'
          : `${what} — this account is not allowed to. An administrator has to ` +
              'change its permissions.';
      case 'server':
      default:
        return `${what}. The server answered in a way this app did not expect.`;
    }
  }

  // Not one of ours: a bug, a native failure, something thrown by a
  // library. Still no stack traces on screen.
  return `${what}. Something went wrong on this phone.`;
}

/** True when the right answer is to send somebody to sign in again. */
export function needsSignIn(error: unknown): boolean {
  return error instanceof AbsError && error.kind === 'auth';
}
