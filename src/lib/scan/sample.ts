/**
 * Reading just enough of a book to prove it is the same audio later.
 *
 * This is the only extra I/O identity costs, so it is bounded on purpose:
 * four parts at most, 64 KB from each end of each. A 148-part book is half a
 * megabyte rather than nineteen, and the choice of which four is deterministic
 * so the same book always samples the same way.
 *
 * Paid once, when a book is first indexed or when its files change — an
 * incremental scan skips folders whose sizes and timestamps are unchanged, and
 * `upsertBook` keeps an existing hash when a scan did not take one.
 */

import { openReader } from '@/lib/files/access';
import {
  SAMPLE_VERSION,
  sampleHash,
  samplePartIndexes,
  sampleRanges,
} from '@/lib/library/identity';

export type SampledContent = {
  hash: string;
  version: number;
  bytesRead: number;
  readCount: number;
};

/**
 * Samples a book's parts and folds them into one hash.
 *
 * Never throws: a drive that will not answer costs a prompt later, which is
 * much better than costing the scan. A null hash means "not sampled", and
 * `planReconnection` treats that as unproven rather than as a mismatch.
 */
export async function sampleBook(
  parts: { uri: string; sizeBytes: number }[],
): Promise<SampledContent | null> {
  if (parts.length === 0) return null;

  const samples: { partIndex: number; offset: number; bytes: Uint8Array }[] = [];
  let bytesRead = 0;
  let readCount = 0;

  for (const partIndex of samplePartIndexes(parts.length)) {
    const part = parts[partIndex];
    const ranges = sampleRanges(part.sizeBytes);
    if (ranges.length === 0) continue;

    let reader: Awaited<ReturnType<typeof openReader>> | null = null;
    try {
      reader = openReader(part.uri);
      for (const range of ranges) {
        const bytes = await reader.read(range.offset, range.length);
        if (bytes.length === 0) continue;
        samples.push({ partIndex, offset: range.offset, bytes });
        bytesRead += bytes.length;
        readCount += 1;
      }
    } catch {
      // One unreadable part does not invalidate the rest; the part sizes are
      // folded in regardless, so a partial sample is still worth something.
    } finally {
      try {
        await reader?.close();
      } catch {
        // Already released.
      }
    }
  }

  if (samples.length === 0) return null;
  return {
    hash: sampleHash(parts.map((p) => p.sizeBytes), samples),
    version: SAMPLE_VERSION,
    bytesRead,
    readCount,
  };
}
