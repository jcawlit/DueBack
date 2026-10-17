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

/** How a request failed, in the only four ways a caller can act on. */
export type AbsErrorKind =
  /** Nothing answered: wrong address, server down, no route, cleartext blocked. */
  | 'unreachable'
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

export type AbsLibrary = {
  id: string;
  name: string;
  mediaType: string;
};

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

export type AbsClient = {
  authorize(): Promise<AbsSession>;
  libraries(): Promise<AbsLibrary[]>;
  /** The tokens as they now stand, after any renewal. */
  currentAuth(): AbsAuth;
};

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

    currentAuth() {
      return auth;
    },
  };
}
