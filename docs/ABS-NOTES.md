# Audiobookshelf: what must happen before release

The feature works. This is the list of what is deliberately unfinished,
what was audited and found clean, and what has to change outside the code
before anyone else can use it.

`docs/STATE.md` says what is verified and what has never run on hardware.
`docs/KNOWLEDGE.md` holds the server's own quirks. This file is only about
getting it out of the door.

## Must be done before release

### 1. Scope cleartext to private addresses

**Where:** `plugins/withCleartextTraffic.js`, `app.json`.

`android:usesCleartextTraffic="true"` is currently set for the **whole
app**. An Audiobookshelf server on a home network is reached over plain
http, and Android has blocked cleartext by default since API 28 — the
refusal happens in the socket layer, so the app can only report "could not
reach the server", which is the wrong diagnosis.

Replace it with a network security config permitting cleartext **only**
for private ranges:

```
10.0.0.0/8      172.16.0.0/12     192.168.0.0/16
169.254.0.0/16  127.0.0.1         ::1
```

Everything else then requires https, which is what should have been true
all along: a password to a public address currently travels in clear, and
the only thing stopping it is a warning line on the connect form that a
person may ignore.

The alternative — dropping global cleartext entirely and requiring https —
is cleaner but breaks the normal way people run this server at home, so
the scoped config is the one to build.

**Keep** the connect-form warning either way. It says something the
network config cannot: that *this particular address* is public.

### 2. Privacy policy and store listing

The app now makes network requests, which it never did before. Both need
saying plainly, because a listener's reasonable assumption about an
offline audiobook player is that it talks to nobody.

- **What is sent, and to whom.** Only to the server the user configures.
  Their username and password at sign-in; after that a token. Their
  listening position, and the fact that they listened. Nothing else, and
  nothing to us — there is no analytics, no crash reporting and no
  telemetry in this app.
- **What is stored on the phone.** The server address, the username, and
  which library was chosen, in the app's database. The access and refresh
  tokens in the Android keystore. **The password is not stored at all.**
- **What leaves the phone otherwise.** Nothing about a server reaches the
  USB drive backup — see the audit below.
- **Store form:** the data-safety section will need "Personal info →
  other" (a username) and "App activity" declared, both as *not collected
  by the developer* and *not shared*, because they go only to the user's
  own server. Worth re-reading the current wording of that form when the
  time comes; it changes.

### 3. Decide what Pro means here

No Pro gating has been added at any point in this work, deliberately. If
server support is to be paid for, the gate belongs in `src/lib/pro.ts`
beside the existing ones, and the decision about *which* parts are paid
(connecting at all? streaming? more than one server?) has not been made.

### 4. Replace the testing surface

`src/app/abs/[id].tsx` and the "AUDIOBOOKSHELF (TESTING)" section of
Settings are plain on purpose and are not meant to ship looking like
that. The server-details screen in particular exists to answer testing
questions — remote id, device id, cached-at, last progress push — and
most of it is not for a listener.

## Privacy audit

Done by reading the code on 19 October 2026, at `61a6309`. Re-run it with
the greps below after any change to `src/lib/abs/`.

### Every request goes to the user's own server

`src/lib/abs/client.ts` is the only module in the app that reaches the
network, and every path it builds is appended to the `serverUrl` the user
typed. There is no other `fetch`, no analytics SDK, no crash reporter, no
WebSocket.

```sh
# Network entry points outside the client. Expect no call sites.
rg -n '\bfetch\(|XMLHttpRequest|WebSocket|axios' src/ --glob '!src/lib/abs/client.ts'

# Absolute URLs anywhere in the app. Expect one: the form's placeholder.
rg -no 'https?://[a-zA-Z0-9._/-]+' src/
```

The single absolute URL in `src/` is the example address in the connect
form's placeholder text. It is never fetched.

The one exception to "always the Authorization header" is the HLS stream
url for a transcoding server, which carries no credential of any kind —
the session id in it is unguessable and dies with the session. That is the
server's design, not a choice made here.

### No credential is ever in a URL

```sh
rg -n '\?token=' src/      # expect only comments explaining why not
```

Audiobookshelf accepts `?token=` on most endpoints. The app never uses it:
a URL with a credential in it ends up in server logs, in crash reports and
in the image cache key, and an `<Image>` cannot send a header anyway —
which is why covers are fetched as bytes and written to the local cache
rather than pointed at.

### Nothing secret is in SQLite

The `sources` table holds `serverUrl`, `username`, which library was
picked, the server version, and a "needs sign in" flag. That is all
readable off a stolen phone and none of it will sign anyone in.

Tokens live in SecureStore (`src/lib/abs/tokens.ts`), keyed by source id,
as does the per-install device id. This matters because **the database
leaves the phone**: `plugins/withBackupExclusion.js` excludes `books/`,
`books-tmp/`, `covers/` and `imported/`, and expo-sqlite writes to
`filesDir/SQLite/dueback.db`, which is excluded by neither — so the
database is carried by Android cloud backup and by device transfer.

`tests/sources-migration.test.ts` asserts that a `sources` row contains no
`password`, `accessToken`, `refreshToken` or `apiKey`.

### The password is never stored anywhere

It is a parameter to `login()` and to `reconnect()`, exchanged for a token,
and dropped. No function in the codebase writes one, and
`tests/abs-client.test.ts` asserts a password appears in neither the
returned session, the request URL, nor the headers.

This is also why a failed token refresh is final: there is nothing to
retry with, so the source is marked "Sign in again" and asks. A client
that keeps trying against a server that keeps refusing is how an account
gets locked.

### Nothing about a server reaches the USB drive

`SyncPayload` (`src/lib/sync/records.ts`) has exactly six parts —
`identity`, `notes`, `characters`, `tags`, `progress`, `history`. There is
no `sources` part, and nothing in `src/lib/sync/` or `src/store/backup.ts`
references the sources table. A drive shared between two phones carries
the listener's writing and no server configuration.

```sh
rg -n 'sources|source_id' src/lib/sync/ src/db/sync.ts src/store/backup.ts
```

### Logs

`console.warn` carries failures, including the error objects the server
returned. Those can contain a URL and a status, and never a credential:
the token travels in a header and no code path logs headers. The
informational `console.log` calls are behind `__DEV__`.

```sh
rg -nE 'console\.(log|warn|error).*(token|password|Authorization)' src/
```

Three hits, all in `src/lib/abs/tokens.ts`, and all of them the *word*
rather than the value — `could not read the token for ${sourceId}` logs a
source id and an error object. Worth re-reading rather than trusting the
grep's silence, because a log line that interpolates a token would look
much the same.

## Known-unfinished, not blocking

- **Resume after a dropped download does nothing useful.** Losing the
  network mid-download behaves like a cancel and the partial file is
  discarded. Fine for a short book, a real cost on a long one over a poor
  connection.
- **The transcode path has never run.** With MP3s the test server always
  answers direct play, so the HLS branch is implemented and unexercised.
- **`MIN_SERVER_VERSION` is reasoned, not tested.** It is set from the
  oldest endpoint the app depends on (the playback session API, 2.0),
  because no old server was available to try. The pre-2.18 `ino` fallback
  is likewise built from the documented shape and tested only against
  synthetic payloads.
- **One server at a time is the tested shape.** The code supports several
  and nothing has used two at once.
