#!/usr/bin/env bash
#
# Brings a blank Audiobookshelf container up to a known state: a root
# account, two test users, and a small library of generated books.
#
#   docker compose up -d && ./seed.sh
#
# Idempotent. Every step asks whether the thing already exists before making
# it, and re-running only repairs drift — a changed password in .env, a
# permission flipped by hand in the web UI. That matters because this is the
# script you run when you are not sure what state the server is in.
#
# This is the only script allowed to act as admin. Everything that proves
# behaviour runs as a normal user, in verify.sh, because that is what the
# app will be.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

AUDIO="$HERE/data/audiobooks"
LIBRARY_NAME="Test Shelf"
# The library path as the *server* sees it — the left half of the bind mount
# is a Windows path and means nothing inside the container.
LIBRARY_PATH="/audiobooks"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
did() { printf '  %s\n' "$1"; }

# ------------------------------------------------------------------ ffmpeg

find_ffmpeg() {
  [ -n "${FFMPEG:-}" ] && { printf '%s' "$FFMPEG"; return 0; }
  local found
  found="$(command -v ffmpeg || true)"
  [ -n "$found" ] && { printf '%s' "$found"; return 0; }
  # Installed but off PATH is the normal case on Windows.
  local c
  for c in "$HOME/ffmpeg/bin/ffmpeg.exe" \
           "/c/ffmpeg/bin/ffmpeg.exe" \
           "/c/ProgramData/chocolatey/bin/ffmpeg.exe"; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

FFMPEG="$(find_ffmpeg || true)"
if [ -z "$FFMPEG" ]; then
  echo "No ffmpeg. Install it, or set FFMPEG=/path/to/ffmpeg in .env." >&2
  exit 1
fi

# The native mp3 encoder is always present; libmp3lame usually is, and the
# difference matters not at all for a sine tone. Take whichever is there.
if "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -q libmp3lame; then
  MP3=libmp3lame
else
  MP3=mp3
fi

ff() { "$FFMPEG" -nostdin -hide_banner -loglevel error -y "$@"; }

# How long the generated books run, in seconds.
#
# They were twenty seconds once, which seemed in the spirit of "tiny"
# until the progress checks started failing. Audiobookshelf marks a book
# finished when little enough of it is left to play, and on a
# twenty-second book that rule covers most of the book. These are long
# enough that a position in the middle reads as the middle. Mono at 32k
# keeps a ten-minute sine tone near 2MB, and none of it is committed —
# data/ is git-ignored.
LONG=600
PART=300
SHORT=420

# ------------------------------------------------------------------ server

say "Server"
abs_wait_up

STATUS="$(api "" GET /status)"
VERSION="$(printf '%s' "$STATUS" | json serverVersion || echo unknown)"
IS_INIT="$(printf '%s' "$STATUS" | json isInit || echo false)"
did "Audiobookshelf $VERSION at $ABS_URL"

if [ "$IS_INIT" = "true" ]; then
  did "already initialised"
else
  # POST /init only works once, on a server with no users at all.
  INIT_BODY="$(ABS_INIT_ROOT="$(json_obj "username=ABS_ADMIN_USER" "password=ABS_ADMIN_PASS")" \
    node -e 'process.stdout.write(JSON.stringify({ newRoot: JSON.parse(process.env.ABS_INIT_ROOT) }))')"
  api "" POST /init "$INIT_BODY" >/dev/null
  if [ "$(abs_code)" != "200" ]; then
    echo "POST /init returned $(abs_code) — cannot create the root account." >&2
    exit 1
  fi
  did "created root account"
fi

ADMIN="$(abs_login ABS_ADMIN_USER ABS_ADMIN_PASS)" || {
  echo "Could not log in as the admin in .env (HTTP $(abs_code))." >&2
  echo "If this server was initialised with a different password, the fix is" >&2
  echo "'docker compose down && rm -rf data/' and a re-run." >&2
  exit 1
}
did "logged in as admin"

# ------------------------------------------------------------------- users

# ensure_user <user-var> <pass-var> <download: true|false>
#
# The permissions object is sent whole on both paths. A PATCH carrying only
# the key it wants to change is read by the server as the complete set, so a
# partial one silently revokes everything left out.
ensure_user() {
  local uvar="$1" pvar="$2" download="$3"
  local name="${!uvar}" existing body perms

  perms="$(ABS_DL="$download" node -e '
    process.stdout.write(JSON.stringify({
      download: process.env.ABS_DL === "true",
      update: false,
      delete: false,
      upload: false,
      accessAllLibraries: true,
      accessAllTags: true,
      accessExplicitContent: true,
    }));
  ')"

  existing="$(api "$ADMIN" GET /api/users | json_find users username "$name" id || true)"

  body="$(ABS_CORE="$(json_obj "username=$uvar" "password=$pvar")" ABS_PERMS="$perms" \
    node -e '
      process.stdout.write(JSON.stringify({
        ...JSON.parse(process.env.ABS_CORE),
        type: "user",
        isActive: true,
        permissions: JSON.parse(process.env.ABS_PERMS),
      }));
    ')"

  if [ -n "$existing" ]; then
    api "$ADMIN" PATCH "/api/users/$existing" "$body" >/dev/null
    [ "$(abs_code)" = "200" ] || { echo "PATCH user $name returned $(abs_code)" >&2; exit 1; }
    did "$name — already there, password and permissions reset (download=$download)"
  else
    api "$ADMIN" POST /api/users "$body" >/dev/null
    [ "$(abs_code)" = "200" ] || { echo "POST user $name returned $(abs_code)" >&2; exit 1; }
    did "$name — created (download=$download)"
  fi
}

say "Users"
ensure_user ABS_TEST_USER ABS_TEST_PASS true
ensure_user ABS_NODL_USER ABS_NODL_PASS false

# ------------------------------------------------------------------- books

# A rectangle of flat colour. ABS only has to find a cover and cache it;
# what the picture is of has never been the thing under test.
cover() {
  local path="$1" hex="$2"
  [ -f "$path" ] && return 0
  ff -f lavfi -i "color=c=$hex:s=400x600:d=1" -frames:v 1 "$path"
}

say "Books"
mkdir -p "$AUDIO"

# 1 — one file, fully tagged, with a cover both on disk and inside the mp3.
# The happy path: everything the client could want to read is present.
B1="$AUDIO/The Lighthouse Keeper"
mkdir -p "$B1"
cover "$B1/cover.jpg" 0x2b3a4a
if [ -f "$B1/the-lighthouse-keeper.mp3" ]; then
  did "The Lighthouse Keeper — already generated"
else
  ff -f lavfi -i "sine=frequency=220:duration=$LONG" -i "$B1/cover.jpg" \
    -map 0:a -map 1:v -c:a "$MP3" -b:a 32k -ac 1 -c:v copy \
    -id3v2_version 3 -disposition:v attached_pic \
    -metadata title="The Lighthouse Keeper" \
    -metadata artist="Marla Finch" \
    -metadata album="The Lighthouse Keeper" \
    -metadata album_artist="Marla Finch" \
    -metadata composer="Nell Ward" \
    -metadata date="2021" \
    -metadata genre="Fiction" \
    -metadata series="Keepers" \
    -metadata series-part="1" \
    -metadata comment="Generated by tools/abs-test/seed.sh" \
    "$B1/the-lighthouse-keeper.mp3"
  did "The Lighthouse Keeper — 1 file, tags, cover"
fi

# 2 — three files in a folder, which is how most real books arrive. The one
# that proves track order and a multi-track play session.
B2="$AUDIO/Three Short Nights"
mkdir -p "$B2"
cover "$B2/cover.jpg" 0x4a3b2b
i=0
for part in Dusk Midnight Dawn; do
  i=$((i + 1))
  f="$(printf '%s/%02d - %s.mp3' "$B2" "$i" "$part")"
  [ -f "$f" ] && continue
  ff -f lavfi -i "sine=frequency=$((300 + i * 60)):duration=$PART" \
    -c:a "$MP3" -b:a 32k -ac 1 -id3v2_version 3 \
    -metadata title="$part" \
    -metadata artist="Idris Vale" \
    -metadata album="Three Short Nights" \
    -metadata album_artist="Idris Vale" \
    -metadata track="$i/3" \
    -metadata date="2019" \
    "$f"
done
did "Three Short Nights — 3 files, cover"

# 3 — no cover, barely any tags. The client has to render something for a
# book the server knows almost nothing about, and this is that book.
B3="$AUDIO/The Unmarked Box"
mkdir -p "$B3"
if [ -f "$B3/the-unmarked-box.mp3" ]; then
  did "The Unmarked Box — already generated"
else
  ff -f lavfi -i "sine=frequency=180:duration=$SHORT" \
    -c:a "$MP3" -b:a 32k -ac 1 -id3v2_version 3 \
    -metadata title="The Unmarked Box" \
    "$B3/the-unmarked-box.mp3"
  did "The Unmarked Box — 1 file, no cover"
fi

# ----------------------------------------------------------------- library

say "Library"
LIB_ID="$(api "$ADMIN" GET /api/libraries | json_find libraries name "$LIBRARY_NAME" id || true)"

if [ -n "$LIB_ID" ]; then
  # A library pointing at the wrong folder scans clean and finds nothing,
  # which reads exactly like a broken mount. Say which it is.
  HAVE_PATH="$(api "$ADMIN" GET "/api/libraries/$LIB_ID" | pick 'd.folders[0].fullPath' || true)"
  if [ "$HAVE_PATH" != "$LIBRARY_PATH" ]; then
    echo "$LIBRARY_NAME points at '$HAVE_PATH', not '$LIBRARY_PATH'." >&2
    echo "Delete it in the web UI, or start over with:" >&2
    echo "  docker compose down && rm -rf data/ && docker compose up -d && ./seed.sh" >&2
    exit 1
  fi
  did "$LIBRARY_NAME — already there ($LIB_ID)"
else
  # disableWatcher because the library is a Windows bind mount: inotify does
  # not fire reliably across that boundary, so the harness scans on purpose
  # rather than waiting for a notification that may never arrive.
  #
  # MSYS_NO_PATHCONV because Git Bash rewrites any environment value that
  # looks like an absolute Unix path on its way into a native binary, and
  # node.exe is one. Without it the server is told to scan
  # "/app/C:/Program Files/Git/audiobooks", scans it happily, and finds
  # nothing — a failure that looks like a broken mount and is not. Scoped
  # to this one call: everywhere else in the harness that conversion is
  # exactly what makes a host path work.
  LIB_BODY="$(MSYS_NO_PATHCONV=1 ABS_LIB_NAME="$LIBRARY_NAME" ABS_LIB_PATH="$LIBRARY_PATH" node -e '
    process.stdout.write(JSON.stringify({
      name: process.env.ABS_LIB_NAME,
      folders: [{ fullPath: process.env.ABS_LIB_PATH }],
      mediaType: "book",
      provider: "audible",
      settings: { disableWatcher: true },
    }));
  ')"
  LIB_ID="$(api "$ADMIN" POST /api/libraries "$LIB_BODY" | json id || true)"
  [ -n "$LIB_ID" ] || { echo "Creating the library returned $(abs_code)" >&2; exit 1; }
  did "$LIBRARY_NAME — created ($LIB_ID)"
fi

api "$ADMIN" POST "/api/libraries/$LIB_ID/scan" >/dev/null || true
did "scan requested"

TOTAL=0
for _ in $(seq 1 60); do
  TOTAL="$(api "$ADMIN" GET "/api/libraries/$LIB_ID/items?limit=0" | json total || echo 0)"
  [ "${TOTAL:-0}" -ge 3 ] && break
  sleep 2
done

if [ "${TOTAL:-0}" -lt 3 ]; then
  echo "Only $TOTAL of 3 books showed up after two minutes. Check the server log:" >&2
  echo "  docker compose logs --tail 50 audiobookshelf" >&2
  exit 1
fi

say "Seeded"
did "$TOTAL books in $LIBRARY_NAME"
did "next: ./verify.sh"
