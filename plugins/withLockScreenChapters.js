/**
 * Puts next- and previous-chapter buttons on the lock screen.
 *
 * expo-audio 57 strips track navigation from the media session outright —
 * `AudioMediaSessionCallback.onConnect` removes `COMMAND_SEEK_TO_NEXT`,
 * `COMMAND_SEEK_TO_PREVIOUS` and both `*_MEDIA_ITEM` variants — and it is
 * right to, because for expo-audio there is nothing to navigate to. The module
 * has no concept of a chapter.
 *
 * ## Which slot, and why it took two attempts
 *
 * The first version put two `CommandButton`s in `SLOT_BACK_SECONDARY` and
 * `SLOT_FORWARD_SECONDARY`. Everything about it worked — built, advertised,
 * answered with `RESULT_SUCCESS`, verified in compiled bytecode — and
 * **nothing appeared on the lock screen.**
 *
 * `CommandButton.getCustomLayoutFromMediaButtonPreferences` builds the
 * platform session's custom actions from exactly three things: the first
 * button whose slots include `SLOT_BACK`, the first whose slots include
 * `SLOT_FORWARD`, and everything in `SLOT_OVERFLOW`. **Slots 4 and 5 are
 * never placed.** Those buttons did not reach the platform session at all,
 * and nothing anywhere says so.
 *
 * Back and forward are taken, by the minute-seek buttons, which work and are
 * wanted. The same method also sets
 * `ALWAYS_RESERVE_SPACE_FOR.ACTION_SKIP_TO_PREVIOUS` to
 * `!containsButtonForSlot(layout, SLOT_BACK)` — so while a custom button sits
 * in that slot, Android is told explicitly *not* to keep room for a
 * skip-to-previous control. There is no arrangement that shows seek and skip
 * in those two positions at once; it is one pair or the other.
 *
 * So the chapter buttons go in the **overflow**, which Android draws when the
 * surface has room and omits when it does not. They carry a *player* command
 * rather than a custom session command, which means a press arrives as
 * `seekToPrevious`/`seekToNext` on the session player — the same path a car
 * or a headset's skip button takes, and the same path that works whether or
 * not any button is drawn. One mechanism for all of it.
 *
 * `MediaSessionLegacyStub.onSkipToNext` checks
 * `isCommandAvailable(COMMAND_SEEK_TO_NEXT)` and, if it is, calls
 * `player.seekToNext()` on the **session's** player. That is the hook. The
 * session player is already a `ForwardingPlayer` chain
 * (`MetadataInjectingPlayer` over `resolveSessionPlayer`), so one more layer
 * overrides `seekToNext` and `seekToPrevious` without the real ExoPlayer ever
 * seeing them.
 *
 * ## Why the press is forwarded instead of handled
 *
 * That override does not seek. It broadcasts, and the app seeks, for two
 * reasons that are about this app rather than about media3:
 *
 * 1. **A chapter is not a media item.** The engine plays a book as *one*
 *    `AudioPlayer` holding one file at a time (`src/lib/audio/engine.ts` says
 *    why: `setActiveForLockScreen` exists only on `AudioPlayer`, and without
 *    it Android stops background audio after about three minutes). So the
 *    ExoPlayer timeline is a single item and a real `seekToNext()` has
 *    nowhere to go.
 * 2. **A chapter boundary can be in a different file.** Chapters live on the
 *    whole-book timeline and parts are switched with `replace()` + `seekTo()`
 *    from JavaScript. Carrying out a cross-part jump in Kotlin would mean
 *    reimplementing part switching there, in a second place, against the same
 *    files.
 *
 * So the press becomes an in-app broadcast. That is the same division
 * `modules/dueback-audio` already makes for the headphone-unplug receiver:
 * "the receiver only tells JavaScript; pausing is the player's business".
 *
 * The app's half is `DuebackAudioModule`, which has no compile-time
 * relationship with expo-audio and must not grow one. A broadcast is how two
 * modules that do not know about each other talk; `assertAppHalfPresent`
 * below fails the build if the action strings have drifted apart, because the
 * symptom otherwise is a button that does nothing.
 *
 * ## Whether the buttons appear
 *
 * Only when the book has chapters. A single-file book with no embedded
 * chapters has none, and a dead button is worse than no button. That travels
 * as a new field on `AudioLockScreenOptions`, set once per book when the app
 * claims the lock screen — and the gate is the forwarding player's
 * `getAvailableCommands`, because that is what Android reads when it decides
 * whether to draw a skip button at all.
 *
 * On Android 12 and below the notification carries explicit actions instead,
 * so those are patched too, and kept out of the three-button compact view.
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
     *
     * The two ACTION_ strings are for the Android 12 and below notification,
     * whose buttons are pending intents to this service. From Android 13 the
     * presses arrive as seekToNext/seekToPrevious on the session player.
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
      /*
       * The hook. `onSkipToNext` on the platform session calls `seekToNext()`
       * on this player, so one forwarding layer turns a skip into a chapter
       * jump without the real ExoPlayer — which holds a single file and has
       * no next item — ever being asked.
       *
       * `getAvailableCommands` is the gate as well as the hook: Android
       * decides whether to draw a skip button from the commands the player
       * reports, so a book with no chapters reports none and gets none.
       */
      [
        `  private fun resolveSessionPlayer(player: AudioPlayer, options: AudioLockScreenOptions?): Player {
    val isLive = options?.isLiveStream ?: player.isLive
    if (!isLive) {
      return player.ref
    }

    return object : ForwardingPlayer(player.ref) {
      override fun getAvailableCommands(): Player.Commands {
        return super.getAvailableCommands().buildUpon()
          .remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
          .build()
      }
    }
  }`,
        `  private fun resolveSessionPlayer(player: AudioPlayer, options: AudioLockScreenOptions?): Player {
    val isLive = options?.isLiveStream ?: player.isLive
    val chapters = options?.showChapterButtons == true
    if (!isLive && !chapters) {
      return player.ref
    }

    val service = this
    return object : ForwardingPlayer(player.ref) {
      override fun getAvailableCommands(): Player.Commands {
        val commands = super.getAvailableCommands().buildUpon()
        if (isLive) {
          commands.remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        }
        if (chapters) {
          // What makes the buttons exist. Android reads these to decide which
          // transport controls to draw, and skip has reserved space where a
          // custom button has to win a slot off something else.
          commands.add(Player.COMMAND_SEEK_TO_PREVIOUS)
          commands.add(Player.COMMAND_SEEK_TO_NEXT)
        }
        return commands.build()
      }

      /*
       * Forwarded to the app rather than seeked here, and not passed to
       * super: the real player holds one file and would either do nothing or
       * restart it. See plugins/withLockScreenChapters.js.
       */
      override fun seekToPrevious() {
        if (chapters) broadcastChapterSkip(service, -1) else super.seekToPrevious()
      }

      override fun seekToNext() {
        if (chapters) broadcastChapterSkip(service, 1) else super.seekToNext()
      }

      // The fallbacks a controller reaches for when the commands above are
      // not offered. Same destination, so a controller that picks either one
      // behaves the same way.
      override fun seekToPreviousMediaItem() {
        if (chapters) broadcastChapterSkip(service, -1) else super.seekToPreviousMediaItem()
      }

      override fun seekToNextMediaItem() {
        if (chapters) broadcastChapterSkip(service, 1) else super.seekToNextMediaItem()
      }
    }
  }`,
      ],
      /*
       * The buttons themselves, in the overflow.
       *
       * **Not** in `SLOT_BACK` or `SLOT_FORWARD`: those two hold the minute
       * seek buttons, which work and are wanted, and there is exactly one of
       * each. Not in `SLOT_BACK_SECONDARY`/`SLOT_FORWARD_SECONDARY` either —
       * that was the first attempt and it drew nothing, because
       * `CommandButton.getCustomLayoutFromMediaButtonPreferences` places one
       * back button, one forward button and the overflow, and **never looks
       * at slots 4 and 5 at all**.
       *
       * These carry a *player* command rather than a custom session command,
       * so a press lands on `seekToPrevious`/`seekToNext` of the forwarding
       * player below — the same path a car or a headset's skip button takes.
       * One mechanism, and the per-book gate comes free: media3 disables a
       * button whose command the player does not offer.
       */
      [
        `    session.setCustomLayout(mediaButtons)`,
        `    if (currentOptions?.showChapterButtons == true) {
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_PREVIOUS)
          .setDisplayName("Previous Chapter")
          .setEnabled(true)
          .setPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS)
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .build()
      )
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_NEXT)
          .setDisplayName("Next Chapter")
          .setEnabled(true)
          .setPlayerCommand(Player.COMMAND_SEEK_TO_NEXT)
          .setSlots(CommandButton.SLOT_OVERFLOW)
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
    ],
  ],
  [
    path.join(AUDIO_ROOT, 'service', 'AudioMediaSessionCallback.kt'),
    [
      /*
       * The only change here, and it is the other half of the gate. These two
       * are stripped so that a media3 controller is told track navigation is
       * unavailable; a controller told that is entitled to draw no button.
       *
       * The `*_MEDIA_ITEM` removals stay. Those really are about a playlist,
       * which this app does not have — the forwarding player redirects them
       * if anything asks anyway.
       */
      [
        `            .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
            .remove(Player.COMMAND_SEEK_TO_NEXT)`,
        `            // plugins/withLockScreenChapters.js: offered here, and
            // granted or withheld per book by the session player's own
            // getAvailableCommands, which is what Android actually reads.
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_TO_NEXT)`,
      ],
    ],
  ],
];

/**
 * The app's half has to be listening for the broadcast this sends.
 *
 * The two sides share no code — that is the point of using a broadcast — so
 * nothing but a check like this would notice the strings drifting apart. The
 * failure it prevents is silent: a button that is drawn, is pressed, and does
 * nothing.
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
          'are drawn and do nothing. Make them match rather than deleting ' +
          'this check.',
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

      for (const [relative, pairs] of REWRITES) {
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
