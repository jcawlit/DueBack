# Due Back

Expo/React Native audiobook app. Preserve the existing mobile UI, performance,
and cross-platform behaviour.

## Start here

- `docs/STATE.md` says what is verified, what has never run on hardware, what
  is deliberately not fixed, and which traps have already cost a day. Read it
  before auditing anything or proposing a direction; it is the current list,
  where `CHANGES.md` is history.
- A fresh clone has no `android/` and no APK. Both are generated —
  `docs/STATE.md` says how.
- `npm test`, `npm run lint` and `npm run typecheck` run in CI on every push
  (`.github/workflows/ci.yml`). That is the whole automated suite: everything
  else is tested by hand on a Pixel with a real drive.

## Read only what the task needs

- Before debugging, query `npm run kb -- "specific phrase"`. With no arguments
  it lists headings; multiple terms match ANY term. Read relevant entries in
  `docs/KNOWLEDGE.md`, not the whole file.
- Search paths/symbols with `rg`; read bounded sections. Reuse unchanged files,
  docs and check results already in context. Summarize successful tool output;
  retain failure details. Expand investigation when evidence requires it.
- Keep new platform quirks and non-obvious invariants in the knowledge base;
  update/remove obsolete entries in the same change. Code comments state rules.
- Task scope comes from the current request. Preserve unrelated work. Prompt
  templates in `docs/AGENT-WORKFLOW.md` are optional, not required reading.

## API and dependency checks

- Before changing Expo/React Native/EAS API usage, read the installed versions
  in `package.json` and the relevant official docs. Expo SDK docs:
  `https://docs.expo.dev/versions/v<major>.0.0/`. Use
  `https://docs.expo.dev/llms.txt` to locate other Expo/EAS pages. Reuse docs
  already verified for that version during this task.
- Install dependencies with `npx expo install <package>`; prefer Expo modules
  and check applicable skills. Use `bunx` instead of `npx` if `bun.lock` exists.
- **Never run `expo install --fix` here**: it breaks dependency hoisting.
  See `npm run kb -- "expo install"`.

## Implementation and validation

- Expo Router routes belong in `src/app/`; non-route code belongs outside it.
  Import navigation helpers from `expo-router`.
- If native directories are absent, configure native changes through app config
  and plugins; never hand-create generated `ios/` or `android/` trees.
  New native modules require a development build, not Expo Go.
- Use EAS for cloud builds, signing, submission and OTA updates:
  `npx eas-cli@latest <command>` (`bunx eas-cli` with Bun).
- Before every commit: `npm test`, `npm run lint`, `npm run typecheck` must pass.
  Run lint and typecheck before declaring work done; run relevant tests for code
  changes. Re-run checks after relevant changes or failures, not repeatedly on
  unchanged code. Typecheck covers both app and tests.
- Report changes, verification, limitations and any required phone checks
  briefly. Device behaviour is verified only when actually tested on a device.
