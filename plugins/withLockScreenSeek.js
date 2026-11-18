/**
 * Makes the lock screen's skip buttons work, and makes them jump a minute.
 *
 * Two separate faults in expo-audio 57, both in Kotlin we do not own:
 *
 * 1. **The buttons do nothing.** `AudioControlsService` builds them with
 *    `setSessionCommand(SessionCommand(ACTION_SEEK_FORWARD, …))` — a *custom*
 *    command rather than a player command — and the handler then returns
 *    `super.onCustomCommand(…)`, which is `RESULT_ERROR_NOT_SUPPORTED`. A
 *    controller told the command is unsupported is entitled to ignore the
 *    button, and Android's media controls do. Wiring them to
 *    `COMMAND_SEEK_BACK` / `COMMAND_SEEK_FORWARD` instead hands the job to
 *    media3, which implements it against the increments the player was built
 *    with and needs no cooperation from anyone.
 *
 * 2. **Ten seconds is the wrong jump for an audiobook.** Ten seconds is a
 *    music interval; a listener who looks away from a novel has lost a
 *    paragraph, not a bar. `SEEK_JUMP_INTERVAL_MS` and `SEEK_INTERVAL_MS` are
 *    both hardcoded, so both move to a minute, and the `_10` icons — which
 *    draw the number — become the plain ones.
 *
 * 3. **And none of it reached the app at first.** expo-audio ships a prebuilt
 *    AAR, declared as a `publication` in its `expo-module.config.json`, so
 *    autolinking linked that and never compiled the Kotlin being patched here.
 *    The patch applied, every assertion passed, and the lock screen was
 *    unchanged. `buildFromSource: ["expo-audio"]` in package.json is what
 *    makes the source the thing that gets built, and
 *    `assertBuiltFromSource` below refuses to run without it.
 *
 * ## Why a plugin and not patch-package
 *
 * patch-package would be the conventional answer and needs a `postinstall`
 * hook to apply itself. A prebuild plugin needs nothing: `android/` is
 * generated here and never committed, so prebuild runs before every native
 * build, locally and on EAS alike. The edits are therefore applied exactly
 * when they can matter, and `npm ci` wiping node_modules cannot leave a build
 * half-patched.
 *
 * The cost is that this writes into `node_modules`, which is nobody's idea of
 * tidy. It is made safe by being exact: every rewrite below is a literal
 * string that must be found. A match that goes missing — because expo-audio
 * was upgraded and fixed it, or moved it — **fails the build** rather than
 * quietly producing an app whose lock screen is subtly wrong again. That
 * failure is the point. Delete this plugin the day expo-audio takes an
 * interval option, and check `SEEK` in its CHANGELOG on every upgrade.
 */

const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

/** How far the lock screen's buttons move, in milliseconds. */
const JUMP_MS = 60000;

const KOTLIN_ROOT = path.join(
  'node_modules',
  'expo-audio',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'audio',
);

/**
 * Every rewrite, as `[file, [[find, replace], …]]`.
 *
 * Written as whole lines including their indentation so a match cannot
 * accidentally land somewhere else in the file.
 */
const REWRITES = [
  [
    path.join(KOTLIN_ROOT, 'AudioPlayer.kt'),
    [
      // The increments media3 uses for seekBack()/seekForward().
      [
        'private const val SEEK_JUMP_INTERVAL_MS: Long = 10_000',
        `private const val SEEK_JUMP_INTERVAL_MS: Long = ${JUMP_MS}`,
      ],
    ],
  ],
  [
    path.join(KOTLIN_ROOT, 'service', 'AudioControlsService.kt'),
    [
      // The interval the pre-Android-13 notification actions use.
      ['const val SEEK_INTERVAL_MS = 10000L', `const val SEEK_INTERVAL_MS = ${JUMP_MS}L`],
      // Back: a player command, and an icon without a number on it.
      [
        `        CommandButton.Builder(CommandButton.ICON_SKIP_BACK_10)
          .setDisplayName("Seek Backward")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_SEEK_BACKWARD, Bundle.EMPTY))`,
        `        CommandButton.Builder(CommandButton.ICON_SKIP_BACK)
          .setDisplayName("Seek Backward")
          .setEnabled(true)
          .setPlayerCommand(Player.COMMAND_SEEK_BACK)`,
      ],
      // Forward: the same.
      [
        `        CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_10)
          .setDisplayName("Seek Forward")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_SEEK_FORWARD, Bundle.EMPTY))`,
        `        CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD)
          .setDisplayName("Seek Forward")
          .setEnabled(true)
          .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)`,
      ],
    ],
  ],
  [
    path.join(KOTLIN_ROOT, 'service', 'AudioMediaSessionCallback.kt'),
    [
      /*
       * The custom-command path stays, because the pre-Android-13
       * notification still fires it through a pending intent — but it now
       * goes through the player's own seek, so one increment governs both
       * paths, and it reports success instead of "not supported".
       */
      [
        `      AudioControlsService.ACTION_SEEK_FORWARD -> {
        session.player.seekTo(session.player.currentPosition + AudioControlsService.SEEK_INTERVAL_MS)
      }
      AudioControlsService.ACTION_SEEK_BACKWARD -> {
        session.player.seekTo(session.player.currentPosition - AudioControlsService.SEEK_INTERVAL_MS)
      }
    }
    return super.onCustomCommand(session, controller, command, args)`,
        `      AudioControlsService.ACTION_SEEK_FORWARD -> {
        session.player.seekForward()
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      AudioControlsService.ACTION_SEEK_BACKWARD -> {
        session.player.seekBack()
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
    }
    return super.onCustomCommand(session, controller, command, args)`,
      ],
      // `Futures` is not imported in the original, which only ever returned
      // `super`'s future.
      [
        'import com.google.common.util.concurrent.ListenableFuture',
        `import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture`,
      ],
    ],
  ],
];

/**
 * Refuses to run unless Gradle will actually compile what we are about to
 * patch.
 *
 * The failure this exists to prevent already happened. expo-audio ships a
 * **prebuilt AAR** — its `expo-module.config.json` carries a `publication`
 * block pointing at `local-maven-repo` — so autolinking links that artifact
 * and never compiles `android/src/main/java` at all. Every rewrite below
 * applied cleanly, every assertion passed, the patched Kotlin sat in
 * node_modules looking exactly right, and the lock screen kept its
 * ten-second buttons. Nothing anywhere said why.
 *
 * `buildFromSource` in package.json is what makes the source the thing that
 * gets built. Patching without it is worse than doing nothing, because it
 * looks like it worked.
 */
function assertBuiltFromSource(root) {
  const manifest = path.join(root, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (error) {
    throw new Error(`[withLockScreenSeek] could not read package.json: ${error.message}`);
  }

  const autolinking = pkg.expo?.autolinking ?? {};
  const lists = [autolinking.buildFromSource, autolinking.android?.buildFromSource];
  const patterns = lists.filter(Array.isArray).flat();
  const covered = patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test('expo-audio');
    } catch {
      return false;
    }
  });

  if (!covered) {
    throw new Error(
      '[withLockScreenSeek] expo-audio is not set to build from source, so the ' +
        'Kotlin this plugin patches is never compiled — Gradle links the ' +
        'prebuilt AAR from its local-maven-repo instead, and the patch has no ' +
        'effect whatsoever. Add to package.json: "expo": { "autolinking": ' +
        '{ "android": { "buildFromSource": ["expo-audio"] } } }. ' +
        'Do not remove this check: without it the patch silently does nothing ' +
        'and the only symptom is a lock screen that still jumps ten seconds.',
    );
  }
}

const withLockScreenSeek = (config) =>
  withDangerousMod(config, [
    'android',
    (modConfig) => {
      const root = modConfig.modRequest.projectRoot;
      assertBuiltFromSource(root);

      for (const [relative, pairs] of REWRITES) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) {
          throw new Error(
            `[withLockScreenSeek] ${relative} is gone. expo-audio has been ` +
              'restructured; re-check the lock-screen seek fix against the new ' +
              'source and update or delete plugins/withLockScreenSeek.js.',
          );
        }

        let source = fs.readFileSync(file, 'utf8');
        // The patterns are written with \n; a checkout could hand us \r\n.
        const crlf = source.includes('\r\n');
        if (crlf) source = source.replace(/\r\n/g, '\n');
        let changed = false;

        for (const [find, replace] of pairs) {
          if (source.includes(replace)) continue; // Already applied.
          if (!source.includes(find)) {
            throw new Error(
              `[withLockScreenSeek] could not find this in ${relative}:\n\n` +
                `${find}\n\n` +
                'Either expo-audio changed it or the fix has landed upstream. ' +
                'Verify the lock-screen buttons against the current source and ' +
                'update plugins/withLockScreenSeek.js — do not just delete this ' +
                'check, or the buttons go back to doing nothing silently.',
            );
          }
          source = source.replace(find, replace);
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(file, crlf ? source.replace(/\n/g, '\r\n') : source, 'utf8');
          console.log(`[withLockScreenSeek] rewrote ${relative}`);
        }
      }

      return modConfig;
    },
  ]);

module.exports = withLockScreenSeek;
