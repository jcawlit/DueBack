# A local Audiobookshelf, for testing against

A disposable Audiobookshelf server in Docker, with two test accounts and
three generated books. Everything automated or destructive aims here.

**The real server on the LAN is read-only for automation.** Manual checks on
the phone, nothing else. No script in this repository should ever write to
it, and none of them know its address.

## Running it

Needs Docker and ffmpeg. ffmpeg only has to be reachable: on PATH, or named
in `.env` as `FFMPEG=`.

```sh
cd tools/abs-test
cp .env.example .env     # then fill in three passwords
docker compose up -d
./seed.sh
./verify.sh
```

`seed.sh` is idempotent — run it whenever you are not sure what state the
server is in. It creates what is missing and repairs what has drifted,
including a password you changed in `.env`.

To start over completely:

```sh
docker compose down && rm -rf data/ && docker compose up -d && ./seed.sh
```

The web UI is at <http://localhost:13378>, if you want to look at what the
scripts made.

## What is in it

Three books, generated as sine tones by ffmpeg. They are ten, fifteen and
twenty minutes long — long enough that a position in the middle of a book is
unambiguously in the middle, which a twenty-second book is not.

| Book | Files | Cover | Tags |
|---|---|---|---|
| The Lighthouse Keeper | 1 | on disk and embedded | title, author, narrator, series, year, genre |
| Three Short Nights | 3 | on disk | title, author, album, track numbers |
| The Unmarked Box | 1 | none | title only |

Two accounts, both ordinary users:

| Account | Download | For |
|---|---|---|
| `dueback-test` | **on** | everything in `verify.sh` |
| `dueback-nodl` | **off** | the permission gate |

Plus `root`, which `seed.sh` uses for setup and nothing else. `verify.sh`
never touches it: an endpoint that works for an admin and not for a normal
user is a bug the harness has to be able to see.

## What verify.sh proves

44 checks, all green against **Audiobookshelf 2.37.1**, run entirely as
`dueback-test`:

- `POST /login` returns an access token.
- `GET /api/me` — a normal user, with download permission.
- The server version, and which path reports it.
- `GET /api/libraries` finds Test Shelf; `GET /api/libraries/:id/items`
  returns all three books by title.
- `GET /api/items/:id?expanded=1` carries the ID3 tags through — author and
  series come from the file, not from a lookup. Saved whole as
  `sample-item.json`.
- `GET /api/items/:id/file/:ino/download` with `Range: bytes=0-1023` answers
  **206** with a `Content-Range`, which is what makes a resumable download
  possible.
- `POST /api/items/:id/play` returns a session with `audioTracks` and a
  direct-play method; `/sync` and `/close` both succeed.
- `PATCH /api/me/progress/:itemId` moves `currentTime` and `lastUpdate`, and
  `isFinished: true` sets `finishedAt`.

Each run leaves progress back at zero, so the second run starts where the
first one did.

`sample-item.json` is committed. It is the shape the client will be written
against, and reading it beats guessing: chapters, `libraryFiles` with their
`ino`, `media.audioFiles[].mimeType`, and the metadata block with both
`authors` and the flattened `authorName`.

## Three things the server does that you would not guess

**`PATCH /api/me/progress/:itemId` ignores `progress`.** It takes
`currentTime` and `isFinished` and leaves `progress` exactly where the last
playback session put it — sending the field, sending it alone, or sending
nothing all do the same thing. `currentTime` is the field a client owns;
`progress` is the server's own bookkeeping. `verify.sh` asserts this, so a
future version that starts honouring it shows up as a failure rather than as
a quiet change in what sync means.

**A book is finished when little enough is left of it.** Setting
`currentTime` near the end flips `isFinished` and `finishedAt` on its own.
This is why the generated books are minutes long rather than seconds: on a
twenty-second book that rule covers most of the book, and a progress test at
the halfway mark fails for reasons that have nothing to do with the client.

**`/api/status` does not exist — it is `/status`.** `verify.sh` tries the
first, falls back to the second, and prints which one answered.

## Git Bash

Two conversions bite here, in opposite directions, and both cost an hour.

Git Bash rewrites Unix-looking arguments and environment values into Windows
paths on the way into a native binary. That is *wanted* nearly everywhere —
`curl -o /dev/null` only works because it becomes `NUL`, and ffmpeg only
finds its files because `/c/Users` becomes `C:/Users`. So the harness does
not set `MSYS_NO_PATHCONV` globally, and neither should you.

The exception is the one path that belongs to the *container*, not the host:
`/audiobooks`. Left alone it arrives at the server as
`/app/C:/Program Files/Git/audiobooks`, which scans cleanly and finds
nothing — a failure that looks exactly like a broken mount. `seed.sh` sets
`MSYS_NO_PATHCONV=1` on that one call.

The other is that `$(…)` is a subshell, so a variable set inside one does not
come back. Request status goes through a file, read with `abs_code`.

## The files

| | |
|---|---|
| `docker-compose.yml` | the server, pinned to a version |
| `lib.sh` | env loading, JSON without jq, the HTTP helpers |
| `seed.sh` | setup, as admin, idempotent |
| `verify.sh` | the checks, as a normal user |
| `sample-item.json` | a real expanded item, committed |
| `.env` | URL and logins — **git-ignored** |
| `data/` | library, database, cached covers — **git-ignored** |

No credentials appear in any committed file, in any script's output, or in
any process argument list. Passwords travel from `.env` into a request body
through a pipe; the scripts print neither them nor the tokens they get back.
