/**
 * Builds the release APK, having first worked out where Java and the Android
 * SDK actually are.
 *
 *   npm run apk              # build arm64, then publish
 *   npm run apk -- --debug   # a debug build instead
 *   npm run apk -- --all-abis
 *   npm run apk -- --no-publish
 *
 * This exists because three separate things about this machine are traps, and
 * each one cost time before it was understood.
 *
 * **`JAVA_HOME` and `ANDROID_HOME` are set, but not where a tool can see
 * them.** They are persisted in the Windows registry — user and machine
 * environment — and a shell started by an editor or another tool does not
 * inherit either. Gradle then reports "JAVA_HOME is not set", which is false
 * and sends you looking in the wrong place. So this reads the registry when
 * the environment is silent.
 *
 * **One of the JDKs on this machine is broken.** Android Studio ships a JDK at
 * `Android Studio/jbr`, and here its `lib/` holds only `modules` — no
 * `jvm.cfg` — so `java` fails with `could not open jvm.cfg` rather than
 * anything about being incomplete. A path having `bin/java.exe` is therefore
 * not enough to trust it, and every candidate is checked properly.
 *
 * **Two Android SDKs exist**, at `C:\Android` and under `%LOCALAPPDATA%`, with
 * different NDK and build-tools inside them. Picking the wrong one builds
 * something subtly different from the last build. The persisted
 * `ANDROID_HOME` is the one that counts, so it wins over any guess.
 *
 * It also always passes `-PreactNativeArchitectures`. Forgetting it builds all
 * four ABIs and a 119 MB APK, which is a trap of its own.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WINDOWS = process.platform === 'win32';

/**
 * A persisted Windows environment variable, which the current process may not
 * have inherited. Null everywhere else, and null if `reg` says nothing useful.
 */
function fromRegistry(name: string): string | null {
  if (!WINDOWS) return null;
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // "    JAVA_HOME    REG_SZ    C:\path\to\jdk"
      const match = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, 'i'));
      const value = match?.[1]?.trim();
      if (value) return expand(value);
    } catch {
      // Not in this key, or no `reg` at all. Try the next one.
    }
  }
  return null;
}

/** `REG_EXPAND_SZ` values keep their `%VARS%`, which mean nothing to `fs`. */
function expand(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/**
 * The first candidate that passes `check`, with every rejection named.
 *
 * Reporting what was rejected and why is most of the point: the failure this
 * replaces was a valid-looking path that could not run, and a bare "not
 * found" would have been just as unhelpful as Gradle's own message.
 */
function resolve(
  what: string,
  envName: string,
  candidates: (string | null | undefined)[],
  check: (dir: string) => string | null,
): string {
  const rejected: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    // A trailing separator is harmless to `fs` and breaks Gradle's own
    // concatenation, so it goes before anything else sees it.
    const dir = path.normalize(raw.trim()).replace(/[\\/]+$/, '');
    if (rejected.some((r) => r.startsWith(dir))) continue;
    const complaint = check(dir);
    if (!complaint) return dir;
    rejected.push(`${dir} — ${complaint}`);
  }
  const detail = rejected.length ? `\n  tried:\n    ${rejected.join('\n    ')}` : '';
  throw new Error(`Could not find ${what}. Set ${envName} to it.${detail}`);
}

/** A JDK has to be able to start, not merely look like one. See the header. */
function checkJdk(dir: string): string | null {
  if (!fs.existsSync(dir)) return 'no such folder';
  const java = path.join(dir, 'bin', WINDOWS ? 'java.exe' : 'java');
  if (!fs.existsSync(java)) return 'no bin/java';
  // The Android Studio jbr on this machine gets this far and then cannot run.
  if (!fs.existsSync(path.join(dir, 'lib', 'jvm.cfg'))) {
    return 'incomplete JDK — lib/jvm.cfg is missing, so java will not start';
  }
  return null;
}

function checkSdk(dir: string): string | null {
  if (!fs.existsSync(dir)) return 'no such folder';
  if (!fs.existsSync(path.join(dir, 'platform-tools'))) return 'no platform-tools';
  return null;
}

const local = process.env.LOCALAPPDATA;
const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';

const javaHome = resolve(
  'a working JDK',
  'JAVA_HOME',
  [
    process.env.JAVA_HOME,
    fromRegistry('JAVA_HOME'),
    // Known good on this machine, and the usual places otherwise.
    path.join(programFiles, 'Microsoft', 'jdk-17.0.21.102-hotspot'),
    path.join(programFiles, 'Eclipse Adoptium', 'jdk-17'),
    // Last, deliberately: on this machine it is the broken one, and `checkJdk`
    // will say so rather than letting Gradle fail obscurely.
    path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
  ],
  checkJdk,
);

const androidHome = resolve(
  'the Android SDK',
  'ANDROID_HOME',
  [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    fromRegistry('ANDROID_HOME'),
    fromRegistry('ANDROID_SDK_ROOT'),
    local ? path.join(local, 'Android', 'Sdk') : null,
    'C:\\Android',
  ],
  checkSdk,
);

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const publish = !args.includes('--no-publish');
/** Every ABI, for the rare build that has to run on something else. */
const abis = args.includes('--all-abis') ? null : 'arm64-v8a';

const task = debug ? ':app:assembleDebug' : ':app:assembleRelease';
const gradle = path.join(process.cwd(), 'android', WINDOWS ? 'gradlew.bat' : 'gradlew');

console.log(`JAVA_HOME    ${javaHome}`);
console.log(`ANDROID_HOME ${androidHome}`);
console.log(`gradle       ${task}${abis ? ` (${abis})` : ' (all ABIs)'}\n`);

try {
  execFileSync(
    // `gradlew.bat` is a batch file, and since the 2024 argument-injection fix
    // Node refuses to spawn one of those without a shell — it throws EINVAL
    // before the process starts. Quoted because a shell is now parsing it and
    // this path may contain spaces on someone else's machine.
    WINDOWS ? `"${gradle}"` : gradle,
    [task, ...(abis ? [`-PreactNativeArchitectures=${abis}`] : [])],
    {
      cwd: path.join(process.cwd(), 'android'),
      stdio: 'inherit',
      shell: WINDOWS,
      env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome },
    },
  );
} catch (err) {
  /*
   * Only silent when Gradle itself failed — it has printed the reason at
   * length and repeating it buries it. A spawn that never started has a
   * `status` of null and has printed nothing at all, and swallowing that is
   * how this script first appeared to succeed while building nothing.
   */
  const { status, message } = err as { status?: number | null; message?: string };
  if (status === null || status === undefined) {
    console.error(`\nCould not run ${gradle}\n  ${message ?? 'no reason given'}`);
  }
  process.exit(typeof status === 'number' ? status : 1);
}

if (!publish) process.exit(0);
if (debug) {
  // `publish-apk.ts` only knows about the release output, and a debug build is
  // something you are running on this machine anyway.
  console.log('\nDebug build — not published.');
  process.exit(0);
}

console.log('');
execFileSync(process.execPath, [
  '--experimental-strip-types',
  '--no-warnings',
  path.join('scripts', 'publish-apk.ts'),
], { stdio: 'inherit' });
