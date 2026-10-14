/**
 * Holding typed text for a moment before writing it.
 *
 * The debounce decides *when* a note is written, never *whether*. Every exit
 * from the sheet calls `flush`, and so does the app going to the background,
 * because the note most likely to be interrupted is the one being typed
 * one-handed on a walk.
 *
 * A write that fails puts its text back rather than dropping it. Losing what
 * someone wrote is the one outcome worth more code to avoid.
 */

export type Autosave = {
  /** Records text to be written after a pause. */
  queue: (id: string, text: string) => void;
  /** Writes everything outstanding now, and waits for it. */
  flush: () => Promise<void>;
  /** How many items are waiting. For tests and diagnostics. */
  pendingCount: () => number;
};

export function createAutosave(
  write: (id: string, text: string) => Promise<void>,
  delayMs: number,
  onError?: (err: unknown) => void,
): Autosave {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises flushes, so two cannot write the same note at once. */
  let inFlight: Promise<void> = Promise.resolve();

  const run = async () => {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [id, text] of entries) {
      try {
        await write(id, text);
      } catch (err) {
        // Only if nothing newer has been typed since this attempt started.
        if (!pending.has(id)) pending.set(id, text);
        onError?.(err);
      }
    }
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    inFlight = inFlight.then(run, run);
    return inFlight;
  };

  return {
    queue: (id, text) => {
      pending.set(id, text);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    pendingCount: () => pending.size,
  };
}
