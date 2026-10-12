/**
 * Root layout: loads the three typefaces the design depends on, holds the splash
 * screen until they are ready, and runs the one-second clock that advances
 * playback.
 */

import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Imported per weight, not from the package root: each root index pulls in every
// style of the family, which would ship a dozen unused .ttf files per typeface.
import { YoungSerif_400Regular } from '@expo-google-fonts/young-serif/400Regular';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono/400Regular';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular';
import { color } from '@/theme/tokens';
import { GlobalConfirm } from '@/components/GlobalConfirm';
import { GlobalSlip } from '@/components/GlobalSlip';
import { MiniPlayer } from '@/components/MiniPlayer';
import { usePlayer } from '@/store/player';
import { useLibrary } from '@/store/library';
import { useScan } from '@/store/scan';

SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden, or unavailable in this environment — nothing to do.
});

/**
 * Counts down the sleep timer.
 *
 * Playback position no longer needs a clock — the audio engine reports it —
 * but the sleep timer is measured in real seconds, so it does. It only runs
 * while something is playing, and stops when the app is backgrounded, which is
 * the right behaviour: a JS interval is not reliable in the background, and
 * the sleep timer only matters while someone is awake with the app open.
 */
function SleepTimerClock() {
  const playing = usePlayer((s) => s.playing);
  const armed = usePlayer((s) => s.sleepIndex !== 0);

  useEffect(() => {
    if (!playing || !armed) return;
    const id = setInterval(() => usePlayer.getState().tickSleep(), 1000);
    return () => clearInterval(id);
  }, [playing, armed]);

  return null;
}

/**
 * Opens the database, loads the saved library, and re-checks whether the drive
 * is reachable every time the app comes back to the foreground — which is how
 * the drawer notices a USB stick being plugged in or pulled out.
 */
function LibraryBootstrap() {
  const hydrate = useLibrary((s) => s.hydrate);
  const checkDrive = useLibrary((s) => s.checkDrive);

  // No local "already done" guard: the store itself ignores a second call, and
  // a guard held in a ref would survive a fast refresh that reset the store,
  // leaving the app permanently unhydrated during development.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void checkDrive();
        return;
      }
      // Going to the background is the last reliable moment before the system
      // may kill the process, so flush the playback position now.
      usePlayer.getState().savePosition();
    });
    return () => sub.remove();
  }, [checkDrive]);

  return null;
}

/**
 * Re-reads the drive whenever it appears.
 *
 * Plugging a drive in used to tell the app only that the folder was readable,
 * never what was inside it. A book deleted from the drive on a computer stayed
 * on the shelf offering a check-out that could not possibly work, until someone
 * thought to rescan by hand — which is not something a person should have to
 * think about. An incremental scan skips every book whose files are unchanged,
 * so this costs a tree walk, runs behind the existing progress bar, and can be
 * cancelled from Settings like any other scan.
 */
function DriveSync() {
  const driveConnected = useLibrary((s) => s.driveConnected);
  const rootUri = useLibrary((s) => s.libraryRoot?.uri ?? null);

  useEffect(() => {
    if (!driveConnected) {
      useScan.getState().forgetSync();
      return;
    }
    if (!rootUri) return;
    void useScan.getState().syncOnConnect(rootUri);
  }, [driveConnected, rootUri]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    YoungSerif_400Regular,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    InstrumentSans_400Regular,
  });

  /**
   * Fonts can hang rather than fail — an asset that never resolves leaves
   * `useFonts` pending forever, and with the splash held open that is an app
   * that never starts. After this long, give up and render with system fonts.
   */
  const [fontTimedOut, setFontTimedOut] = useState(false);
  useEffect(() => {
    // Generous: on a development build the fonts come over the network from
    // Metro and genuinely take a few seconds. This is a stuck-asset backstop,
    // not a deadline.
    const id = setTimeout(() => setFontTimedOut(true), 12000);
    return () => clearTimeout(id);
  }, []);

  const fontsSettled = fontsLoaded || !!fontError || fontTimedOut;

  useEffect(() => {
    if (!fontsSettled) return;
    if (fontError) console.warn('[dueback] fonts failed to load:', fontError);
    else if (fontTimedOut && !fontsLoaded) {
      console.warn('[dueback] fonts still loading after 4s; starting anyway');
    }
    SplashScreen.hideAsync().catch(() => {});
  }, [fontsSettled, fontError, fontTimedOut, fontsLoaded]);

  // The whole design is typographic, so render nothing rather than a flash of
  // system fonts — but never hold the app hostage to it.
  if (!fontsSettled) {
    return <View style={{ flex: 1, backgroundColor: color.groundDeep }} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <LibraryBootstrap />
      <DriveSync />
      <SleepTimerClock />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.ground },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="book/[id]" />
        <Stack.Screen name="player/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="settings" />
        <Stack.Screen name="dev/metadata" />
        <Stack.Screen name="dev/selftest" />
      </Stack>
      <MiniPlayer />
      <GlobalSlip />
      <GlobalConfirm />
    </SafeAreaProvider>
  );
}
