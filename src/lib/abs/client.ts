/**
 * Talking to an Audiobookshelf server.
 *
 * Pure HTTP and nothing else: no storage, no React, no SecureStore. The
 * caller supplies the credentials and is told when they change, which is what
 * makes this testable against a mocked `fetch` and what keeps the one place
 * that touches secrets (`tokens.ts`) separate from the one that spends them.
 *
 * Two authentication eras have to work at once. Before 2.26 a login returned
 * a single long-lived `token`; from 2.26 it returns an `accessToken` that
 * expires and a `refreshToken` that renews it. Sending `x-return-tokens: true`
 * asks the newer server to put both in the body rather than setting an
 * http-only cookie, which a native client cannot read. The legacy `token` is
 * still present as of 2.37 and still accepted, so a client that reads
 * whichever is there works against both.
 *
 * An API key is the third way in, and the simplest: a bearer token that does
 * not expire and therefore never refreshes.
 */

/** How a request failed, in the only ways a caller can act on. */
export type AbsErrorKind =
  /** Nothing answered: wrong address, server down, no route, cleartext blocked. */
  | 'unreachable'
  /** Refused before it was sent: plain http to an address off the local network. */
  | 'insecure'
  /** 401. The credentials are wrong or have expired past renewing. */
  | 'auth'
  /** 403. Signed in, but not allowed — a user without download permission. */
  | 'forbidden'
  /** Answered, but not with anything this client can use. */
  | 'server';

export class AbsError extends Error {
  readonly kind: AbsErrorKind;
  readonly status?: number;

  constructor(kind: AbsErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AbsError';
    this.kind = kind;
    this.status = status;
  }
}

export type AbsTokens = {
  accessToken: string;
  /** Absent on a legacy server, which issues one token and never renews it. */
  refreshToken?: string;
};

/** Either a signed-in session or a standing API key. */
export type AbsAuth =
  | { kind: 'tokens'; tokens: AbsTokens }
  | { kind: 'apiKey'; apiKey: string };

export type AbsUser = {
  id: string;
  username: string;
  /** 'root', 'admin', 'user' or 'guest'. */
  type: string;
  /** Absent on a server that does not report permissions for this route. */
  canDownload?: boolean;
};

export type AbsSession = {
  tokens: AbsTokens;
  user: AbsUser;
  /** Whatever version the payload admitted to, if any did. */
  serverVersion?: string;
};

/** One playable stream the server has offered for this session. */
export type AbsAudioTrack = {
  index: number;
  /** Where this track begins on the whole-book timeline, in seconds. */
  startSec: number;
  durationSec: number;
  /** Absolute, built from the server address and the relative path given. */
  url: string;
  mimeType: string;
};

/**
 * How the server decided to serve the audio.
 *
 * 0 and 1 hand over the files themselves, which play with an Authorization
 * header like everything else. 2 is a transcode, served as HLS from an
 * unguessable session URL — the one address in the system that carries no
 * credential, because the session id is itself the secret.
 */
export type AbsPlayMethod = 0 | 1 | 2 | 3;

export type AbsSessionInfo = {
  id: string;
  playMethod: AbsPlayMethod;
  tracks: AbsAudioTrack[];
  /** Seconds. What the server believes the whole book runs to. */
  durationSec: number;
  /** Where the server started this session from. */
  startedAtSec: number;
};

export type AbsLibrary = {
  id: string;
  name: string;
  mediaType: string;
};

/**
 * The address of one audio file.
 *
 * Per file, and never `GET /api/items/:id/download` — that endpoint returns
 * a ZIP of the whole item, which cannot be resumed, cannot be played until
 * it is complete, and would have to be unpacked.
 *
 * No token in it. Audiobookshelf accepts `?token=`, and this app never uses
 * it: a URL carrying a credential ends up in logs and crash reports.
 * Authorization is a header, here as everywhere.
 */
export function fileDownloadUrl(serverUrl: string, itemId: string, ino: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/items/${encodeURIComponent(itemId)}` +
    `/file/${encodeURIComponent(ino)}/download`;
}

/**
 * A file's ino no longer resolves.
 *
 * Its own type because the answer is specific: re-read the expanded item
 * and try once more. An ino is the server's inode number and changes
 * whenever a file is rewritten or the library is rescanned, so this is a
 * routine event rather than a fault.
 */
export class StaleInoError extends Error {
  readonly partIndex: number;
  constructor(partIndex: number, name: string) {
    super(`${name} is no longer where the server said it was.`);
    this.name = 'StaleInoError';
    this.partIndex = partIndex;
  }
}

/** How long to wait before calling a server unreachable. */
const TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------- the URL

/**
 * Tidies what somebody typed into something fetchable.
 *
 * A bare `192.168.1.90:13378` is what a person writes down, and it is not a
 * URL — `new URL` rejects it outright. Assuming http for a scheme-less
 * address is right for the only case that produces one, which is a server on
 * the local network.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Whether an address sends a password across a network anyone could be on.
 *
 * Plain http to a box on your own LAN is the normal way to run this server
 * and not worth nagging about. Plain http to a public address puts the
 * password on the wire in clear, which is worth one line of warning.
 */
export function isCleartextToPublicHost(input: string): boolean {
  const url = normalizeServerUrl(input);
  if (!/^http:\/\//i.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Names, not numbers: a .local or a bare hostname is a LAN convention.
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')) return false;
  if (host === '::1' || host.startsWith('[::1]')) return false;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // Not an IPv4 literal. A bare hostname with no dots is a LAN name; a
    // dotted public name is not.
    return host.includes('.');
  }
  const [a, b] = host.split('.').map(Number);
  if (a === 10 || a === 127) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 169.254/16 is link-local, which is as local as it gets.
  if (a === 169 && b === 254) return false;
  return true;
}

// ------------------------------------------------------------- requesting

type Fetcher = typeof fetch;

async function request(
  fetchImpl: Fetcher,
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  /*
   * Refused here rather than warned about in the form.
   *
   * This is the one place every call passes through — signing in, listing a
   * library, fetching covers, streaming, reporting a position — so a server
   * saved before this check existed, or reached by a path that never saw the
   * form, cannot put a password on the open internet in clear either.
   *
   * Android's manifest cannot express this. `usesCleartextTraffic` is all or
   * nothing, and a network security config takes hostnames and IP literals,
   * not address ranges, so "http only on a private network" is not something
   * the platform can be told when the address is typed in by the listener.
   * It has to be enforced here.
   */
  if (isCleartextToPublicHost(url)) {
    throw new AbsError(
      'insecure',
      'That is a plain http address outside your own network. The password and ' +
        'everything after it would travel unencrypted, so the request was not sent. ' +
        'Use https, or reach the server over your own network.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Every transport failure arrives here as one indistinguishable TypeError:
    // DNS, refused connection, a timeout, and Android refusing cleartext all
    // look the same. "Unreachable" is the only honest word for the set.
    throw new AbsError('unreachable', describeTransportFailure(error));
  } finally {
    clearTimeout(timer);
  }
}

function describeTransportFailure(error: unknown): string {
  // Not `instanceof Error`: an abort arrives as a DOMException, which is not
  // reliably an Error across the runtimes this has to work on.
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'The server did not answer in time.';
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Could not reach the server. ${message}`;
}

/** Turns a non-ok response into the right kind of AbsError. */
async function fail(response: Response, what: string): Promise<never> {
  if (response.status === 401) {
    throw new AbsError('auth', `${what}: the server did not accept those credentials.`, 401);
  }
  if (response.status === 403) {
    throw new AbsError('forbidden', `${what}: this account is not allowed to do that.`, 403);
  }
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // The status alone will have to do.
  }
  throw new AbsError(
    'server',
    `${what}: the server answered ${response.status}.${detail ? ` ${detail}` : ''}`,
    response.status,
  );
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AbsError('server', `${what}: the server's answer was not JSON.`);
  }
}

// ----------------------------------------------------------------- shapes

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Pulls the tokens out of a login or refresh payload, whichever era it is.
 *
 * `accessToken` first: on a 2.26+ server both are present and the legacy
 * `token` is the one being retired.
 */
function readTokens(body: Record<string, unknown>): AbsTokens | null {
  const user = obj(body.user);
  const accessToken =
    str(user.accessToken) ?? str(body.accessToken) ?? str(user.token) ?? str(body.token);
  if (!accessToken) return null;
  const refreshToken = str(user.refreshToken) ?? str(body.refreshToken);
  return refreshToken ? { accessToken, refreshToken } : { accessToken };
}

function readUser(body: Record<string, unknown>): AbsUser {
  const user = obj(body.user);
  const permissions = obj(user.permissions);
  return {
    id: str(user.id) ?? '',
    username: str(user.username) ?? '',
    type: str(user.type) ?? 'user',
    canDownload:
      typeof permissions.download === 'boolean' ? (permissions.download as boolean) : undefined,
  };
}

/**
 * The server version, from wherever this particular payload keeps it.
 *
 * `/status` is the reliable source, but login and authorize both carry it in
 * one nesting or another depending on the version, and using them saves a
 * round trip on the screen that most wants to show it.
 */
function readVersion(body: Record<string, unknown>): string | undefined {
  return (
    str(body.serverVersion) ??
    str(obj(body.serverSettings).version) ??
    str(obj(body.Source).version) ??
    str(body.version)
  );
}

// ------------------------------------------------------------------ calls

/**
 * The server's version and whether it has been set up.
 *
 * Unauthenticated, and the one call that works before any credentials exist,
 * which makes it the right thing behind "Test connection".
 *
 * `/status` is the route on 2.37.1 — `/api/status` 404s there, which the
 * Docker harness in tools/abs-test established. Other versions are reported
 * to have it the other way round, so both are tried and the first that
 * answers wins.
 */
export async function status(
  serverUrl: string,
  fetchImpl: Fetcher = fetch,
): Promise<{ version?: string; isInit?: boolean; path: string }> {
  const base = normalizeServerUrl(serverUrl);
  let lastError: AbsError | null = null;
  for (const path of ['/status', '/api/status']) {
    // Deliberately uncaught: a server that is not there is not there on
    // either path, so a transport failure ends the search rather than
    // spending a second timeout proving the same thing twice.
    const response = await request(fetchImpl, `${base}${path}`, { method: 'GET' });
    if (!response.ok) {
      lastError = new AbsError(
        'server',
        `Status: the server answered ${response.status} at ${path}.`,
        response.status,
      );
      continue;
    }
    const body = await readJson(response, 'Status');
    return {
      version: readVersion(body),
      isInit: typeof body.isInit === 'boolean' ? (body.isInit as boolean) : undefined,
      path,
    };
  }
  throw lastError ?? new AbsError('server', 'Status: the server has no status route.');
}

/**
 * Signs in with a username and password.
 *
 * The password is a parameter and never becomes anything else — not a field,
 * not a stored value, not part of the returned session. It exists for the
 * length of this call.
 */
export async function login(
  serverUrl: string,
  username: string,
  password: string,
  fetchImpl: Fetcher = fetch,
): Promise<AbsSession> {
  const base = normalizeServerUrl(serverUrl);
  const response = await request(fetchImpl, `${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ask a 2.26+ server for the refresh token in the body. Without it the
      // token comes back as an http-only cookie that a native client cannot
      // read, and the session silently cannot be renewed.
      'x-return-tokens': 'true',
    },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) await fail(response, 'Sign in');

  const body = await readJson(response, 'Sign in');
  const tokens = readTokens(body);
  if (!tokens) {
    throw new AbsError('server', 'Sign in: the server returned no token.');
  }
  return { tokens, user: readUser(body), serverVersion: readVersion(body) };
}

/**
 * Exchanges a refresh token for a fresh pair.
 *
 * Separate from the client so a caller can renew without owning one, and so
 * the failure is visible rather than buried in a retry.
 */
export async function refresh(
  serverUrl: string,
  refreshToken: string,
  fetchImpl: Fetcher = fetch,
): Promise<AbsTokens> {
  const base = normalizeServerUrl(serverUrl);
  const response = await request(fetchImpl, `${base}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-refresh-token': refreshToken,
      'x-return-tokens': 'true',
    },
  });
  if (!response.ok) await fail(response, 'Renew the session');

  const body = await readJson(response, 'Renew the session');
  const tokens = readTokens(body);
  if (!tokens) throw new AbsError('auth', 'Renew the session: no new token came back.', 401);
  // A server that renews the access token without reissuing the refresh one
  // expects the old refresh token to keep working.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
}

// ----------------------------------------------------------------- client

export type ClientOptions = {
  serverUrl: string;
  auth: AbsAuth;
  /** Persist these. Called after every successful renewal. */
  onTokens?: (tokens: AbsTokens) => void | Promise<void>;
  /**
   * Called once, when renewal has failed and only a sign-in will fix it.
   * The source is marked "Sign in again" from here; nothing retries.
   */
  onSignInRequired?: () => void | Promise<void>;
  fetch?: Fetcher;
};

/** One book as the catalogue lists it. Raw JSON — mapping lives in map.ts. */
export type AbsItemJson = Record<string, unknown>;

/** What the server knows about where a listener is in a book. */
export type AbsProgress = {
  /** Seconds. The position, and the only field a client owns. */
  currentTime: number;
  /** The server's clock, in milliseconds, for deciding which side is newer. */
  lastUpdate: number;
  isFinished: boolean;
  duration: number;
};

export type AbsClient = {
  authorize(): Promise<AbsSession>;
  libraries(): Promise<AbsLibrary[]>;
  /**
   * Every book in a library, a page at a time. Minified, because the
   * catalogue needs the flattened fields and nothing else — the expanded
   * record is hundreds of times the size and is fetched per book, on open.
   */
  libraryItems(libraryId: string): Promise<AbsItemJson[]>;
  /** One book, expanded: chapters, tracks, the structured metadata. */
  item(itemId: string): Promise<AbsItemJson>;
  /** Cover bytes, fetched with the Authorization header like everything else. */
  cover(itemId: string, width?: number): Promise<Uint8Array>;
  /** Where the server thinks the listener is, or null if it has no record. */
  progress(itemId: string): Promise<AbsProgress | null>;
  /** Tells the server where the listener now is. */
  pushProgress(
    itemId: string,
    place: { currentTime: number; duration: number; isFinished: boolean },
  ): Promise<void>;

  /** Opens a playback session for streaming. */
  openSession(itemId: string, deviceId: string): Promise<AbsSessionInfo>;
  /**
   * Reports listening against an open session.
   *
   * `timeListened` is a **delta** in seconds since the last successful
   * sync, not a running total — the server adds it up across every session
   * row it holds. `currentTime` is absolute and is written straight into
   * the listener's progress.
   *
   * Resolves false when the session has gone (404), which the caller
   * answers by opening a new one rather than by failing.
   */
  syncSession(
    sessionId: string,
    body: { currentTime: number; timeListened: number; duration: number },
  ): Promise<boolean>;
  /** Ends a session, carrying one final sync in the same request. */
  closeSession(
    sessionId: string,
    body: { currentTime: number; timeListened: number; duration: number },
  ): Promise<void>;
  /** The tokens as they now stand, after any renewal. */
  currentAuth(): AbsAuth;
};

/** Books per request. Large enough that a real library is a few round trips. */
const PAGE_SIZE = 100;

/** Pages to read before giving up, in case a server never stops paging. */
const MAX_PAGES = 200;

/**
 * A connection to one server, which renews its own session exactly once per
 * request and gives up loudly.
 *
 * The giving up is the point. There is no stored password to fall back on by
 * design, so a failed renewal cannot be recovered from in the background —
 * and a client that keeps trying against a server that keeps refusing is how
 * an account ends up locked. One attempt, then the source is marked and the
 * person is asked.
 */
export function createClient(options: ClientOptions): AbsClient {
  const base = normalizeServerUrl(options.serverUrl);
  const fetchImpl = options.fetch ?? fetch;
  let auth = options.auth;
  /** Set once renewal has failed, so nothing tries again this session. */
  let signInRequired = false;
  /** One renewal in flight at a time, shared by whatever is waiting on it. */
  let renewing: Promise<AbsTokens> | null = null;

  const bearer = () => (auth.kind === 'apiKey' ? auth.apiKey : auth.tokens.accessToken);

  async function renew(): Promise<AbsTokens> {
    if (auth.kind !== 'tokens' || !auth.tokens.refreshToken) {
      // An API key does not expire and a legacy token cannot be renewed, so a
      // 401 on either is final.
      throw new AbsError('auth', 'The session has expired. Sign in again.', 401);
    }
    const token = auth.tokens.refreshToken;
    renewing ??= refresh(base, token, fetchImpl);
    try {
      const next = await renewing;
      auth = { kind: 'tokens', tokens: next };
      await options.onTokens?.(next);
      return next;
    } finally {
      renewing = null;
    }
  }

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const call = () =>
      request(fetchImpl, `${base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer()}` },
      });

    const first = await call();
    if (first.status !== 401 || signInRequired) return first;

    try {
      await renew();
    } catch (error) {
      signInRequired = true;
      await options.onSignInRequired?.();
      throw error instanceof AbsError
        ? new AbsError('auth', 'The session could not be renewed. Sign in again.', 401)
        : error;
    }
    return call();
  }

  return {
    async authorize() {
      const response = await send('/api/authorize', { method: 'POST' });
      if (!response.ok) await fail(response, 'Check the session');
      const body = await readJson(response, 'Check the session');
      // Authorize reissues tokens on some versions and not others; keep what
      // came back when it did, and what we already had when it did not.
      const tokens = readTokens(body) ?? (auth.kind === 'tokens' ? auth.tokens : { accessToken: bearer() });
      return { tokens, user: readUser(body), serverVersion: readVersion(body) };
    },

    async libraries() {
      const response = await send('/api/libraries', { method: 'GET' });
      if (!response.ok) await fail(response, 'List the libraries');
      const body = await readJson(response, 'List the libraries');
      const raw = Array.isArray(body.libraries) ? body.libraries : [];
      return (
        raw
          .map((entry) => {
            const library = obj(entry);
            return {
              id: str(library.id) ?? '',
              name: str(library.name) ?? '',
              mediaType: str(library.mediaType) ?? '',
            };
          })
          .filter((library) => library.id !== '')
          /*
           * Books only. A podcast library is a real thing on a real server
           * and this app has nowhere to put one — offering it would be
           * offering a choice that cannot work.
           */
          .filter((library) => library.mediaType === 'book')
      );
    },

    async libraryItems(libraryId) {
      const items: AbsItemJson[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await send(
          `/api/libraries/${encodeURIComponent(libraryId)}/items` +
            `?limit=${PAGE_SIZE}&page=${page}&minified=1`,
          { method: 'GET' },
        );
        if (!response.ok) await fail(response, 'Read the library');
        const body = await readJson(response, 'Read the library');
        const results = Array.isArray(body.results) ? (body.results as AbsItemJson[]) : [];
        items.push(...results);
        /*
         * Stop on a short page rather than on a running total reaching
         * `total`. The total is counted per request, so a book added while
         * the catalogue is being read makes the two disagree for ever and
         * the loop never ends.
         */
        if (results.length < PAGE_SIZE) return items;
      }
      console.warn(`[abs] stopped reading ${libraryId} after ${MAX_PAGES} pages`);
      return items;
    },

    async item(itemId) {
      const response = await send(`/api/items/${encodeURIComponent(itemId)}?expanded=1`, {
        method: 'GET',
      });
      if (!response.ok) await fail(response, 'Read the book');
      return readJson(response, 'Read the book');
    },

    async cover(itemId, width = 400) {
      /*
       * Through `send`, which means the Authorization header — not the
       * `?token=` the server also accepts. A URL with a token in it ends up
       * in logs, in crash reports and in the image cache's key, and an
       * <Image source={{uri}}> cannot carry a header anyway. So the bytes
       * are fetched here and written to the local cover cache, and the UI
       * only ever points at a local file.
       */
      const response = await send(
        `/api/items/${encodeURIComponent(itemId)}/cover?width=${width}`,
        { method: 'GET' },
      );
      if (!response.ok) await fail(response, 'Fetch the cover');
      return new Uint8Array(await response.arrayBuffer());
    },

    async progress(itemId) {
      const response = await send(`/api/me/progress/${encodeURIComponent(itemId)}`, {
        method: 'GET',
      });
      // No record is the normal answer for a book nobody has opened.
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'Read the saved place');
      const body = await readJson(response, 'Read the saved place');
      const currentTime = Number(body.currentTime);
      const lastUpdate = Number(body.lastUpdate);
      if (!Number.isFinite(currentTime) || !Number.isFinite(lastUpdate)) return null;
      return {
        currentTime,
        lastUpdate,
        isFinished: body.isFinished === true,
        duration: Number.isFinite(Number(body.duration)) ? Number(body.duration) : 0,
      };
    },

    async pushProgress(itemId, place) {
      /*
       * Three fields, and deliberately not a fourth.
       *
       * Step 0 proved against 2.37.1 that the server stores `currentTime`
       * and `isFinished` from a PATCH and ignores `progress` entirely —
       * sending it, sending it alone, or sending none of it all leave the
       * stored fraction where the last playback session put it. That
       * fraction is the server's own bookkeeping. Sending it anyway would
       * read as though we expected it to land.
       *
       * `isFinished` goes honestly. The server also decides for itself that
       * a book is finished when little enough is left, setting `finishedAt`
       * with it, and there is nothing to be gained by arguing with that.
       */
      const response = await send(`/api/me/progress/${encodeURIComponent(itemId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentTime: place.currentTime,
          duration: place.duration,
          isFinished: place.isFinished,
        }),
      });
      if (!response.ok) await fail(response, 'Save the place');
    },

    async openSession(itemId, deviceId) {
      /*
       * `deviceId` is not optional in practice. Sessions dedupe per (user,
       * device), so without a stable one every press of Play invents a new
       * device on the server and leaves a session nobody will ever close.
       *
       * `supportedMimeTypes` is what lets the server choose direct play
       * over a transcode. Saying nothing makes it assume the worst and
       * transcode, which costs the server CPU for audio the phone could
       * have played as it stands.
       */
      const response = await send(`/api/items/${encodeURIComponent(itemId)}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceInfo: { clientName: 'Due Back', clientVersion: '1.0.0', deviceId },
          mediaPlayer: 'expo-audio',
          supportedMimeTypes: [
            'audio/mpeg', 'audio/mp4', 'audio/m4b', 'audio/m4a',
            'audio/flac', 'audio/ogg', 'audio/aac', 'audio/wav',
          ],
        }),
      });
      if (!response.ok) await fail(response, 'Start streaming');

      const body = await readJson(response, 'Start streaming');
      const id = str(body.id);
      if (!id) throw new AbsError('server', 'Start streaming: the server opened no session.');

      const rawTracks = Array.isArray(body.audioTracks) ? body.audioTracks : [];
      const tracks: AbsAudioTrack[] = rawTracks
        .map((entry) => {
          const track = obj(entry);
          const path = str(track.contentUrl) ?? '';
          return {
            index: Number(track.index) || 0,
            startSec: Number(track.startOffset) || 0,
            durationSec: Number(track.duration) || 0,
            // Relative to the server, and never given a token: a direct
            // track is fetched with the Authorization header, and an HLS
            // url is already scoped to the unguessable session id.
            url: path.startsWith('http') ? path : `${base}${path}`,
            mimeType: str(track.mimeType) ?? '',
          };
        })
        .filter((track) => track.url.length > base.length);

      const method = Number(body.playMethod);
      return {
        id,
        playMethod: ((method === 0 || method === 1 || method === 2 || method === 3)
          ? method
          : 0) as AbsPlayMethod,
        tracks,
        durationSec: Number(obj(body.media).duration) || Number(body.duration) || 0,
        startedAtSec: Number(body.startTime) || 0,
      };
    },

    async syncSession(sessionId, place) {
      const response = await send(`/api/session/${encodeURIComponent(sessionId)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(place),
      });
      /*
       * Sessions live in the server's memory. A restart, a close, or a
       * newer /play from this same device ends one — so a 404 here is
       * routine and means "open another", not "something is wrong".
       */
      if (response.status === 404) return false;
      if (!response.ok) await fail(response, 'Report listening');
      return true;
    },

    async closeSession(sessionId, place) {
      // The close carries the final sync in its own body; there is no need
      // to sync and then close, and doing both reports the tail twice.
      const response = await send(`/api/session/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(place),
      });
      // A session already gone is a session closed, as far as anyone cares.
      if (response.status === 404) return;
      if (!response.ok) await fail(response, 'End the session');
    },

    currentAuth() {
      return auth;
    },
  };
}
