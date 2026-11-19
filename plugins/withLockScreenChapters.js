/**
 * Puts next- and previous-chapter buttons on the lock screen.
 *
 * expo-audio 57 removes track navigation from the media session outright —
 * `AudioMediaSessionCallback.onConnect` strips `COMMAND_SEEK_TO_NEXT`,
 * `COMMAND_SEEK_TO_PREVIOUS` and both `*_MEDIA_ITEM` variants — and it is
 * right to, because for expo-audio there is nothing to navigate to. The module
 * has no concept of a chapter.
 *
 * ## Why the press is forwarded instead of handled
 *
 * The obvious implementation is to make these player commands and let media3
 * do the work. It cannot, for two reasons that are both about this app rather
 * than about media3:
 *
 * 1. **A chapter is not a media item.** The engine plays a book as *one*
 *    `AudioPlayer` holding one file at a time (`src/lib/audio/engine.ts` says
 *    why: `setActiveForLockScreen` exists only on `AudioPlayer`, and without
 *    it Android stops background audio after about three minutes). So the
 *    ExoPlayer timeline is a single item and `seekToNext()` has nowhere to go.
 * 2. **A chapter boundary can be in a different file.** Chapters live on the
 *    whole-book timeline and parts are switched with `replace()` + `seekTo()`
 *    from JavaScript. Carrying out a cross-part jump in Kotlin would mean
 *    reimplementing part switching there, in a second place, against the same
 *    files.
 *
 * So these are custom session commands, and pressing one **broadcasts to the
 * app**, which owns the timeline and seeks. That is the same division
 * `modules/dueback-audio` already makes for the headphone-unplug receiver:
 * "the receiver only tells JavaScript; pausing is the player's business".
 *
 * The app's half is `DuebackAudioModule`, which has no compile-time
 * relationship with expo-audio and must not grow one. A broadcast is how two
 * modules that do not know about each other talk; `assertAppHalfPresent`
 * below fails the build if the action strings have drifted apart, because the
 * symptom otherwise is a button that does nothing, which is exactly the fault
 * `withLockScreenSeek` was written to fix.
 *
 * ## Whether the buttons appear
 *
 * Only when the book has chapters. A single-file book with no embedded
 * chapters has none at all, and a dead button is worse than no button. That
 * travels as a new field on `AudioLockScreenOptions`, which the app sets once
 * per book when it claims the lock screen — so the gate is decided exactly
 * where the session is built, with no extra state to keep in step.
 *
 * ## What this does not do
 *
 * Both halves of the layout are patched: the media3 session buttons used from
 * Android 13, and the explicit notification actions used on Android 12 and
 * below. The chapter buttons are deliberately kept out of the **compact**
 * notification view in the older path, which holds three at most and should
 * keep the ones somebody uses while walking.
 *
 * See `plugins/withLockScreenSeek.js` for why this is a prebuild plugin rather
 * than patch-package, and for what `buildFromSource` has to do with any of it.
 * The two plugins patch the same three files and are written to be
 * order-independent: every anchor here is text the other one does not touch.
 */

const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

/**
 * The broadcast the patched service sends and the app's own module receives.
 *
 * Duplicated in `DuebackAudioModule.kt` of necessity — the two sides share no
 * code — and checked below, so drift fails the build instead of the button.
 */
const BROADCAST_ACTION = 'dueback.audio.action.CHAPTER_SKIP';
const DIRECTION_EXTRA = 'direction';

const AUDIO_ROOT = path.join(
  'node_modules', 'expo-audio', 'android', 'src', 'main', 'java', 'expo', 'modules', 'audio',
);
const APP_MODULE = path.join(
  'modules', 'dueback-audio', 'android', 'src', 'main', 'java', 'expo', 'modules',
  'duebackaudio', 'DuebackAudioModule.kt',
);

/**
 * Every rewrite, as `[file, [[find, replace, expectedCount], …]]`.
 *
 * `expectedCount` defaults to 1 and every occurrence is replaced, so a match
 * that appears twice when one was expected fails rather than being half
 * applied.
 */
const REWRITES = [
  [
    path.join(AUDIO_ROOT, 'AudioRecords.kt'),
    [
      [
        `class AudioLockScreenOptions(
  @Field val showSeekForward: Boolean,
  @Field val showSeekBackward: Boolean,
  @Field val isLiveStream: Boolean? = null
) : Record`,
        `class AudioLockScreenOptions(
  @Field val showSeekForward: Boolean,
  @Field val showSeekBackward: Boolean,
  @Field val isLiveStream: Boolean? = null,
  // plugins/withLockScreenChapters.js. Defaults false, so anything that does
  // not know about chapters gets exactly the layout it got before.
  @Field val showChapterButtons: Boolean = false
) : Record`,
      ],
    ],
  ],
  [
    path.join(AUDIO_ROOT, 'service', 'AudioControlsService.kt'),
    [
      // The actions, and the one place that sends the broadcast.
      [
        `    const val ACTION_SEEK_FORWARD = "expo.modules.audio.action.SEEK_FORWARD"
    const val ACTION_SEEK_BACKWARD = "expo.modules.audio.action.SEEK_BACKWARD"`,
        `    const val ACTION_SEEK_FORWARD = "expo.modules.audio.action.SEEK_FORWARD"
    const val ACTION_SEEK_BACKWARD = "expo.modules.audio.action.SEEK_BACKWARD"

    /*
     * Chapter navigation — plugins/withLockScreenChapters.js.
     *
     * Nothing here carries the jump out. A chapter boundary is on the
     * whole-book timeline and may sit in a different file from the one
     * playing, and switching files belongs to the app. The press is passed on
     * and the app seeks; see modules/dueback-audio.
     */
    const val ACTION_PREVIOUS_CHAPTER = "expo.modules.audio.action.PREVIOUS_CHAPTER"
    const val ACTION_NEXT_CHAPTER = "expo.modules.audio.action.NEXT_CHAPTER"
    const val BROADCAST_CHAPTER_SKIP = "${BROADCAST_ACTION}"
    const val EXTRA_CHAPTER_DIRECTION = "${DIRECTION_EXTRA}"

    fun broadcastChapterSkip(context: Context, direction: Int) {
      try {
        context.sendBroadcast(
          Intent(BROADCAST_CHAPTER_SKIP)
            // Addressed to this app. An implicit broadcast is visible to
            // everything on the device and is refused outright on newer
            // Android, and this is a button press, not an announcement.
            .setPackage(context.packageName)
            .putExtra(EXTRA_CHAPTER_DIRECTION, direction)
        )
      } catch (_: Throwable) {
        // A press that cannot be delivered is a press that does nothing. It
        // must not take the playback service down with it.
      }
    }`,
      ],
      /*
       * The Android 12 and below path: the notification's own actions arrive
       * as service intents. Anchored on the name `SEEK_INTERVAL_MS` rather
       * than its value, which `withLockScreenSeek` rewrites.
       */
      [
        `        ACTION_SEEK_FORWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition + SEEK_INTERVAL_MS)`,
        `        ACTION_PREVIOUS_CHAPTER -> broadcastChapterSkip(this@AudioControlsService, -1)
        ACTION_NEXT_CHAPTER -> broadcastChapterSkip(this@AudioControlsService, 1)
        ACTION_SEEK_FORWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition + SEEK_INTERVAL_MS)`,
      ],
      // Previous chapter, first in the session layout.
      [
        `    val mediaButtons = mutableListOf<CommandButton>()`,
        `    val mediaButtons = mutableListOf<CommandButton>()

    /*
     * Previous chapter. A *secondary* slot, so the minute-seek buttons keep
     * the places they already have — those were hard enough to get working —
     * and this appears beside them wherever the controller has room.
     */
    if (currentOptions?.showChapterButtons == true) {
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_PREVIOUS)
          .setDisplayName("Previous Chapter")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_PREVIOUS_CHAPTER, Bundle.EMPTY))
          .setSlots(CommandButton.SLOT_BACK_SECONDARY)
          .build()
      )
    }`,
      ],
      // Next chapter, added last so it falls after the forward seek.
      [
        `    session.setCustomLayout(mediaButtons)`,
        `    if (currentOptions?.showChapterButtons == true) {
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_NEXT)
          .setDisplayName("Next Chapter")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_NEXT_CHAPTER, Bundle.EMPTY))
          .setSlots(CommandButton.SLOT_FORWARD_SECONDARY)
          .build()
      )
    }

    session.setCustomLayout(mediaButtons)`,
      ],
      /*
       * The older notification's actions. Previous chapter goes first and
       * does bump `currentIndex`, because the blocks after it use that index
       * to decide what the compact view shows.
       */
      [
        `      if (currentOptions?.showSeekBackward == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_skip_back,`,
        `      if (currentOptions?.showChapterButtons == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_previous,
            "Previous Chapter",
            buildActionPendingIntent(ACTION_PREVIOUS_CHAPTER)
          )
        )
        // Deliberately not offered to the compact view, which holds three
        // buttons and should keep seek, play and seek.
        currentIndex++
      }

      if (currentOptions?.showSeekBackward == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_skip_back,`,
      ],
      // Next chapter last, so it needs no index at all: nothing reads one
      // after this point.
      [
        `        compactViewIndices.add(currentIndex)
      }

      style.setShowActionsInCompactView(*compactViewIndices.toIntArray())`,
        `        compactViewIndices.add(currentIndex)
      }

      if (currentOptions?.showChapterButtons == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_next,
            "Next Chapter",
            buildActionPendingIntent(ACTION_NEXT_CHAPTER)
          )
        )
      }

      style.setShowActionsInCompactView(*compactViewIndices.toIntArray())`,
      ],
      // The callback needs a Context to broadcast from, and the service is
      // one. Both construction sites, inside coroutine lambdas where a bare
      // `this` is the scope.
      [
        `          .setCallback(AudioMediaSessionCallback())`,
        `          .setCallback(AudioMediaSessionCallback(this@AudioControlsService))`,
        2,
      ],
    ],
  ],
  [
    path.join(AUDIO_ROOT, 'service', 'AudioMediaSessionCallback.kt'),
    [
      ['import android.os.Bundle', 'import android.content.Context\nimport android.os.Bundle'],
      [
        'class AudioMediaSessionCallback : MediaSession.Callback {',
        'class AudioMediaSessionCallback(private val context: Context) : MediaSession.Callback {',
      ],
      /*
       * `onConnect` strips every track-navigation command and then the
       * session advertises only the two seek actions. The chapter actions are
       * added here; without this a controller is told they are unsupported
       * and is entitled to ignore the buttons, which is the precise fault
       * `withLockScreenSeek` exists to fix. Do not remove one without the
       * other.
       */
      [
        `            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))
            .build()`,
        `            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_PREVIOUS_CHAPTER, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_NEXT_CHAPTER, Bundle.EMPTY))
            .build()`,
      ],
      [
        `    when (command.customAction) {`,
        `    when (command.customAction) {
      /*
       * Forwarded, not carried out — see plugins/withLockScreenChapters.js.
       * Reporting RESULT_SUCCESS matters: a controller told a command failed
       * is entitled to stop drawing the button that sends it.
       */
      AudioControlsService.ACTION_PREVIOUS_CHAPTER -> {
        AudioControlsService.broadcastChapterSkip(context, -1)
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      AudioControlsService.ACTION_NEXT_CHAPTER -> {
        AudioControlsService.broadcastChapterSkip(context, 1)
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }`,
      ],
    ],
  ],
];

/**
 * `Futures` is imported by `withLockScreenSeek` as well, and whichever plugin
 * runs first should add it. Written as its own step so neither depends on the
 * other having run.
 */
const ENSURE_IMPORT = [
  path.join(AUDIO_ROOT, 'service', 'AudioMediaSessionCallback.kt'),
  'import com.google.common.util.concurrent.Futures',
  'import com.google.common.util.concurrent.ListenableFuture',
];

/**
 * The app's half has to be listening for the broadcast this sends.
 *
 * The two sides share no code — that is the point of using a broadcast — so
 * nothing but a check like this would notice the strings drifting apart. The
 * failure it prevents is silent: a button that is drawn, is pressed, reports
 * success, and does nothing.
 */
function assertAppHalfPresent(root) {
  const file = path.join(root, APP_MODULE);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `[withLockScreenChapters] ${APP_MODULE} is missing. That module is the ` +
        'other half of this feature: it receives the broadcast these buttons ' +
        'send and tells JavaScript, which does the seeking. Without it the ' +
        'chapter buttons appear and do nothing.',
    );
  }

  for (const needed of [BROADCAST_ACTION, DIRECTION_EXTRA]) {
    if (!source.includes(needed)) {
      throw new Error(
        `[withLockScreenChapters] ${APP_MODULE} does not mention "${needed}". ` +
          'The patched lock-screen buttons broadcast it and that module is ' +
          'what listens; if the two strings have drifted apart, the buttons ' +
          'are drawn, report success and do nothing. Make them match rather ' +
          'than deleting this check.',
      );
    }
  }
}

/** See `withLockScreenSeek.js`: patching a prebuilt AAR achieves nothing. */
function assertBuiltFromSource(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const autolinking = pkg.expo?.autolinking ?? {};
  const patterns = [autolinking.buildFromSource, autolinking.android?.buildFromSource]
    .filter(Array.isArray)
    .flat();
  const covered = patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test('expo-audio');
    } catch {
      return false;
    }
  });
  if (!covered) {
    throw new Error(
      '[withLockScreenChapters] expo-audio is not set to build from source, so ' +
        'the Kotlin this patches is never compiled — Gradle links the prebuilt ' +
        'AAR instead and the patch has no effect at all. Add to package.json: ' +
        '"expo": { "autolinking": { "android": { "buildFromSource": ' +
        '["expo-audio"] } } }.',
    );
  }
}

const withLockScreenChapters = (config) =>
  withDangerousMod(config, [
    'android',
    (modConfig) => {
      const root = modConfig.modRequest.projectRoot;
      assertBuiltFromSource(root);
      assertAppHalfPresent(root);

      const [importFile, importLine, importAnchor] = ENSURE_IMPORT;
      const steps = [...REWRITES, [importFile, [[importAnchor, `${importLine}\n${importAnchor}`]]]];

      for (const [relative, pairs] of steps) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) {
          throw new Error(
            `[withLockScreenChapters] ${relative} is gone. expo-audio has been ` +
              'restructured; re-check the chapter buttons against the new source ' +
              'and update or delete plugins/withLockScreenChapters.js.',
          );
        }

        let source = fs.readFileSync(file, 'utf8');
        // The patterns are written with \n; a checkout could hand us \r\n.
        const crlf = source.includes('\r\n');
        if (crlf) source = source.replace(/\r\n/g, '\n');
        let changed = false;

        for (const [find, replace, expected = 1] of pairs) {
          // Already applied — this runs again on every prebuild.
          if (source.includes(replace)) continue;

          const found = source.split(find).length - 1;
          if (found !== expected) {
            throw new Error(
              `[withLockScreenChapters] expected ${expected} occurrence(s) of ` +
                `this in ${relative} and found ${found}:\n\n${find}\n\n` +
                'Either expo-audio changed it or the feature has landed upstream. ' +
                'Check the lock-screen chapter buttons against the current source ' +
                'and update plugins/withLockScreenChapters.js — do not just delete ' +
                'the check, or the buttons go back to doing nothing silently.',
            );
          }
          // Every occurrence, so a count of 2 cannot be half applied.
          source = source.split(find).join(replace);
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(file, crlf ? source.replace(/\n/g, '\r\n') : source, 'utf8');
          console.log(`[withLockScreenChapters] rewrote ${relative}`);
        }
      }

      return modConfig;
    },
  ]);

module.exports = withLockScreenChapters;
