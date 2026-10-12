/** Dry-run of the scan pipeline over the real audiobooks, printed for review. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REAL_DIR, nodeReader, walk } from '../tests/helpers.ts';
import { readMetadata } from '../src/lib/metadata/index.ts';
import { groupIntoBooks, orderParts, findCoverFile, type ScannedFile } from '../src/lib/library/grouping.ts';
import { resolveName } from '../src/lib/library/names.ts';
import { bookIdFor } from '../src/lib/library/ids.ts';

const tree: ScannedFile[] = walk(REAL_DIR).map((abs) => {
  const rel = path.relative(REAL_DIR, abs).split(path.sep).join('/');
  const st = fs.statSync(abs);
  return { relPath: rel, name: path.basename(abs), uri: abs, sizeBytes: st.size, modifiedMs: st.mtimeMs };
});

console.log(`tree: ${tree.length} files`);
const groups = groupIntoBooks(tree);
console.log(`books: ${groups.length}\n`);

for (const g of groups) {
  const reads = [];
  let bytes = 0, reads_n = 0;
  const t0 = performance.now();
  for (const f of g.files) {
    const r = nodeReader(f.uri);
    const m = await readMetadata(r, f.name, { cover: false });
    bytes += r.bytesRead; reads_n += r.readCount;
    await r.close();
    reads.push({ f, m });
  }
  const ordered = orderParts(reads.map(({ f, m }) => ({ file: f, trackNumber: m.trackNumber })));
  const first = reads[0]?.m;
  const multi = g.files.length > 1;
  const name = resolveName({
    folderName: g.folderName,
    embeddedTitle: multi ? first?.album : (first?.title ?? first?.album),
    embeddedAuthor: first?.author,
  });
  const total = reads.reduce((n, r) => n + r.m.durationSec, 0);
  const ms = performance.now() - t0;
  const coverFile = findCoverFile(tree, g.folderRelPath);

  console.log(`── ${name.title}`);
  console.log(`   id          ${bookIdFor(g.folderRelPath, g.files, { split: g.split })}`);
  console.log(`   raw folder  ${g.folderName}`);
  console.log(`   embedded    title="${multi ? first?.album ?? '' : first?.title ?? ''}" artist="${first?.author ?? ''}"`);
  console.log(`   → title     "${name.title}"  (${name.titleSource})`);
  console.log(`   → author    "${name.author ?? '—'}"  (${name.authorSource})`);
  console.log(`   narrator    ${first?.narrator ?? '—'}`);
  console.log(`   ${g.files.length} parts · ${(total/3600).toFixed(2)}h · order by ${ordered.basis}` +
    `${ordered.warning ? ' ⚠' : ''} · cover file: ${coverFile?.name ?? 'none'} · skipped ${g.skippedUnsupported} · drm ${g.drmFiles}`);
  console.log(`   read ${(bytes/1024/1024).toFixed(2)} MB in ${reads_n} reads · ${ms.toFixed(0)} ms`);
  ordered.parts.slice(0, 3).forEach((p, i) => console.log(`     ${i+1}. ${p.file.name}${p.trackNumber != null ? ` (trk ${p.trackNumber})` : ''}`));
  if (ordered.parts.length > 3) {
    const last = ordered.parts[ordered.parts.length-1];
    console.log(`     … ${ordered.parts.length-3} more, last: ${last.file.name}${last.trackNumber != null ? ` (trk ${last.trackNumber})` : ''}`);
  }
  if (ordered.warning) console.log(`   ⚠ ${ordered.warning}`);
  console.log();
}
