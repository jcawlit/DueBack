/**
 * Writing a backup to a drive that cannot rename anything.
 *
 * The usual way to make a write atomic is to write a temporary file and
 * rename it into place. SAF has no rename (`npm run kb saf rename`), so the
 * trick is not available and something else has to carry the guarantee.
 *
 * That something is **generations**. Generation N is a complete set: a
 * manifest plus one file per record type, each carrying the library id, the
 * generation number, a schema version and a checksum of its own contents.
 * Writing means laying down a whole new generation, reading all of it back,
 * and validating the lot. Only then is an older generation pruned — so at
 * every instant there is at least one complete, self-consistent generation on
 * the drive, and a write interrupted at any point leaves the previous one
 * untouched.
 *
 * Nothing here touches the filesystem. It decides what a generation contains,
 * whether one is trustworthy, and which to read or remove; `driveSync.ts`
 * does the reading and writing.
 */

import { SCHEMA_VERSION, type SyncPayload } from './records.ts';

/** The files that make up one generation, besides the manifest. */
export const PART_FILES = [
  'identity',
  'notes',
  'characters',
  'tags',
  'progress',
  'history',
] as const;
export type PartName = (typeof PART_FILES)[number];

export const MANIFEST_FILE = 'manifest.json';
export const GENERATION_PREFIX = 'gen-';

/** How many complete generations are kept once a newer one validates. */
export const KEEP_GENERATIONS = 2;

export type FileHeader = {
  /** What this app understands. A higher number here means do not touch. */
  schemaVersion: number;
  libraryId: string;
  generation: number;
  /** Of this file's `data`, so a truncated write is detectable. */
  checksum: string;
  writtenAt: string;
  writerDevice: string;
};

export type PartFile = FileHeader & {
  part: PartName;
  count: number;
  data: unknown[];
};

export type Manifest = FileHeader & {
  /** Every part that should be present, with the checksum each must have. */
  parts: { part: PartName; count: number; checksum: string }[];
};

/**
 * FNV-1a over the serialised data, as 8 hex digits.
 *
 * Guards against a half-written file and a drive that lied about a write, not
 * against anyone tampering. Cheap enough to run over every record on a phone.
 */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The records of one part, in the order they are written. */
export function partData(payload: SyncPayload, part: PartName): unknown[] {
  return payload[part] as unknown[];
}

export function folderNameFor(generation: number): string {
  return `${GENERATION_PREFIX}${generation}`;
}

/** The generation a folder name refers to, or null if it is not one. */
export function generationOf(folderName: string): number | null {
  if (!folderName.startsWith(GENERATION_PREFIX)) return null;
  const digits = folderName.slice(GENERATION_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/** Builds every file of a generation, ready to be written. */
export function buildGeneration(
  payload: SyncPayload,
  options: { libraryId: string; generation: number; writerDevice: string; writtenAt?: string },
): { manifest: Manifest; parts: PartFile[] } {
  const writtenAt = options.writtenAt ?? new Date().toISOString();
  const head = {
    schemaVersion: SCHEMA_VERSION,
    libraryId: options.libraryId,
    generation: options.generation,
    writtenAt,
    writerDevice: options.writerDevice,
  };

  const parts: PartFile[] = PART_FILES.map((part) => {
    const data = partData(payload, part);
    return {
      ...head,
      part,
      count: data.length,
      checksum: checksum(JSON.stringify(data)),
      data,
    };
  });

  const manifest: Manifest = {
    ...head,
    checksum: checksum(
      JSON.stringify(parts.map((p) => ({ part: p.part, count: p.count, checksum: p.checksum }))),
    ),
    parts: parts.map((p) => ({ part: p.part, count: p.count, checksum: p.checksum })),
  };

  return { manifest, parts };
}

export type Validation =
  | { ok: true; payload: SyncPayload }
  | {
      ok: false;
      /**
       * `newer-schema` is the one failure that is not damage: the generation
       * is fine, this app is behind. It must never be overwritten.
       */
      reason: 'newer-schema' | 'missing-manifest' | 'missing-part' | 'checksum' | 'wrong-library';
      detail: string;
    };

/**
 * Checks a generation and turns it into a payload.
 *
 * Every file has to be there, belong to this library, be a schema this app
 * understands, and match the checksum the manifest recorded for it. Anything
 * less and the generation is not used at all — half a backup restored is
 * worse than none, because it looks like success.
 */
export function validateGeneration(
  libraryId: string,
  manifest: Manifest | null,
  files: Partial<Record<PartName, PartFile | null>>,
): Validation {
  if (!manifest) return { ok: false, reason: 'missing-manifest', detail: 'no manifest' };

  if (manifest.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'newer-schema',
      detail: `written by a newer version (schema ${manifest.schemaVersion})`,
    };
  }
  if (manifest.libraryId !== libraryId) {
    return {
      ok: false,
      reason: 'wrong-library',
      detail: `belongs to another library (${manifest.libraryId})`,
    };
  }

  const manifestChecksum = checksum(
    JSON.stringify(manifest.parts.map((p) => ({ part: p.part, count: p.count, checksum: p.checksum }))),
  );
  if (manifestChecksum !== manifest.checksum) {
    return { ok: false, reason: 'checksum', detail: 'the manifest does not match itself' };
  }

  const payload: Record<string, unknown[]> = {};
  for (const expected of manifest.parts) {
    const file = files[expected.part];
    if (!file) {
      return { ok: false, reason: 'missing-part', detail: `${expected.part} is missing` };
    }
    if (file.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, reason: 'newer-schema', detail: `${expected.part} is newer` };
    }
    if (file.libraryId !== libraryId) {
      return { ok: false, reason: 'wrong-library', detail: `${expected.part} is another library's` };
    }
    if (file.generation !== manifest.generation) {
      return {
        ok: false,
        reason: 'missing-part',
        detail: `${expected.part} belongs to generation ${file.generation}`,
      };
    }
    const actual = checksum(JSON.stringify(file.data));
    if (actual !== expected.checksum || actual !== file.checksum) {
      return { ok: false, reason: 'checksum', detail: `${expected.part} is damaged` };
    }
    if (file.data.length !== expected.count) {
      return { ok: false, reason: 'checksum', detail: `${expected.part} is the wrong length` };
    }
    payload[expected.part] = file.data;
  }

  // Every part must be present, not merely every part the manifest listed.
  for (const part of PART_FILES) {
    if (!(part in payload)) {
      return { ok: false, reason: 'missing-part', detail: `${part} is not in the manifest` };
    }
  }

  return { ok: true, payload: payload as unknown as SyncPayload };
}

/**
 * Which generations to keep, and which may be removed.
 *
 * Pruning is only ever a consequence of a newer generation having been read
 * back and validated — the caller passes the ones that did validate, newest
 * first — and even then the last few are kept. Disk is cheap and a second
 * known-good copy has already proved its worth once.
 */
export function prunable(
  all: number[],
  validated: number[],
  keep = KEEP_GENERATIONS,
): number[] {
  /*
   * Nothing is removed until there are `keep` generations known to be good.
   * Pruning down to a single copy would mean the next damaged write left
   * nothing to fall back to, which is the situation generations exist to
   * avoid. Disk is cheap; a second known-good copy has already earned its
   * place once.
   */
  if (validated.length < keep) return [];
  const sorted = [...validated].sort((a, b) => b - a);
  const kept = new Set(sorted.slice(0, keep));
  const newest = sorted[0];
  // Nothing newer than the newest validated generation is ever removed: it
  // may be a newer schema this app must not touch, or a write in flight.
  return all.filter((n) => n < newest && !kept.has(n)).sort((a, b) => a - b);
}
