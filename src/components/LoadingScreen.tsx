// Due Back loading screen.
//
// Hand-off from the native splash: the native splash shows splash-icon.png
// centred at 200 dp on #1B1410. This screen starts with the SAME image at the
// SAME size and position, so the switch is invisible. Then the mark eases up
// and the "Due Back / AUDIOBOOK LIBRARY" wordmark fades in beneath it. When
// `ready` is true (fonts, database, restored player state) and the minimum
// display time has passed, the whole screen fades out and calls onDone.
//
// Render it above the app until onDone fires. Call SplashScreen.hideAsync()
// from this component's first layout (below), not earlier, or the native
// splash and this screen can flash between each other.

import { useEffect, useState } from 'react';
import { Animated, Easing, Image, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

const BG = '#1B1410';
const PAPER = '#EFE3CC';
const MUTED = '#CBBB9E';
// Kept as literals rather than reaching for the theme: these have to match
// the native splash's own colours, which are set in `app.json` and are not
// the app's tokens. A token drifting would open a seam in the handoff.
const MARK_SIZE = 200; // must equal imageWidth in the expo-splash-screen config
const MIN_VISIBLE_MS = 900; // long enough to read the wordmark, short enough not to annoy

type Props = {
  ready: boolean; // true once fonts + DB + restored state are loaded
  onDone: () => void; // unmount this screen
};

export function LoadingScreen({ ready, onDone }: Props) {
  /*
   * `useState`, not `useRef`, as `Slip` does. An Animated value is read
   * during render to build a style, which is the one thing a ref must not
   * be — the kit shipped the ref form and this project's lint refuses it.
   */
  const [lift] = useState(() => new Animated.Value(0)); // 0 = splash position
  const [wordmark] = useState(() => new Animated.Value(0));
  const [screen] = useState(() => new Animated.Value(1));
  const [shownAt, setShownAt] = useState<number | null>(null);

  const onFirstLayout = () => {
    if (shownAt !== null) return;
    setShownAt(Date.now());
    SplashScreen.hideAsync().catch(() => {});
    Animated.parallel([
      Animated.timing(lift, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(wordmark, { toValue: 1, duration: 360, delay: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };

  useEffect(() => {
    if (!ready || shownAt === null) return;
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
    const t = setTimeout(() => {
      Animated.timing(screen, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true })
        .start(({ finished }) => finished && onDone());
    }, wait);
    return () => clearTimeout(t);
  }, [ready, shownAt, screen, onDone]);

  const markShift = lift.interpolate({ inputRange: [0, 1], outputRange: [0, -56] });
  const wordShift = wordmark.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: screen }]}
      onLayout={onFirstLayout}
      accessible
      accessibilityLabel="Due Back, audiobook library. Loading."
      accessibilityRole="progressbar"
    >
      <Animated.View style={{ transform: [{ translateY: markShift }] }}>
        <Image source={require('../../assets/splash-icon.png')} style={styles.mark} />
      </Animated.View>
      <Animated.View style={[styles.words, { opacity: wordmark, transform: [{ translateY: wordShift }] }]}>
        <Animated.Text style={styles.title}>Due Back</Animated.Text>
        <Animated.Text style={styles.tagline}>AUDIOBOOK LIBRARY</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: BG, alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  mark: { width: MARK_SIZE, height: MARK_SIZE },
  // Sits under the mark's visual centre; the mark image has built-in padding.
  words: { position: 'absolute', top: '50%', marginTop: 36, alignItems: 'center', gap: 8 },
  title: { fontFamily: 'YoungSerif_400Regular', fontSize: 40, color: PAPER },
  tagline: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 12, letterSpacing: 3.4, color: MUTED },
});
