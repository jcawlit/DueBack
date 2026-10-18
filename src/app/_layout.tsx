/**
 * Root layout: loads the three typefaces the design depends on, holds the splash
 * screen until they are ready, and runs the one-second clock that advances
 * playback.
 */

import { useEffect, useRef, useState } from 'react';
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
import { Caveat_400Regular } from '@expo-google-fonts/caveat/400Regular';
import { color } from '@/theme/tokens';
import { GlobalConfirm } from '@/components/GlobalConfirm';
import { GlobalReconnect } from '@/components/GlobalReconnect';
import { GlobalSlip } from '@/components/GlobalSlip';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { MiniPlayer } from '@/components/MiniPlayer';
import { usePlayer } from '@/store/player';
import { useLibrary } from '@/store/library';
import { useScan } from '@/store/scan';
import { useNotes } from '@/store/notes';
import { useBackup } from '@/store/backup';
import { startAbsProgressSync } from '@/store/absProgress';
import { useUi } from '@/store/ui';

/**
 * How often the drive is looked for while the app is in the foreground.
 *
 * Plugging a drive in is a physical act with someone waiting on the result, so
 * this wants to be noticed in about the time it takes to put the phone down —
 * and the check is cheap enough that it can be.
 */
const DRIVE_POLL_MS = 4000;

SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden, or unavailable in this environment — nothing to do.
});

/**
 * Opens the database, loads the saved library, and re-checks whether the drive
 * is reachable every time the app comes back to the foreground — which is how
 * the app notices a drive being connected or removed.
 */
function LibraryBootstrap() {
  const hydrate = useLibrary((s) => s.hydrate);
  const checkDrive = useLibrary((s) => s.checkDrive);

  // No local "already done" guard: the store itself ignores a second call, and
  // a guard held in a ref would survive a fast refresh that reset the store,
  // leaving the app permanently unhydrated during development.
  // Reopening the last book has to wait for the library: the player looks the
  // book up by id, and before hydration there is nothing to find.
  const ready = useLibrary((s) => s.ready);
  const restored = useRef(false);

  useEffect(() => {
    void hydrate();
    void useUi.getState().loadPreferences();
    void useBackup.getState().load();
    // Listens for progress on a downloaded server book and sends it back.
    // Idempotent, so a fast refresh does not double every push.
    startAbsProgressSync();
  }, [hydrate]);

  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    void usePlayer.getState().restoreLastBook();
  }, [ready]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void checkDrive();
        return;
      }
      /*
       * Going to the background is the last reliable moment before the system
       * may kill the process, so everything half-held goes to the database
       * now: the playback position, and any note still being typed.
       */
      usePlayer.getState().savePosition();
      void useNotes.getState().flush();
    });
    return () => sub.remove();
  }, [checkDrive]);

  return null;
}

/**
 * Looks for the drive while the app is in front of you, so that holds go out
 * the moment it is plugged back in.
 *
 * Nothing happens unless the answer changes: the check is a single existence
 * test and the expensive part only runs on an arrival. Foreground only — in
 * the background there is nobody to show a change to.
 */
function DriveWatcher() {
  const hasRoot = useLibrary((s) => !!s.libraryRoot);
  const onDevice = useLibrary((s) => s.libraryOnDevice);

  useEffect(() => {
    if (!hasRoot || onDevice) return;
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void useLibrary.getState().pollDrive(), DRIVE_POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else stop();
    });

    return () => {
      sub.remove();
      stop();
    };
  }, [hasRoot, onDevice]);

  return null;
}

/**
 * Re-indexes the drive whenever it appears, so a book deleted on a computer
 * does not sit on the shelf offering a check-out that cannot work.
 *
 * An incremental scan skips every unchanged book, so this costs a tree walk,
 * runs behind the existing progress bar, and can be cancelled from Settings.
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
    Caveat_400Regular,
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
    /*
     * `KeyboardProvider` is what lets a sheet ride the keyboard.
     *
     * Android stopped resizing windows for the IME once the app went
     * edge-to-edge, and `adjustResize` in the manifest has no effect there,
     * so neither `KeyboardAvoidingView` nor a `keyboardDidShow` listener can
     * put a sheet in the right place at the right time. This reads the
     * keyboard's own animation through WindowInsetsAnimation instead.
     */
    <KeyboardProvider>
    <SafeAreaProvider>
      <StatusBar style="light" />
      <LibraryBootstrap />
      <DriveWatcher />
      <DriveSync />
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
      </Stack>
      <MiniPlayer />
      <GlobalSlip />
      <GlobalConfirm />
      <GlobalReconnect />
    </SafeAreaProvider>
    </KeyboardProvider>
  );
}
