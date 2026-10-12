import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeReader, walk } from '../tests/helpers.ts';
import { readMetadata } from '../src/lib/metadata/index.ts';
const root = path.join(process.cwd(), 'testlib');
for (const f of walk(root).slice(0, 6)) {
  const r = nodeReader(f);
  const m = await readMetadata(r, path.basename(f));
  await r.close();
  console.log(`${path.basename(f).padEnd(42)} ${String(m.chapters.length).padStart(3)}ch  ` +
    `${Math.round(m.durationSec)}s  cover ${m.cover ? (m.cover.bytes.length/1024).toFixed(0)+'KB' : 'none'}  ` +
    `trk ${m.trackNumber ?? '-'}  "${m.title ?? ''}" / ${m.author ?? ''}`);
}
