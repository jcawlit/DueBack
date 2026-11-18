/**
 * Search the knowledge base from the command line.
 *
 *   npm run kb                list every heading
 *   npm run kb saf            entries matching "saf"
 *   npm run kb cover id3      entries matching either word
 *
 * Matching is on the whole entry, so a term that appears only in the body
 * finds it too. Case and punctuation are ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const KB = path.join(process.cwd(), 'docs', 'KNOWLEDGE.md');

type Entry = { section: string; heading: string; body: string };

function parse(markdown: string): Entry[] {
  const entries: Entry[] = [];
  let section = '';
  let current: Entry | null = null;

  /*
   * Split on either ending.
   *
   * `core.autocrlf` is on, so every checkout on Windows hands this file CRLF
   * — and splitting on `\n` alone leaves a `\r` at the end of every line.
   * `/^## (.+)$/` then cannot match: `.` does not match a carriage return, so
   * the capture stops before it and `$` finds a character still to come. Every
   * heading failed, the parser returned no entries at all, and `npm run kb`
   * answered "Nothing for <term>" for every term in the knowledge base —
   * indistinguishable from a knowledge base that had nothing to say.
   */
  for (const line of markdown.split(/\r?\n/)) {
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    if (h2) {
      if (current) entries.push(current);
      current = null;
      section = h2[1].trim();
      continue;
    }
    if (h3) {
      if (current) entries.push(current);
      current = { section, heading: h3[1].trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) entries.push(current);
  return entries;
}

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

function main() {
  if (!fs.existsSync(KB)) {
    console.error(`No knowledge base at ${KB}. Run from the project root.`);
    process.exit(1);
  }

  const entries = parse(fs.readFileSync(KB, 'utf8'));
  const terms = process.argv.slice(2).map((t) => fold(t).trim()).filter(Boolean);

  if (terms.length === 0) {
    let section = '';
    for (const entry of entries) {
      if (entry.section !== section) {
        section = entry.section;
        console.log(`\n${section}`);
      }
      console.log(`  · ${entry.heading}`);
    }
    console.log(`\n${entries.length} entries. Add a term to read one.`);
    return;
  }

  // Ranked, so the entry whose heading names the term comes first.
  const hits = entries
    .map((entry) => {
      const heading = fold(entry.heading);
      const all = `${heading} ${fold(entry.body)}`;
      const score = terms.reduce(
        (n, term) => n + (heading.includes(term) ? 2 : all.includes(term) ? 1 : 0),
        0,
      );
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);

  if (hits.length === 0) {
    console.log(`Nothing for ${terms.join(', ')}. \`npm run kb\` lists everything.`);
    return;
  }

  for (const { entry } of hits) {
    console.log(`\n── ${entry.heading}   [${entry.section}]`);
    console.log(entry.body.replace(/\n{3,}/g, '\n\n').trimEnd());
  }
  console.log(`\n${hits.length} ${hits.length === 1 ? 'entry' : 'entries'}.`);
}

main();
