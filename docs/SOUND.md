# Sound panel

Android playback offers Off, Clear voice and Quiet recording, plus Boost,
Clarity and Warmth. Moving any slider selects Custom. Settings are stored in
SQLite per book; “Make this the default” sets the fallback for other books,
and “Use all-books default” deletes the current book's override. Save failures
are shown in the panel. Off remains available without Pro or working effects.

The local `dueback-audio` Expo module accepts expo-audio's shared player
reference. It accesses ExoPlayer on the main thread, queries real equalizer
bands and level ranges, and listens for audio-session changes. Unsupported
effects hide their sliders without preventing playback. Boost is capped by
the app at 12 dB; this is not a reported hardware maximum.

Headphone disconnection pauses natively, then informs the JavaScript engine
so its playback intent also stops. The build disables microphone permission.
Existing backup rules include SQLite and exclude copied audio and covers;
they needed no change.

## Pixel acceptance checks

Device verification pending: no physical device was connected during this work.
The tests mock Android effects, so they do not establish Pixel support.

- Play a quiet recording. Compare Off, Clear voice and Quiet recording; adjust
  all sliders. Check Custom appears and Off restores the original sound.
- Check which controls appear: Boost requires LoudnessEnhancer; Clarity and
  Warmth require Equalizer. Unavailable controls should say “Not supported on
  this device”. Listen at a comfortable volume for distortion.
- Set a default, override a second book, then use its default again. Force-stop
  and reopen the app; check both settings survive.
- Cross a Hyperion part boundary with effects active, both on screen and with
  the screen locked. Check tone, level and playback remain correct.
- Try Bluetooth earbuds and disconnect them while playing with the screen
  locked. Playback should pause. Repeat with wired/USB headphones if available.
- With TalkBack, adjust each slider using increment/decrement actions and
  confirm its label and value are announced.

## iOS

No iOS native module or build is included. An iOS implementation would need a
separate audio-effects path integrated with the playback engine, such as an
AVAudioEngine graph with EQ and gain, plus route-change handling and tests for
background playback and multipart transitions. Android audiofx cannot be reused
there; the optional module currently degrades to unsupported.
