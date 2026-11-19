/**
 * Makes playback ask for audio focus however it was started.
 *
 * **Found on a phone, by tracing the audio focus stack.** After a pause and
 * then a resume *from the media keys*, the session reported playing while the
 * focus stack was empty, and it stayed that way through backgrounding and a
 * relaunch. Resuming with the app's own Play button reacquired focus
 * correctly. That difference is the whole bug.
 *
 * ## Why one path had focus and the other did not
 *
 * expo-audio builds its ExoPlayer with focus handling **off**:
 *
 *     .setAudioAttributes(AudioAttributes.DEFAULT, false)
 *
 * and does it by hand instead — but only inside the JavaScript-callable
 * `play()` function, which is the path the app's own button takes. A media
 * key, a lock-screen button, a headset or a car goes
 * `MediaSessionLegacyStub.onPlay` → the session's player →
 * `ExoPlayer.play()`, straight past the one line that asks.
 *
 * Playing without focus is not cosmetic: nothing ducks for a navigation
 * prompt, nothing pauses when another app starts, and two things talk over
 * each other. Android never complains, which is why this needed a trace to
 * find.
 *
 * ## Why the fix is not `handleAudioFocus = true`
 *
 * That was the obvious answer and it is wrong here. expo-audio's own focus
 * handling is better than the stock one for this app: it honours
 * `interruptionMode` (do-not-mix, duck-others, mix-with-others), it ducks to
 * half volume rather than pausing when that is what was asked for, it
 * restores the previous volume on regaining focus, and it only resumes
 * players it actually paused. Handing focus to media3's `AudioFocusManager`
 * would throw all of that away to fix a path that was simply never wired.
 *
 * ## The fix
 *
 * `AudioModule` already has the hook. Every player reports play-state changes
 * to it — `BaseAudioPlayer.installPlayerListeners` invokes
 * `onPlaybackStateChange` from `Player.Listener.onIsPlayingChanged`, so it
 * fires when playback *actually starts*, whatever caused it — and the module
 * was using that to **release** focus and never to take it. So this adds the
 * symmetric half.
 *
 * Catching it at "the player started playing" rather than at each entry point
 * is deliberate: it covers the media keys, the lock screen, Bluetooth, a car,
 * and any route that does not exist yet, without this plugin having to know
 * about any of them.
 *
 * Delete this the day expo-audio requests focus on its own; the matches below
 * will fail loudly if it changes how any of it works.
 */

const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const MODULE = path.join(
  'node_modules', 'expo-audio', 'android', 'src', 'main', 'java', 'expo', 'modules',
  'audio', 'AudioModule.kt',
);

/**
 * The same shape in two places — one for a player, one for a playlist.
 *
 * Both are patched although this app only ever makes players
 * (`src/lib/audio/engine.ts` says why: `setActiveForLockScreen` exists only
 * on `AudioPlayer`). Leaving the playlist half wrong would be leaving a
 * second copy of a bug that has already cost a device session to find.
 */
const REWRITES = [
  [
    `          player.onPlaybackStateChange = { isPlaying ->
            if (!isPlaying && shouldReleaseFocus()) {
              releaseAudioFocus()
            }
          }`,
    `          player.onPlaybackStateChange = { isPlaying ->
            /*
             * plugins/withAudioFocus.js — the half that was missing.
             *
             * Focus was taken only by the JavaScript \`play()\`, so resuming
             * from the media keys or the lock screen played with an empty
             * focus stack. This fires whenever the player actually starts,
             * whatever started it.
             */
            if (isPlaying) {
              if (!focusAcquired) {
                requestAudioFocus()
              }
            } else if (shouldReleaseFocus()) {
              releaseAudioFocus()
            }
          }`,
  ],
  [
    `          playlist.onPlaybackStateChange = { isPlaying ->
            if (!isPlaying && shouldReleaseFocus()) {
              releaseAudioFocus()
            }
          }`,
    `          playlist.onPlaybackStateChange = { isPlaying ->
            // plugins/withAudioFocus.js — see the player above.
            if (isPlaying) {
              if (!focusAcquired) {
                requestAudioFocus()
              }
            } else if (shouldReleaseFocus()) {
              releaseAudioFocus()
            }
          }`,
  ],
];

const withAudioFocus = (config) =>
  withDangerousMod(config, [
    'android',
    (modConfig) => {
      const root = modConfig.modRequest.projectRoot;
      const file = path.join(root, MODULE);

      if (!fs.existsSync(file)) {
        throw new Error(
          `[withAudioFocus] ${MODULE} is gone. expo-audio has been restructured; ` +
            're-check whether playback still starts without audio focus from the ' +
            'media keys, and update or delete plugins/withAudioFocus.js.',
        );
      }

      let source = fs.readFileSync(file, 'utf8');
      const crlf = source.includes('\r\n');
      if (crlf) source = source.replace(/\r\n/g, '\n');
      let changed = false;

      for (const [find, replace] of REWRITES) {
        if (source.includes(replace)) continue; // Already applied.
        const found = source.split(find).length - 1;
        if (found !== 1) {
          throw new Error(
            `[withAudioFocus] expected one occurrence of this in ${MODULE} and ` +
              `found ${found}:\n\n${find}\n\n` +
              'Either expo-audio changed how focus is handled or it has started ' +
              'requesting focus itself. Check with a real pause-and-resume from ' +
              'the lock screen before deleting this plugin — the symptom is ' +
              'silent, and Android reports nothing when an app plays without ' +
              'focus.',
          );
        }
        source = source.replace(find, replace);
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(file, crlf ? source.replace(/\n/g, '\r\n') : source, 'utf8');
        console.log(`[withAudioFocus] rewrote ${MODULE}`);
      }

      return modConfig;
    },
  ]);

module.exports = withAudioFocus;
