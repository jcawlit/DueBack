/**
 * Audiobookshelf, in the testing stage.
 *
 * Deliberately plain: labelled fields, square buttons, errors as sentences.
 * None of this is meant to survive into Settings as it looks here — it is
 * the smallest honest surface for finding out whether the client works
 * against a real server on a real phone. Keeping it in one file, under one
 * clearly-marked heading, is what makes it cheap to throw away.
 */

import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
import { AbsError, isCleartextToPublicHost, type AbsLibrary } from '@/lib/abs/client';
import { describeAbsError, describeServerVersion } from '@/lib/abs/errors';
import { useSources, type ConnectForm, type TestResult } from '@/store/sources';
import type { Source } from '@/db/sources';
import { relativeTime } from '@/lib/format';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';

const EMPTY: ConnectForm = { serverUrl: '', username: '', password: '', apiKey: '' };

/**
 * Whatever went wrong, as something a person can act on.
 *
 * Connecting is the one place where "auth" means the password just typed
 * is wrong rather than a session having expired, so it says so instead of
 * sending somebody to sign in again on a form they are already filling in.
 */
function explainConnect(error: unknown): string {
  if (error instanceof AbsError && error.kind === 'auth') {
    return 'That username and password were not accepted.';
  }
  return describeAbsError(error, 'connect');
}

function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
      {children}
    </Text>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboard,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboard?: 'url' | 'default';
}) {
  return (
    <View style={{ gap: 4 }}>
      <Label>{label}</Label>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.faint}
        secureTextEntry={secure}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboard === 'url' ? 'url' : 'default'}
        style={{
          minHeight: TOUCH,
          paddingHorizontal: space.md,
          paddingVertical: 8,
          borderWidth: 1,
          borderColor: color.line,
          borderRadius: radius.button,
          fontFamily: font.mono,
          fontSize: 13,
          color: color.paper,
        }}
      />
    </View>
  );
}

function Button({
  label,
  onPress,
  busy,
  disabled,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: 'normal' | 'accent' | 'warning';
}) {
  const ink =
    tone === 'accent' ? color.accent : tone === 'warning' ? color.warning : color.paper;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || busy) }}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
        paddingHorizontal: space.md,
        borderWidth: 1,
        borderColor: ink,
        borderRadius: radius.button,
        opacity: disabled || busy ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={ink} /> : null}
      <Text style={{ fontFamily: font.mono, fontSize: 12, color: ink }}>{label}</Text>
    </Pressable>
  );
}

function Message({ text, tone }: { text: string; tone: 'ok' | 'bad' }) {
  return (
    <Text
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        lineHeight: 16,
        color: tone === 'ok' ? color.accent : color.warning,
      }}
    >
      {text}
    </Text>
  );
}

// ------------------------------------------------------------ connect form

function ConnectPanel({ onDone }: { onDone: () => void }) {
  const testConnection = useSources((s) => s.testConnection);
  const saveConnection = useSources((s) => s.saveConnection);
  const pickLibrary = useSources((s) => s.pickLibrary);

  const [form, setForm] = useState<ConnectForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<TestResult | null>(null);

  const set = (patch: Partial<ConnectForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    // Any edit invalidates the test: Save must only ever persist credentials
    // that were actually proved, not the ones that happened to be on screen.
    setTested(null);
  };

  const warnCleartext = isCleartextToPublicHost(form.serverUrl);
  /** Anything worth saying about how old the server is. */
  const versionNote = tested ? describeServerVersion(tested.version) : null;

  const test = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        setTested(await testConnection(form));
      } catch (e) {
        setTested(null);
        setError(explainConnect(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const save = () => {
    if (!tested) return;
    setBusy(true);
    void (async () => {
      try {
        const source = await saveConnection(form, tested);
        // One book library and no choice to make: pick it rather than
        // showing a list of one.
        if (tested.libraries.length === 1) await pickLibrary(source.id, tested.libraries[0]);
        setForm(EMPTY);
        setTested(null);
        onDone();
      } catch (e) {
        setError(explainConnect(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <View style={{ gap: space.sm }}>
      <Field
        label="SERVER URL"
        value={form.serverUrl}
        onChangeText={(serverUrl) => set({ serverUrl })}
        placeholder="http://192.168.1.90:13378"
        keyboard="url"
      />
      {warnCleartext ? (
        <Message
          tone="bad"
          text={'This is a plain http address outside your own network, so the password would travel unencrypted. Connecting to it is refused. Use https, or reach the server over your own network.'}
        />
      ) : null}

      <Field
        label="USERNAME"
        value={form.username}
        onChangeText={(username) => set({ username })}
      />
      <Field
        label="PASSWORD"
        value={form.password}
        onChangeText={(password) => set({ password })}
        secure
      />
      <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
        The password is used to sign in and then discarded. Only the token it
        returns is stored, and not in the database.
      </Text>

      <Field
        label="OR API KEY"
        value={form.apiKey}
        onChangeText={(apiKey) => set({ apiKey })}
        placeholder="instead of a username and password"
        secure
      />

      {/*
        Disabled rather than left to fail: the client refuses the request, so
        a pressable Test button would only hand back the same sentence the
        message above already says.
      */}
      <Button
        label="Test connection"
        onPress={test}
        busy={busy}
        disabled={warnCleartext}
      />

      {error ? <Message tone="bad" text={error} /> : null}
      {tested ? (
        <View style={{ gap: 2 }}>
          <Message
            tone="ok"
            text={
              `Audiobookshelf ${tested.version ?? 'of unknown version'} · signed in as ` +
              `${tested.session.user.username || 'that account'} (${tested.session.user.type})`
            }
          />
          {versionNote ? (
            <Message tone="bad" text={versionNote.text} />
          ) : null}
          <Message
            tone={tested.libraries.length === 0 ? 'bad' : 'ok'}
            text={
              tested.libraries.length === 0
                ? 'No book libraries on this server. Podcast libraries are not shown.'
                : `${tested.libraries.length} book ${tested.libraries.length === 1 ? 'library' : 'libraries'}: ` +
                  tested.libraries.map((l) => l.name).join(', ')
            }
          />
        </View>
      ) : null}

      <Button
        label="Save"
        onPress={save}
        tone="accent"
        disabled={!tested || versionNote?.tone === 'bad'}
        busy={busy}
      />
    </View>
  );
}

// --------------------------------------------------------- connected state

function LibraryPicker({ source }: { source: Source }) {
  const clientFor = useSources((s) => s.clientFor);
  const pickLibrary = useSources((s) => s.pickLibrary);
  const [libraries, setLibraries] = useState<AbsLibrary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLibraries = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const client = await clientFor(source.id);
        if (!client) {
          setError('No stored credentials. Sign in again.');
          return;
        }
        setLibraries(await client.libraries());
      } catch (e) {
        setError(describeAbsError(e, 'catalogue'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
        {source.config.absLibraryName
          ? `Library: ${source.config.absLibraryName}`
          : 'No library picked yet'}
      </Text>
      <Button
        label={libraries ? 'Reload libraries' : 'Choose library'}
        onPress={fetchLibraries}
        busy={busy}
      />
      {error ? <Message tone="bad" text={error} /> : null}
      {libraries?.length === 0 ? (
        <Message tone="bad" text="No book libraries on this server." />
      ) : null}
      {libraries?.map((library) => {
        const on = library.id === source.config.absLibraryId;
        return (
          <Pressable
            key={library.id}
            onPress={() => void pickLibrary(source.id, library)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Use the library ${library.name}`}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              justifyContent: 'center',
              paddingHorizontal: space.md,
              borderWidth: 1,
              borderColor: on ? color.accent : color.line,
              borderRadius: radius.button,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{ fontFamily: font.mono, fontSize: 12, color: on ? color.accent : color.paper }}
            >
              {on ? '● ' : '○ '}
              {library.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SignInAgainPanel({ source }: { source: Source }) {
  const reconnect = useSources((s) => s.reconnect);
  const [form, setForm] = useState<ConnectForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await reconnect(source.id, form);
        setForm(EMPTY);
      } catch (e) {
        setError(explainConnect(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <View style={{ gap: space.sm }}>
      <Message
        tone="bad"
        text={
          'Sign in again. The session could not be renewed, and there is no ' +
          'stored password to retry with — by design.'
        }
      />
      <Field
        label={`PASSWORD FOR ${source.config.username || 'THIS ACCOUNT'}`}
        value={form.password}
        onChangeText={(password) => setForm((f) => ({ ...f, password }))}
        secure
      />
      <Field
        label="OR API KEY"
        value={form.apiKey}
        onChangeText={(apiKey) => setForm((f) => ({ ...f, apiKey }))}
        secure
      />
      <Button label="Sign in again" onPress={go} tone="accent" busy={busy} />
      {error ? <Message tone="bad" text={error} /> : null}
    </View>
  );
}

function SourcePanel({ source }: { source: Source }) {
  const disconnect = useSources((s) => s.disconnect);
  const remove = useSources((s) => s.remove);
  const refreshCatalogue = useSources((s) => s.refreshCatalogue);
  const refreshing = useSources((s) => s.refreshing[source.id] === true);
  const last = useSources((s) => s.lastRefresh[source.id]);

  /** What the last catalogue read did, in one line. */
  const refreshLine = (() => {
    if (refreshing) return 'Reading the catalogue…';
    if (!last) return null;
    if (last.error) return `Last check failed: ${last.error}`;
    const c = last.change;
    if (!c) return null;
    const parts = [`${c.total} on the server`];
    if (c.added) parts.push(`${c.added} new`);
    if (c.updated) parts.push(`${c.updated} changed`);
    if (c.returned) parts.push(`${c.returned} back`);
    if (c.missing) parts.push(`${c.missing} gone`);
    return parts.join(' · ');
  })();

  const confirmRemove = () => {
    Alert.alert(
      `Remove ${source.label}?`,
      'The stored token is deleted and the server is forgotten. Nothing on the ' +
        'server is touched, and any books that came from it keep their progress ' +
        'and notes on this phone.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove(source.id) },
      ],
    );
  };

  return (
    <View
      style={{
        gap: space.sm,
        padding: space.md,
        borderWidth: 1,
        borderColor: color.line,
        borderRadius: radius.button,
      }}
    >
      <Text style={{ fontFamily: font.sans, fontSize: 15, color: color.paper }}>
        {source.label}
      </Text>
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
        {source.config.serverUrl}
        {source.config.serverVersion ? ` · v${source.config.serverVersion}` : ''}
        {source.config.username ? ` · ${source.config.username}` : ''}
      </Text>
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
        {source.lastSeenAt ? `Last checked ${relativeTime(source.lastSeenAt)}` : 'Never checked'}
      </Text>

      {source.config.needsSignIn ? (
        <SignInAgainPanel source={source} />
      ) : (
        <>
          <LibraryPicker source={source} />
          <Button
            label={refreshing ? 'Checking…' : 'Check again'}
            onPress={() => void refreshCatalogue(source.id)}
            tone="accent"
            busy={refreshing}
            disabled={!source.config.absLibraryId}
          />
          {refreshLine ? (
            <Message tone={last?.error ? 'bad' : 'ok'} text={refreshLine} />
          ) : null}
        </>
      )}

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            label="Disconnect"
            onPress={() => void disconnect(source.id)}
            disabled={!!source.config.needsSignIn}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Remove" onPress={confirmRemove} tone="warning" />
        </View>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ section

export function AbsTestingSection() {
  const sources = useSources((s) => s.sources);
  const [adding, setAdding] = useState(false);
  const servers = sources.filter((s) => s.kind === 'abs');

  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
        AUDIOBOOKSHELF (TESTING)
      </Text>
      <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
        Unfinished. The catalogue and chapters arrive; the audio does not yet.
      </Text>

      {servers.map((source) => (
        <SourcePanel key={source.id} source={source} />
      ))}

      {adding || servers.length === 0 ? (
        <ConnectPanel onDone={() => setAdding(false)} />
      ) : (
        <Button label="Add another server" onPress={() => setAdding(true)} />
      )}
    </View>
  );
}
