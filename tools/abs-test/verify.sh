#!/usr/bin/env bash
#
# Proves, against the running test server, every call the Pro sync work is
# going to depend on. Run it after seed.sh, and again after bumping the
# server version in docker-compose.yml.
#
#   ./verify.sh
#
# Runs entirely as dueback-test — a normal user with download permission, as
# the app will be. Nothing here uses the admin account, because an endpoint
# that works for root and not for a normal user is a bug the harness has to
# be able to see.
#
# Exit code is the result: 0 if every check passed.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SAMPLE="$HERE/sample-item.json"
BOOK_TITLE="The Lighthouse Keeper"

PASSED=0
FAILED=0

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { PASSED=$((PASSED + 1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
note() { printf '        %s\n' "$1"; }

# eq <what> <got> <wanted>
eq() {
  if [ "$2" = "$3" ]; then ok "$1 — $3"; else bad "$1 — wanted $3, got ${2:-nothing}"; fi
}

# some <what> <got>
some() {
  if [ -n "$2" ]; then ok "$1 — $2"; else bad "$1 — nothing"; fi
}

# A failure in the middle should report what it found and carry on to the
# summary, not vanish into set -e.
fatal() { bad "$1"; summary; exit 1; }

summary() {
  say "Result"
  printf '  %d passed, %d failed\n\n' "$PASSED" "$FAILED"
}

abs_wait_up

# ------------------------------------------------------------------ login

say "Login — POST /login"
TOKEN="$(abs_login ABS_TEST_USER ABS_TEST_PASS)" || fatal "POST /login as $ABS_TEST_USER returned $(abs_code)"
eq "POST /login" "$(abs_code)" "200"
some "access token" "$(printf '%s' "${TOKEN:0:12}")…"

ME="$(api "$TOKEN" GET /api/me)"
eq "GET /api/me" "$(abs_code)" "200"
eq "it is $ABS_TEST_USER" "$(printf '%s' "$ME" | json username || true)" "$ABS_TEST_USER"
eq "not an admin" "$(printf '%s' "$ME" | json type || true)" "user"
eq "download permission" "$(printf '%s' "$ME" | json permissions.download || true)" "true"

# ----------------------------------------------------------------- status

say "Status"
# The brief asks for /api/status. On 2.37 the public one is /status; try the
# documented path first and record whichever actually answers, because which
# of the two is live is itself something the client needs to know.
STATUS="$(api "$TOKEN" GET /api/status)"
STATUS_PATH="/api/status"
if [ "$(abs_code)" != "200" ]; then
  note "/api/status returned $(abs_code) — falling back to /status"
  STATUS="$(api "$TOKEN" GET /status)"
  STATUS_PATH="/status"
fi
eq "GET $STATUS_PATH" "$(abs_code)" "200"
VERSION="$(printf '%s' "$STATUS" | json serverVersion || true)"
some "server version" "$VERSION"

# --------------------------------------------------------------- libraries

say "Libraries — GET /api/libraries"
LIBS="$(api "$TOKEN" GET /api/libraries)"
eq "GET /api/libraries" "$(abs_code)" "200"
LIB_ID="$(printf '%s' "$LIBS" | json_find libraries name "Test Shelf" id || true)"
some "Test Shelf id" "$LIB_ID"
[ -n "$LIB_ID" ] || fatal "No library called Test Shelf — run ./seed.sh first"
eq "its media type" "$(printf '%s' "$LIBS" | json_find libraries name "Test Shelf" mediaType || true)" "book"

say "Items — GET /api/libraries/:id/items"
ITEMS="$(api "$TOKEN" GET "/api/libraries/$LIB_ID/items?limit=0")"
eq "GET /api/libraries/:id/items" "$(abs_code)" "200"
eq "book count" "$(printf '%s' "$ITEMS" | json total || true)" "3"
for want in "The Lighthouse Keeper" "Three Short Nights" "The Unmarked Box"; do
  found="$(ITEM_WANT="$want" pick 'd.results.some((r) => r.media.metadata.title === process.env.ITEM_WANT)' <<<"$ITEMS" || true)"
  eq "$want is there" "$found" "true"
done

ITEM_ID="$(ITEM_WANT="$BOOK_TITLE" pick 'd.results.find((r) => r.media.metadata.title === process.env.ITEM_WANT).id' <<<"$ITEMS" || true)"
[ -n "$ITEM_ID" ] || fatal "Could not find $BOOK_TITLE in the library"

# --------------------------------------------------------------- one item

say "One item — GET /api/items/:id?expanded=1"
ITEM="$(api "$TOKEN" GET "/api/items/$ITEM_ID?expanded=1")"
eq "GET /api/items/:id?expanded=1" "$(abs_code)" "200"
eq "title" "$(printf '%s' "$ITEM" | json media.metadata.title || true)" "$BOOK_TITLE"
some "author (from the ID3 tags)" "$(printf '%s' "$ITEM" | json media.metadata.authorName || true)"
some "series (from the ID3 tags)" "$(printf '%s' "$ITEM" | json media.metadata.seriesName || true)"
DURATION="$(printf '%s' "$ITEM" | json media.duration || true)"
some "duration" "$DURATION"
some "cover path" "$(printf '%s' "$ITEM" | json media.coverPath || true)"

printf '%s' "$ITEM" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    process.stdout.write(JSON.stringify(JSON.parse(s), null, 2) + "\n");
  });
' > "$SAMPLE"
note "saved $(basename "$SAMPLE") ($(wc -c < "$SAMPLE" | tr -d ' ') bytes)"

# And the three-file book, whose chapters the server derives from the
# files. The single-file sample above has none, so without this one the
# chapter mapping would have no real payload to be tested against.
MULTI_ID="$(ITEM_WANT="Three Short Nights" pick 'd.results.find((r) => r.media.metadata.title === process.env.ITEM_WANT).id' <<<"$ITEMS" || true)"
if [ -n "$MULTI_ID" ]; then
  MULTI="$(api "$TOKEN" GET "/api/items/$MULTI_ID?expanded=1")"
  printf '%s' "$MULTI" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      process.stdout.write(JSON.stringify(JSON.parse(s), null, 2) + "\n");
    });
  ' > "$HERE/sample-item-multi.json"
  eq "its chapters" "$(pick 'd.media.chapters.length' <<<"$MULTI" || echo 0)" "3"
  eq "its tracks" "$(pick 'd.media.tracks.length' <<<"$MULTI" || echo 0)" "3"
  note "saved sample-item-multi.json"
else
  bad "could not find Three Short Nights for the chapters sample"
fi

INO="$(pick 'd.media.audioFiles[0].ino' <<<"$ITEM" || true)"
TRACK_NAME="$(pick 'd.media.audioFiles[0].metadata.filename' <<<"$ITEM" || true)"
some "first audio file ino" "$INO"
[ -n "$INO" ] || fatal "No ino on the first audio file — cannot test the download"

# --------------------------------------------------------------- download

say "Download — GET /api/items/:id/file/:ino/download, with a Range"
# The whole point of a Range request here is that the client will resume
# a half-finished download. A server that answers 200 instead of 206 has
# handed back the whole file and quietly ignored the ask.
HDR="$(mktemp)"
BYTES="$(mktemp)"
CODE="$(curl -sS -o "$BYTES" -D "$HDR" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-1023' \
  "$ABS_URL/api/items/$ITEM_ID/file/$INO/download")"
eq "partial content" "$CODE" "206"
eq "bytes returned" "$(wc -c < "$BYTES" | tr -d ' ')" "1024"
some "Content-Range" "$(grep -i '^content-range:' "$HDR" | tr -d '\r' | cut -d' ' -f2- || true)"
some "Content-Type" "$(grep -i '^content-type:' "$HDR" | tr -d '\r' | cut -d' ' -f2- || true)"
note "file: $TRACK_NAME"
rm -f "$HDR" "$BYTES"

# ---------------------------------------------------------------- session

say "Playback session — POST /api/items/:id/play"
PLAY_BODY="$(node -e '
  process.stdout.write(JSON.stringify({
    deviceInfo: { clientName: "dueback-abs-test", clientVersion: "0.0.0", deviceId: "abs-test-harness" },
    mediaPlayer: "dueback",
    supportedMimeTypes: ["audio/mpeg", "audio/mp4", "audio/flac"],
    forceDirectPlay: true,
  }));
')"
SESSION="$(api "$TOKEN" POST "/api/items/$ITEM_ID/play" "$PLAY_BODY")"
eq "POST /api/items/:id/play" "$(abs_code)" "200"
SESSION_ID="$(printf '%s' "$SESSION" | json id || true)"
some "session id" "$SESSION_ID"
some "play method" "$(printf '%s' "$SESSION" | json playMethod || true)"
TRACKS="$(pick 'd.audioTracks.length' <<<"$SESSION" || echo 0)"
eq "audioTracks" "$TRACKS" "1"
some "first track url" "$(pick 'd.audioTracks[0].contentUrl' <<<"$SESSION" || true)"
some "track duration" "$(pick 'd.audioTracks[0].duration' <<<"$SESSION" || true)"
[ -n "$SESSION_ID" ] || fatal "No session id — cannot test sync or close"

say "Session sync and close"
# A quarter of the way in, worked out from the book's real length rather
# than written down here, so changing the fixtures in seed.sh cannot quietly
# put this test somewhere the server treats as the end.
SYNC_AT="$(ABS_DUR="$DURATION" node -e \
  'process.stdout.write(String(Math.round(Number(process.env.ABS_DUR) / 4)))')"
SYNC_BODY="$(ABS_DUR="$DURATION" ABS_AT="$SYNC_AT" node -e '
  process.stdout.write(JSON.stringify({
    currentTime: Number(process.env.ABS_AT),
    timeListened: Number(process.env.ABS_AT),
    duration: Number(process.env.ABS_DUR),
  }));
')"
api "$TOKEN" POST "/api/session/$SESSION_ID/sync" "$SYNC_BODY" >/dev/null
eq "POST /api/session/:id/sync" "$(abs_code)" "200"
api "$TOKEN" POST "/api/session/$SESSION_ID/close" "$SYNC_BODY" >/dev/null
eq "POST /api/session/:id/close" "$(abs_code)" "200"

# --------------------------------------------------------------- progress

say "Progress — PATCH then GET /api/me/progress/:itemId"
BEFORE="$(api "$TOKEN" GET "/api/me/progress/$ITEM_ID")"
BEFORE_TIME="$(printf '%s' "$BEFORE" | json currentTime || echo 0)"
BEFORE_STAMP="$(printf '%s' "$BEFORE" | json lastUpdate || echo 0)"
BEFORE_PROGRESS="$(printf '%s' "$BEFORE" | json progress || echo 0)"
note "before: currentTime=$BEFORE_TIME progress=$BEFORE_PROGRESS lastUpdate=$BEFORE_STAMP"
# Closing the session above is what moved progress off zero. Worth asserting
# on its own, because the next check is about what does *not* move it.
some "progress, set by closing the session" "$BEFORE_PROGRESS"

# A second apart at least, so a lastUpdate that did not move is visible as
# such rather than as two identical millisecond stamps.
sleep 1

# Half way in. Audiobookshelf recomputes progress from currentTime and
# duration and will call a book finished when little enough is left, so the
# position under test has to be one no such rule can claim.
PATCH_AT="$(ABS_DUR="$DURATION" node -e \
  'process.stdout.write(String(Math.round(Number(process.env.ABS_DUR) / 2)))')"
WANT_PROGRESS="$(ABS_DUR="$DURATION" ABS_AT="$PATCH_AT" node -e \
  'process.stdout.write(String(Number(process.env.ABS_AT) / Number(process.env.ABS_DUR)))')"
# Sent in full, as the brief asks, even though the server keeps its own
# counsel on one of the four fields.
PROGRESS_BODY="$(ABS_DUR="$DURATION" ABS_AT="$PATCH_AT" ABS_P="$WANT_PROGRESS" node -e '
  process.stdout.write(JSON.stringify({
    currentTime: Number(process.env.ABS_AT),
    duration: Number(process.env.ABS_DUR),
    progress: Number(process.env.ABS_P),
    isFinished: false,
  }));
')"
api "$TOKEN" PATCH "/api/me/progress/$ITEM_ID" "$PROGRESS_BODY" >/dev/null
eq "PATCH /api/me/progress/:itemId" "$(abs_code)" "200"

AFTER="$(api "$TOKEN" GET "/api/me/progress/$ITEM_ID")"
eq "GET /api/me/progress/:itemId" "$(abs_code)" "200"
AFTER_TIME="$(printf '%s' "$AFTER" | json currentTime || true)"
AFTER_STAMP="$(printf '%s' "$AFTER" | json lastUpdate || true)"
eq "currentTime moved" "$AFTER_TIME" "$PATCH_AT"
eq "isFinished" "$(printf '%s' "$AFTER" | json isFinished || true)" "false"

# The one surprise this harness turned up, and the reason it exists.
#
# PATCH takes currentTime and isFinished and ignores progress — sending it,
# sending it alone, or sending none of it all leave the stored value exactly
# where the last playback session left it. So currentTime is the field a
# client owns and progress is the server's own bookkeeping; a client that
# treats progress as its own will read back a number it did not write.
#
# Asserted rather than noted, so that a server version which starts honouring
# it fails here instead of quietly changing what sync means.
eq "progress ignores the PATCH body" \
  "$(printf '%s' "$AFTER" | json progress || true)" "$BEFORE_PROGRESS"
if [ -n "$AFTER_STAMP" ] && [ "$AFTER_STAMP" -gt "${BEFORE_STAMP:-0}" ] 2>/dev/null; then
  ok "lastUpdate moved — $BEFORE_STAMP to $AFTER_STAMP"
else
  bad "lastUpdate did not move — still ${AFTER_STAMP:-nothing}"
fi

# And the other end of it. Not in the brief, but the client has to know
# that finishing a book is a thing the server records rather than infers,
# and finishedAt is where it records it.
FINISH_BODY="$(ABS_DUR="$DURATION" node -e '
  process.stdout.write(JSON.stringify({
    currentTime: Number(process.env.ABS_DUR),
    duration: Number(process.env.ABS_DUR),
    progress: 1,
    isFinished: true,
  }));
')"
api "$TOKEN" PATCH "/api/me/progress/$ITEM_ID" "$FINISH_BODY" >/dev/null
FINISHED="$(api "$TOKEN" GET "/api/me/progress/$ITEM_ID")"
eq "isFinished after finishing it" "$(printf '%s' "$FINISHED" | json isFinished || true)" "true"
some "finishedAt" "$(printf '%s' "$FINISHED" | json finishedAt || true)"

# Put it back, so a second run starts where the first one did. Clearing
# isFinished also returns currentTime to 0 — the server's doing, not ours.
RESET_BODY="$(ABS_DUR="$DURATION" node -e '
  process.stdout.write(JSON.stringify({
    currentTime: 0,
    duration: Number(process.env.ABS_DUR),
    progress: 0,
    isFinished: false,
  }));
')"
api "$TOKEN" PATCH "/api/me/progress/$ITEM_ID" "$RESET_BODY" >/dev/null
note "progress reset to 0"

# ----------------------------------------------------------------- summary

say "Server"
note "Audiobookshelf $VERSION, status at $STATUS_PATH"
note "library $LIB_ID — Test Shelf, 3 books"

summary
[ "$FAILED" -eq 0 ]
