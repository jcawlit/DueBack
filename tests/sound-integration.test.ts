import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settingsForPreset } from '../src/lib/audio/sound.ts';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE sound_settings(book_id TEXT PRIMARY KEY, preset TEXT, boost INTEGER, clarity INTEGER, warmth INTEGER)');
let failEffect = false;
let failWrite = false;
let session = 1;
let attached = false;
const events = new Map<string, () => void>();
const applied: { levels: number[]; boost: number; session: number }[] = [];
const capabilities = () => ({ attached, sessionId: session,
  equalizer: { available: true, bandCount: 3, minMillibels: -600, maxMillibels: 600, centerFrequenciesHz: [100, 1000, 3000] },
  loudness: { available: true, maxMillibels: 1200 } });
const player = {
  addListener: () => ({ remove() {} }),
  replace() {}, setPlaybackRate() {}, async seekTo() {},
  setActiveForLockScreen() {}, updateLockScreenMetadata() {}, play() {}, pause() {}, remove() {},
};
Object.assign(globalThis, {
  soundTestDb: {
    async getFirstAsync(sql: string, ...args: SQLInputValue[]) { return db.prepare(sql).get(...args) ?? null; },
    async runAsync(sql: string, ...args: SQLInputValue[]) {
      if (failWrite) throw new Error('disk full');
      return db.prepare(sql).run(...args);
    },
  },
  soundTestPlayer: player,
  soundTestNative: {
    async attach() { attached = true; return capabilities(); },
    async detach() { attached = false; },
    async capabilities() { return capabilities(); },
    async apply(levels: number[], boost: number) {
      if (failEffect) throw new Error('unsupported');
      applied.push({ levels, boost, session });
      return capabilities();
    },
    addListener(name: string, listener: () => void) { events.set(name, listener); return { remove() { events.delete(name); } }; },
  },
});
const mock = (code: string) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/db/schema') return mock('export async function getDb() { return globalThis.soundTestDb; }');
  if (specifier === 'react-native') return mock("export const Platform = { OS: 'android' };");
  if (specifier === 'expo') return mock('export const requireOptionalNativeModule = () => globalThis.soundTestNative;');
  if (specifier === 'expo-audio') return mock(`export const createAudioPlayer = () => globalThis.soundTestPlayer;
    export const clearAllPreloadedSources = async () => {}; export const preload = async () => {};
    export const setAudioModeAsync = async () => {};`);
  if (specifier.startsWith('@/')) return { url: pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !path.extname(specifier)) {
    for (const suffix of ['.ts', '/index.ts']) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
} });
after(() => { hooks.deregister(); db.close(); });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('sound persistence, defaults, session changes and optional effects use production code', async () => {
  const { useSound } = await import('../src/store/sound.ts');
  const { createExpoAudioEngine } = await import('../src/lib/audio/expoAudioEngine.ts');
  const engine = createExpoAudioEngine();
  engine.onSessionChange((p) => useSound.getState().useSession(p));
  await useSound.getState().load('hyperion');
  await engine.load({ bookId: 'hyperion', title: 'Hyperion', durationSec: 20, parts: [
    { uri: 'part1', startSec: 0, durationSec: 10 }, { uri: 'part2', startSec: 10, durationSec: 10 },
  ] }, 0);
  await useSound.getState().setPreset('quiet-recording');
  await settle();
  assert.equal(applied.at(-1)?.boost, 840);
  assert.deepEqual(applied.at(-1)?.levels, [-90, 126, 315]);

  await useSound.getState().makeDefault();
  await useSound.getState().setPreset('clear-voice');
  await useSound.getState().load('other');
  assert.equal(useSound.getState().effective.preset, 'quiet-recording');
  await useSound.getState().load('hyperion');
  assert.deepEqual(useSound.getState().effective, settingsForPreset('clear-voice'));
  await useSound.getState().useDefaultForBook();
  assert.equal(db.prepare("SELECT * FROM sound_settings WHERE book_id='hyperion'").get(), undefined);
  await useSound.getState().load('hyperion');
  assert.equal(useSound.getState().effective.preset, 'quiet-recording');

  const before = applied.length;
  await engine.seekTo(12);
  await settle();
  assert.ok(applied.length > before, 'crossing a part must reapply settings');
  session = 2;
  events.get('onSessionChanged')!();
  await settle();
  assert.equal(applied.at(-1)?.session, 2);
  assert.equal(applied.at(-1)?.boost, 840);

  // Rapid edits must persist in order, including when followed by reset.
  await Promise.all([useSound.getState().setSlider('boost', 15), useSound.getState().setSlider('boost', 35)]);
  await useSound.getState().load('hyperion');
  assert.equal(useSound.getState().effective.boost, 35);
  failWrite = true;
  await useSound.getState().setSlider('boost', 45);
  assert.match(useSound.getState().saveError!, /could not be saved/);
  failWrite = false;

  failEffect = true;
  await useSound.getState().setPreset('off');
  await settle();
  assert.equal(useSound.getState().capabilities.attached, false);
  await engine.play(); // Effect failure must not reject playback operations.
  await engine.unload();
  await settle();
  assert.equal(attached, false);
});
