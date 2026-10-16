/**
 * Puts a freshly built APK where the phone can reach it.
 *
 *   npm run apk:publish
 *
 * Copies `android/app/build/outputs/apk/release/app-release.apk` to the
 * repository root as `dueback.apk`, and to the file server as both
 * `dueback-<sha>.apk` and `dueback.apk`.
 *
 * Two names on purpose. The sha-stamped one is the history — "was this
 * broken before the keyboard change?" is a question you can only answer if
 * the old build is still there. The plain one is always the newest, so the
 * phone's bookmark never changes.
 *
 * The share is skipped, not failed, when it cannot be reached: a build on a
 * different network is still a build.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BUILT = path.join(
  process.cwd(),
  'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk',
);
const LOCAL = path.join(process.cwd(), 'dueback.apk');
/** Overridable, for a different machine or a different server. */
const SHARE = process.env.APK_SHARE ?? '\\\\192.168.1.90\\APKs';

function shortSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}

if (!fs.existsSync(BUILT)) {
  console.error(`No APK at ${BUILT}\nBuild one first: cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`);
  process.exit(1);
}

const mb = (fs.statSync(BUILT).size / 1024 / 1024).toFixed(1);
fs.copyFileSync(BUILT, LOCAL);
console.log(`dueback.apk        ${mb} MB`);

const sha = shortSha();
try {
  // Reachability is the copy itself: a stat can succeed on a stale handle.
  fs.copyFileSync(BUILT, path.join(SHARE, `dueback-${sha}.apk`));
  fs.copyFileSync(BUILT, path.join(SHARE, 'dueback.apk'));
  console.log(`${SHARE}\\dueback-${sha}.apk`);
  console.log(`${SHARE}\\dueback.apk`);
} catch (err) {
  console.warn(`Could not reach ${SHARE} — local copy only. (${(err as Error).message})`);
}
