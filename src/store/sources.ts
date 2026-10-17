/**
 * The configured libraries, and the one that is showing.
 *
 * Testing-stage. The screens that use this are plain forms, and the only
 * thing an Audiobookshelf source can do so far is exist, be signed into, and
 * report which of the server's libraries was picked. Bringing its books
 * across is step 2.
 *
 * The password is handled only ever as a function argument: `testConnection`
 * takes one, exchanges it for a token, and lets it go. Nothing in this file
 * holds one in state, and nothing writes one anywhere.
 */

import { create } from 'zustand';
import {
  AbsError,
  createClient,
  login,
  normalizeServerUrl,
  status,
  type AbsClient,
  type AbsLibrary,
  type AbsSession,
} from '@/lib/abs/client';
import { forgetTokens, loadTokens, saveTokens } from '@/lib/abs/tokens';
import {
  addSource,
  countBooksFor,
  getSource,
  listSources,
  removeSource,
  touchSource,
  updateSourceConfig,
  USB_SOURCE_ID,
  type Source,
} from '@/db/sources';

/** What the connect form has collected. The password is not kept past use. */
export type ConnectForm = {
  serverUrl: string;
  username: string;
  password: string;
  /** Supplied instead of a username and password, when the server issues one. */
  apiKey: string;
};

export type TestResult = {
  session: AbsSession;
  /** Whatever the server admitted to, from /status or the login payload. */
  version?: string;
  /** Book libraries only — podcasts are filtered out before they get here. */
  libraries: AbsLibrary[];
};

type SourcesState = {
  sources: Source[];
  ready: boolean;
  /** Books per source id, for the switcher's subtitle. */
  bookCounts: Record<string, number>;

  load: () => Promise<void>;
  testConnection: (form: ConnectForm) => Promise<TestResult>;
  saveConnection: (form: ConnectForm, tested: TestResult) => Promise<Source>;
  pickLibrary: (sourceId: string, library: AbsLibrary) => Promise<void>;
  /** Signs a marked source back in, clearing "Sign in again" on success. */
  reconnect: (sourceId: string, form: ConnectForm) => Promise<void>;
  /** Drops the credentials and keeps the source, so it can be signed into. */
  disconnect: (sourceId: string) => Promise<void>;
  remove: (sourceId: string) => Promise<void>;
  /** A live client for a stored source, or null when there is no token. */
  clientFor: (sourceId: string) => Promise<AbsClient | null>;
};

export const useSources = create<SourcesState>((set, get) => ({
  sources: [],
  ready: false,
  bookCounts: {},

  load: async () => {
    try {
      const sources = await listSources();
      const bookCounts: Record<string, number> = {};
      for (const source of sources) {
        bookCounts[source.id] = await countBooksFor(source.id);
      }
      set({ sources, bookCounts, ready: true });
    } catch (error) {
      console.warn('[sources] could not be loaded', error);
      set({ ready: true });
    }
  },

  /**
   * Proves the address and the credentials without writing anything.
   *
   * Does the whole round trip the connected state will need — version, user,
   * libraries — so that Save cannot fail for a reason the person has not
   * already been shown.
   */
  testConnection: async (form) => {
    const serverUrl = normalizeServerUrl(form.serverUrl);
    if (!serverUrl) throw new AbsError('unreachable', 'Enter the server address.');

    // Unauthenticated, so a wrong address is reported as a wrong address
    // rather than as a rejected password.
    const reported = await status(serverUrl);

    const apiKey = form.apiKey.trim();
    let session: AbsSession;
    if (apiKey) {
      const client = createClient({ serverUrl, auth: { kind: 'apiKey', apiKey } });
      session = await client.authorize();
    } else {
      if (!form.username.trim()) throw new AbsError('auth', 'Enter a username.');
      session = await login(serverUrl, form.username.trim(), form.password);
    }

    const client = createClient({ serverUrl, auth: { kind: 'tokens', tokens: session.tokens } });
    const libraries = await client.libraries();

    return { session, version: reported.version ?? session.serverVersion, libraries };
  },

  saveConnection: async (form, tested) => {
    const serverUrl = normalizeServerUrl(form.serverUrl);
    let host = serverUrl;
    try {
      host = new URL(serverUrl).host;
    } catch {
      // The full address is a usable label too.
    }
    const source = await addSource('abs', host, {
      serverUrl,
      username: tested.session.user.username || form.username.trim(),
      serverVersion: tested.version,
    });
    await saveTokens(source.id, tested.session.tokens);
    const lastSeenAt = await touchSource(source.id);
    const saved = { ...source, lastSeenAt };
    set((s) => ({ sources: [...s.sources, saved], bookCounts: { ...s.bookCounts, [saved.id]: 0 } }));
    return saved;
  },

  pickLibrary: async (sourceId, library) => {
    const updated = await updateSourceConfig(sourceId, {
      absLibraryId: library.id,
      absLibraryName: library.name,
    });
    if (!updated) return;
    set((s) => ({ sources: s.sources.map((x) => (x.id === sourceId ? updated : x)) }));
  },

  reconnect: async (sourceId, form) => {
    const source = await getSource(sourceId);
    if (!source) return;
    const serverUrl = source.config.serverUrl;
    const apiKey = form.apiKey.trim();
    const session = apiKey
      ? await createClient({ serverUrl, auth: { kind: 'apiKey', apiKey } }).authorize()
      : await login(serverUrl, source.config.username, form.password);

    await saveTokens(sourceId, session.tokens);
    const updated = await updateSourceConfig(sourceId, {
      needsSignIn: false,
      serverVersion: session.serverVersion ?? source.config.serverVersion,
    });
    const lastSeenAt = await touchSource(sourceId);
    if (updated) {
      set((s) => ({
        sources: s.sources.map((x) => (x.id === sourceId ? { ...updated, lastSeenAt } : x)),
      }));
    }
  },

  disconnect: async (sourceId) => {
    await forgetTokens(sourceId);
    const updated = await updateSourceConfig(sourceId, { needsSignIn: true });
    if (!updated) return;
    set((s) => ({ sources: s.sources.map((x) => (x.id === sourceId ? updated : x)) }));
  },

  remove: async (sourceId) => {
    await forgetTokens(sourceId);
    await removeSource(sourceId);
    set((s) => ({ sources: s.sources.filter((x) => x.id !== sourceId) }));
  },

  clientFor: async (sourceId) => {
    const source = await getSource(sourceId);
    if (!source || source.kind !== 'abs') return null;
    const tokens = await loadTokens(sourceId);
    if (!tokens) return null;

    return createClient({
      serverUrl: source.config.serverUrl,
      auth: { kind: 'tokens', tokens },
      onTokens: (next) => saveTokens(sourceId, next),
      /*
       * The end of the line for this source until somebody types a password.
       * Marked in the database so the state survives a restart, and mirrored
       * into the store so the screen showing it updates without a reload.
       */
      onSignInRequired: async () => {
        const updated = await updateSourceConfig(sourceId, { needsSignIn: true });
        if (updated) {
          set((s) => ({ sources: s.sources.map((x) => (x.id === sourceId ? updated : x)) }));
        }
      },
    });
  },
}));

/** The drive is always first and always there; the rest are configured. */
export function switchableSources(sources: Source[]): { id: string; label: string }[] {
  return [
    { id: USB_SOURCE_ID, label: 'Drive' },
    ...sources.map((source) => ({ id: source.id, label: source.label })),
  ];
}
