package expo.modules.duebackaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.common.Player
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.sharedobjects.SharedRef

/**
 * The Sound panel's effects, and the one native behaviour that could not be
 * done from JavaScript at all: pausing when headphones are unplugged.
 *
 * Android's audio effects attach to a *session*, and the session belongs to
 * the ExoPlayer inside expo-audio. There is no way to ask for it from
 * JavaScript, so the player itself is handed over: `BaseAudioPlayer` is a
 * `SharedRef<ExoPlayer>`, and a SharedRef is explicitly meant to be passed
 * between independent libraries. That is why this module needs no dependency
 * on expo-audio and no patch to it — only the media3 type to read the session
 * id off.
 *
 * Nothing here is allowed to stop playback. Every effect is optional: devices
 * differ in what they offer, manufacturers disable things, and an equalizer
 * that will not initialise is a control that should disappear from the panel,
 * not an error anybody has to see.
 */

class EqualizerInfo : Record {
  @Field var available: Boolean = false
  @Field var reason: String? = null
  @Field var bandCount: Int = 0
  @Field var minMillibels: Int = 0
  @Field var maxMillibels: Int = 0
  @Field var centerFrequenciesHz: List<Int> = emptyList()
}

class LoudnessInfo : Record {
  @Field var available: Boolean = false
  @Field var reason: String? = null
  @Field var maxMillibels: Int = 0
}

class SoundCapabilities : Record {
  @Field var attached: Boolean = false
  @Field var sessionId: Int = 0
  @Field var equalizer: EqualizerInfo = EqualizerInfo()
  @Field var loudness: LoudnessInfo = LoudnessInfo()
}

/**
 * The most this app will ever ask a LoudnessEnhancer for, in millibels.
 *
 * `LoudnessEnhancer` reports no maximum of its own, and it is a gain stage
 * with no limiter behind it: ask for too much and a loud passage clips. 12 dB
 * is enough to rescue a thin recording and little enough to stay clean.
 */
private const val LOUDNESS_CEILING_MB = 1200

@UnstableApi
class DuebackAudioModule : Module() {
  private var eqEffect: Equalizer? = null
  private var loudnessEffect: LoudnessEnhancer? = null
  private var eqReason: String? = null
  private var loudnessReason: String? = null
  private var sessionId: Int = 0
  private var noisyReceiver: BroadcastReceiver? = null
  private var activePlayer: ExoPlayer? = null
  private val sessionListener = object : Player.Listener {
    override fun onAudioSessionIdChanged(audioSessionId: Int) {
      attachTo(audioSessionId)
      sendEvent("onSessionChanged", mapOf<String, Any>())
    }
  }

  private fun detachPlayer() {
    try { activePlayer?.removeListener(sessionListener) } catch (_: Throwable) {}
    activePlayer = null
    releaseEffects()
  }

  /** Kept so a new session can be given the same settings without a round trip. */
  private var lastBandLevels: List<Int> = emptyList()
  private var lastBoostMillibels: Int = 0
  private var enabled: Boolean = false

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  override fun definition() = ModuleDefinition {
    Name("DuebackAudio")

    Events("onBecomingNoisy", "onSessionChanged")

    OnCreate {
      registerNoisyReceiver()
    }

    OnDestroy {
      Handler(Looper.getMainLooper()).post { detachPlayer() }
      unregisterNoisyReceiver()
    }

    /**
     * Attaches to the session the given player is using.
     *
     * Called again whenever the session can have changed — a new part, a
     * reload — because an effect attached to a session that has gone is
     * silently doing nothing, which is the worst way for this to fail.
     */
    AsyncFunction("attach") { player: SharedRef<*> ->
      val exo = player.ref as? ExoPlayer
        ?: return@AsyncFunction unavailable("that player has no audio session")
      if (activePlayer !== exo) {
        detachPlayer()
        activePlayer = exo
        exo.addListener(sessionListener)
      }
      attachTo(exo.audioSessionId)
    }.runOnQueue(Queues.MAIN)

    /** What is attached now, without changing anything. */
    AsyncFunction("capabilities") {
      describe()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") {
      detachPlayer()
    }.runOnQueue(Queues.MAIN)

    /**
     * Applies levels worked out on the JavaScript side.
     *
     * The band levels arrive already clamped to what this device reported,
     * and are clamped again here: a device that lies about its own range is
     * not a reason to throw.
     */
    AsyncFunction("apply") { bandLevels: List<Int>, boostMillibels: Int ->
      lastBandLevels = bandLevels
      lastBoostMillibels = boostMillibels
      enabled = bandLevels.any { it != 0 } || boostMillibels > 0
      applyToEffects()
      describe()
    }.runOnQueue(Queues.MAIN)
  }

  private fun unavailable(why: String): SoundCapabilities {
    releaseEffects()
    val caps = SoundCapabilities()
    caps.attached = false
    caps.equalizer = EqualizerInfo().also { it.reason = why }
    caps.loudness = LoudnessInfo().also { it.reason = why }
    return caps
  }

  private fun attachTo(newSessionId: Int): SoundCapabilities {
    if (newSessionId == 0) {
      // Session 0 is the global output mix. Attaching effects to it has been
      // deprecated since Android 9 and does nothing on most devices, so it is
      // treated as "not ready" rather than attempted.
      return unavailable("the player has not started yet")
    }
    if (newSessionId == sessionId && (eqEffect != null || loudnessEffect != null)) {
      return describe()
    }

    releaseEffects()
    sessionId = newSessionId
    eqReason = null
    loudnessReason = null

    // Priority 0: this is our own session, and nothing else is competing for
    // it. A higher priority would only matter against another app.
    try {
      eqEffect = Equalizer(0, newSessionId)
    } catch (err: Throwable) {
      eqEffect = null
      eqReason = describeFailure(err)
    }

    try {
      loudnessEffect = LoudnessEnhancer(newSessionId)
    } catch (err: Throwable) {
      loudnessEffect = null
      loudnessReason = describeFailure(err)
    }

    applyToEffects()
    return describe()
  }

  /**
   * Why an effect could not be had, in words someone could act on.
   *
   * The exceptions here are not descriptive — `UnsupportedOperationException`
   * with no message is the usual one — so the class name is the only thing
   * worth passing on, and the panel says "not supported on this device"
   * rather than showing it.
   */
  private fun describeFailure(err: Throwable): String {
    return err.message?.takeIf { it.isNotBlank() } ?: err.javaClass.simpleName
  }

  private fun applyToEffects() {
    val eq = eqEffect
    if (eq != null) {
      try {
        val bands = eq.numberOfBands.toInt()
        for (band in 0 until bands) {
          val level = lastBandLevels.getOrNull(band) ?: 0
          val low = eq.bandLevelRange[0].toInt()
          val high = eq.bandLevelRange[1].toInt()
          eq.setBandLevel(band.toShort(), level.coerceIn(low, high).toShort())
        }
        eq.enabled = lastBandLevels.any { it != 0 }
      } catch (err: Throwable) {
        // An effect that refuses mid-flight is released rather than left in
        // an unknown state; the panel will report it gone on the next read.
        eqReason = describeFailure(err)
        releaseEqualizer()
      }
    }

    val enhancer = loudnessEffect
    if (enhancer != null) {
      try {
        enhancer.setTargetGain(lastBoostMillibels.coerceIn(0, LOUDNESS_CEILING_MB))
        enhancer.enabled = enabled && lastBoostMillibels > 0
      } catch (err: Throwable) {
        loudnessReason = describeFailure(err)
        releaseLoudness()
      }
    }
  }

  private fun describe(): SoundCapabilities {
    val caps = SoundCapabilities()
    caps.sessionId = sessionId
    caps.attached = eqEffect != null || loudnessEffect != null

    val eq = eqEffect
    caps.equalizer = EqualizerInfo().apply {
      if (eq == null) {
        available = false
        reason = eqReason ?: "not supported on this device"
        return@apply
      }
      try {
        available = true
        bandCount = eq.numberOfBands.toInt()
        minMillibels = eq.bandLevelRange[0].toInt()
        maxMillibels = eq.bandLevelRange[1].toInt()
        // Reported in millihertz; the panel and the maths both want hertz.
        centerFrequenciesHz = (0 until bandCount).map { eq.getCenterFreq(it.toShort()) / 1000 }
      } catch (err: Throwable) {
        available = false
        reason = describeFailure(err)
      }
    }

    val enhancer = loudnessEffect
    caps.loudness = LoudnessInfo().apply {
      if (enhancer == null) {
        available = false
        reason = loudnessReason ?: "not supported on this device"
        return@apply
      }
      available = true
      maxMillibels = LOUDNESS_CEILING_MB
    }

    return caps
  }

  private fun releaseEqualizer() {
    try {
      eqEffect?.enabled = false
      eqEffect?.release()
    } catch (_: Throwable) {
      // Already gone with the session.
    }
    eqEffect = null
  }

  private fun releaseLoudness() {
    try {
      loudnessEffect?.enabled = false
      loudnessEffect?.release()
    } catch (_: Throwable) {
      // Already gone with the session.
    }
    loudnessEffect = null
  }

  private fun releaseEffects() {
    releaseEqualizer()
    releaseLoudness()
    sessionId = 0
  }

  /**
   * Pause when the headphones come out.
   *
   * `ACTION_AUDIO_BECOMING_NOISY` is not exposed by expo-audio, and without
   * it unplugging wired headphones or walking away from a Bluetooth speaker
   * carries on playing the book out loud. The receiver only tells JavaScript;
   * pausing is the player's business, and doing it here would fight whatever
   * the app decides.
   */
  private fun registerNoisyReceiver() {
    if (noisyReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
        // Pause natively even if JavaScript is suspended in the background.
        try { activePlayer?.pause() } catch (_: Throwable) {}
        this@DuebackAudioModule.sendEvent("onBecomingNoisy", mapOf<String, Any>())
      }
    }
    try {
      context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
      noisyReceiver = receiver
    } catch (_: Throwable) {
      // Without it, playback simply behaves as it did before.
      noisyReceiver = null
    }
  }

  private fun unregisterNoisyReceiver() {
    val receiver = noisyReceiver ?: return
    try {
      context.unregisterReceiver(receiver)
    } catch (_: Throwable) {
      // Never registered, or the context has gone.
    }
    noisyReceiver = null
  }
}
