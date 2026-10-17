# Shared plumbing for the Audiobookshelf test harness. Sourced, not run.
#
# Two rules hold everywhere in here:
#
#   1. Passwords never reach a process argument list, a log line, or stdout.
#      They go from .env into a JSON body on a pipe and nowhere else.
#   2. Nothing is parsed with jq. This repo already requires node, and
#      requiring a second JSON tool to run the tests is a tax on every
#      machine that ever checks out the branch.

# A note for anyone tempted to set MSYS_NO_PATHCONV here: don't. Git Bash
# rewrites Unix-looking arguments into Windows paths before handing them to
# a native binary, and curl.exe, node.exe and ffmpeg.exe all need that —
# /dev/null has to become NUL and /c/Users has to become C:/Users. It does
# not touch anything containing "://", so URLs are safe. Every path a native
# binary sees in here is a real file; URL paths are concatenated onto
# $ABS_URL before curl ever sees them.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$HERE/.env" ]; then
  echo "No $HERE/.env. Copy .env.example to .env and fill it in — see README.md." >&2
  exit 1
fi

# `sed` strips the carriage returns a Windows editor leaves behind. Without
# it every value ends in \r, which makes a URL unreachable and a password
# wrong, with no visible difference in the error.
set -a
. <(sed 's/\r$//' "$HERE/.env")
set +a

: "${ABS_URL:?ABS_URL missing from .env}"
: "${ABS_ADMIN_USER:?ABS_ADMIN_USER missing from .env}"
: "${ABS_ADMIN_PASS:?ABS_ADMIN_PASS missing from .env}"
: "${ABS_TEST_USER:?ABS_TEST_USER missing from .env}"
: "${ABS_TEST_PASS:?ABS_TEST_PASS missing from .env}"
: "${ABS_NODL_USER:?ABS_NODL_USER missing from .env}"
: "${ABS_NODL_PASS:?ABS_NODL_PASS missing from .env}"

ABS_URL="${ABS_URL%/}"

# ---------------------------------------------------------------- JSON

# json <dotted.path> — reads JSON on stdin, prints the value there.
# Exits 1 when the path is absent, so `|| true` is how you ask politely.
# Objects and arrays come back re-encoded, which is what makes nesting work.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { process.exit(3); }
      for (const k of process.argv[1].split(".").filter(Boolean)) {
        v = v == null ? undefined : v[k];
      }
      if (v === undefined || v === null) process.exit(1);
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  ' "$1"
}

# pick <expression> — reads JSON on stdin, binds it to `d`, prints the value
# of the expression. For the places where a dotted path runs out: picking an
# element out of an array, or doing arithmetic on two fields. Exits 1 when
# the result is absent.
pick() {
  PICK_EXPR="$1" node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let d;
      try { d = JSON.parse(s); } catch { process.exit(3); }
      let v;
      try { v = new Function("d", "return (" + process.env.PICK_EXPR + ");")(d); }
      catch { process.exit(2); }
      if (v === undefined || v === null) process.exit(1);
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  '
}

# json_find <array.path> <key> <value> <field> — in the array at <array.path>,
# find the element whose <key> equals <value> and print its <field>.
# This is how every "does it already exist" check in seed.sh is written.
json_find() {
  JF_PATH="$1" JF_KEY="$2" JF_VAL="$3" JF_FIELD="$4" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { process.exit(3); }
      for (const k of process.env.JF_PATH.split(".").filter(Boolean)) {
        v = v == null ? undefined : v[k];
      }
      if (!Array.isArray(v)) process.exit(1);
      const hit = v.find((e) => e && String(e[process.env.JF_KEY]) === process.env.JF_VAL);
      if (!hit) process.exit(1);
      const out = hit[process.env.JF_FIELD];
      if (out === undefined || out === null) process.exit(1);
      process.stdout.write(typeof out === "object" ? JSON.stringify(out) : String(out));
    });
  '
}

# json_obj — builds an object from NAME=ENVVAR pairs, reading the values out
# of the environment rather than argv. The indirection exists for exactly one
# reason: a password passed as an argument is visible to every other process
# on the machine.
json_obj() {
  JO_PAIRS="$*" node -e '
    const out = {};
    for (const pair of process.env.JO_PAIRS.split(" ").filter(Boolean)) {
      const i = pair.indexOf("=");
      out[pair.slice(0, i)] = process.env[pair.slice(i + 1)];
    }
    process.stdout.write(JSON.stringify(out));
  '
}

# ---------------------------------------------------------------- HTTP

# The status of the last request, through a file rather than a variable.
#
# Every call here is written `body="$(api ...)"`, and a command substitution
# is a subshell: a variable the function sets dies with it, and the caller
# reads an empty string. A file is the one channel that survives, and the
# path is inherited, so the subshell writes where the parent will look.
ABS_CODE_FILE="$(mktemp)"
trap 'rm -f "$ABS_CODE_FILE"' EXIT

# abs_code — the HTTP status of the last api() or abs_login() call.
abs_code() { cat "$ABS_CODE_FILE" 2>/dev/null; }

# api <token> <method> <path> [body] — response body on stdout, status via
# abs_code. An empty token means an unauthenticated request.
api() {
  local token="$1" method="$2" path="$3" body="${4-}"
  local out auth=()
  out="$(mktemp)"
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    printf '%s' "$body" | curl -sS -o "$out" -w '%{http_code}' \
      -X "$method" "$ABS_URL$path" \
      "${auth[@]}" -H 'Content-Type: application/json' --data-binary @- \
      > "$ABS_CODE_FILE"
  else
    curl -sS -o "$out" -w '%{http_code}' \
      -X "$method" "$ABS_URL$path" "${auth[@]}" > "$ABS_CODE_FILE"
  fi
  cat "$out"
  rm -f "$out"
}

# abs_login <user-env-var> <pass-env-var> — prints an access token.
#
# Takes the names of the variables, not the values, so the password is never
# an argument. `x-return-tokens` asks the server for the tokens in the body
# instead of an http-only cookie: 2.26 moved to access/refresh tokens and
# that header is the documented way for a non-browser client to get them.
abs_login() {
  local body out token
  body="$(json_obj "username=$1" "password=$2")"
  out="$(mktemp)"
  printf '%s' "$body" | curl -sS -o "$out" -w '%{http_code}' \
    -X POST "$ABS_URL/login" \
    -H 'Content-Type: application/json' \
    -H 'x-return-tokens: true' \
    --data-binary @- > "$ABS_CODE_FILE"
  if [ "$(abs_code)" != "200" ]; then
    rm -f "$out"
    return 1
  fi
  # accessToken since 2.26; token is the legacy field, still present as of
  # 2.37 but on its way out. Take the new one when it is there.
  token="$(json user.accessToken < "$out" || true)"
  [ -n "$token" ] || token="$(json user.token < "$out" || true)"
  rm -f "$out"
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

# abs_wait_up — blocks until the server answers, or gives up after ~90s.
abs_wait_up() {
  local i
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "$ABS_URL/status" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "No answer from $ABS_URL after 90s. Is the container up? (docker compose up -d)" >&2
  return 1
}
