# Running the emulator suite

The on-device suite runs against the synthetic fixture library rather than a
real drive. An API 34 x86_64 AVD called `dueback34` is set up for it. Two
things differ from the phone and are worth knowing before you trust a result.

The system folder picker cannot be driven from a script, so the self-test takes
a plain filesystem path as its library root rather than a picked folder. That
means it exercises everything downstream of the root — scanning, copying,
importing, reconciliation — but not the SAF-specific code paths that only a real
USB drive goes through. SAF bugs still need the phone.

The emulator also cannot run the phone's APK: that one is `arm64-v8a` only.

```bash
SDK="$LOCALAPPDATA/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"

# 1. Boot it.
"$SDK/emulator/emulator.exe" -avd dueback34 -no-boot-anim &

# 2. Build and install an x86_64 debug APK.
#    JAVA_TOOL_OPTIONS is required: the bundled JBR is JDK 25, and
#    react-native-worklets' CMake task trips JDK 24+'s native-access
#    restriction without it. It must reach the forked JVMs, so passing it
#    through -Dorg.gradle.jvmargs is not enough.
cd android
JAVA_TOOL_OPTIONS="--enable-native-access=ALL-UNNAMED" \
  JAVA_HOME="/c/Program Files/Android/Android Studio1/jbr" \
  ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64
cd ..
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk

# 3. Put a test drive where the app can actually read it.
#    Not /sdcard/Android/data/<pkg>: adb writes there as shell:ext_data_rw and
#    the app's uid cannot traverse it. App-internal storage needs root, which
#    this google_apis image allows.
"$ADB" root
"$ADB" push testdrive /data/local/tmp/testdrive
"$ADB" shell "cp -r /data/local/tmp/testdrive /data/data/com.dueback.app/files/testdrive"
"$ADB" shell "chown -R u0_a183:u0_a183 /data/data/com.dueback.app/files/testdrive"

# 4. adb root restarts adbd and drops port forwards, so redo this after it.
"$ADB" reverse tcp:8081 tcp:8081

# 5. Point the dev client at Metro.
#    This intent is only honoured by an already-running process. Sent to a
#    cold app it opens MainActivity, fails to connect and leaves a blank white
#    screen with nothing in logcat, so start the app first and send it second.
"$ADB" shell "am start -n com.dueback.app/.MainActivity"
"$ADB" shell "am start -a android.intent.action.VIEW \
  -d 'dueback://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'"
# Wait for the bundle before doing anything else:
#   until "$ADB" logcat -d -s ReactNativeJS:V | grep -q 'Running "main"'; do sleep 4; done

# 6. Run the suite. The trailing slash on the root matters.
#    Change the nonce to re-run without navigating away first.
"$ADB" shell am start -a android.intent.action.VIEW \
  -d "'dueback://dev/selftest?root=/data/data/com.dueback.app/files/testdrive/&run=1&nonce=1'"
"$ADB" logcat -d -s ReactNativeJS:V | grep selftest
```

The suite is `src/app/dev/selftest.tsx`, also reachable by hand from
Settings → Developer → Self-test. Reset between runs by deleting `testdrive`, `books` and
`imported` under `/data/data/com.dueback.app/files/`.
