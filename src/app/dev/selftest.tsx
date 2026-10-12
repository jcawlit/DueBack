/**
 * Runs the on-device test suites and prints a result per case.
 *
 * The screen is only a runner and a log view; the tests themselves live in
 * `src/dev/suites.ts`. A run is readable from `adb logcat`, which is what makes
 * the whole thing scriptable:
 *
 *   adb shell am start -a android.intent.action.VIEW -d \
 *     "dueback://dev/selftest?root=/data/data/com.dueback.app/files/fixtures/Audiobooks/&run=1&nonce=1"
 *   adb logcat -d -s ReactNativeJS:V | grep selftest
 *
 * Parameters:
 *   root   absolute path of the library folder, trailing slash included
 *   suite  comma-separated suite ids (A1, A1b, …), or omitted for all
 *   run=1  start without a tap
 *   nonce  change it to re-run the same selection without navigating away
 *
 * The root is a plain path rather than a picked folder because the system
 * folder picker cannot be driven from a script. Everything downstream of the
 * root is the same code the real app runs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { readManifest, runSuites, type CaseResult } from '@/dev/harness';
import { suitesFor } from '@/dev/suites';
import { color, font, space } from '@/theme/tokens';

type Line = { kind: 'note' | 'result'; text: string; status?: CaseResult['status'] };

const DEFAULT_ROOT = '/data/data/com.dueback.app/files/fixtures/Audiobooks/';

export default function SelfTestScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    root?: string;
    suite?: string;
    run?: string;
    nonce?: string;
  }>();
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const ranFor = useRef<string | null>(null);

  const rootPath = params.root ?? DEFAULT_ROOT;
  const selector = params.suite;

  const run = useCallback(async () => {
    setRunning(true);
    setLines([]);

    const note = (text: string) => {
      console.log(`[selftest] ---- ${text}`);
      setLines((prev) => [...prev, { kind: 'note', text }]);
    };

    const manifest = await readManifest(rootPath);
    note(`root ${rootPath}`);
    note(
      manifest
        ? `manifest: ${manifest.expectedBookCount} books expected`
        : 'no manifest.json beside the root — count checks will be skipped',
    );

    const suites = suitesFor(selector);
    if (suites.length === 0) {
      note(`no suite matched "${selector}"`);
      setRunning(false);
      return;
    }

    const started = Date.now();
    const totals = await runSuites(suites, { rootPath, manifest, log: note }, (result) => {
      const mark = result.status.toUpperCase().padEnd(4);
      const line = `${mark} ${result.id} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`;
      console.log(`[selftest] ${line}`);
      setLines((prev) => [...prev, { kind: 'result', text: line, status: result.status }]);
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[selftest] SUMMARY passed=${totals.passed} failed=${totals.failed} ` +
        `skipped=${totals.skipped} seconds=${seconds}`,
    );
    note(
      `done — ${totals.passed} passed, ${totals.failed} failed, ` +
        `${totals.skipped} skipped in ${seconds}s`,
    );
    setRunning(false);
  }, [rootPath, selector]);

  useEffect(() => {
    // Keyed on the nonce as well, so the same selection can be re-run from a
    // new deep link without navigating away from the screen first.
    const key = `${rootPath}|${selector ?? 'all'}|${params.nonce ?? ''}`;
    if (params.run !== '1' || ranFor.current === key) return;
    ranFor.current = key;
    void run();
  }, [params.run, params.nonce, rootPath, selector, run]);

  const colorFor = (line: Line) => {
    if (line.kind === 'note') return color.faint;
    if (line.status === 'fail') return color.warning;
    if (line.status === 'skip') return color.muted;
    return color.paper;
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md }}>
        <Pressable onPress={() => router.back()} style={{ paddingVertical: 8, paddingHorizontal: 12 }}>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>back</Text>
        </Pressable>
        <Pressable
          onPress={() => void run()}
          disabled={running}
          style={{ paddingVertical: 8, paddingHorizontal: 12, opacity: running ? 0.5 : 1 }}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
            {running ? 'running…' : `run ${selector ?? 'all'}`}
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: 5 }}>
        {lines.map((line, i) => (
          <Text key={i} style={{ fontFamily: font.mono, fontSize: 10.5, color: colorFor(line) }}>
            {line.kind === 'note' ? `---- ${line.text}` : line.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
