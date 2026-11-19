/**
 * The Sound panel's state: what this book should sound like, what the device
 * can actually do about it, and keeping the two in step.
 *
 * Three things have to line up. The settings, which are per book with an
 * all-books fallback. The hardware, which differs on every device and may
 * offer neither effect. And the audio session, which moves whenever a part
 * changes — an effect attached to a session that has been replaced is
 * silently doing nothing.
 */

import { create } from 'zustand';
import { getDb } from '@/db/schema';
import { canCustomiseSound } from '@/lib/pro';
import { gate } from '@/store/pro';
import {
  DEFAULT_SETTINGS,
  resolveSettings,
  settingsForPreset,
  withSlider,
  type PresetName,
  type SoundSettings,
} from '@/lib/audio/sound';
import {
  NOTHING_AVAILABLE,
  applySettings,
  attachEffects,
  detachEffects,
  soundEffectsPossible,
  readCapabilities,
  onAudioSessionChanged,
} from '@/lib/audio/soundFx';
import type { SoundCapabilities } from '../../modules/dueback-audio';

/** The all-books default lives under an id no book can have. */
const ALL_BOOKS = '';

type Row = { book_id: string; preset: string; boost: number; clarity: number; warmth: number };

function toSettings(row: Row | null): SoundSettings | null {
  if (!row) return null;
  return {
    preset: row.preset as PresetName,
    boost: row.boost,
    clarity: row.clarity,
    warmth: row.warmth,
  };
}

type SoundState = {
  /** The book the panel is showing, or null before anything is opened. */
  bookId: string | null;
  /** This book's own settings, if it has any. Null means "use the default". */
  own: SoundSettings | null;
  allBooks: SoundSettings | null;
  /** What is actually being applied. */
  effective: SoundSettings;
  capabilities: SoundCapabilities;
  /** False on iOS, and in any build without the native module. */
  possible: boolean;
  saveError: string | null;

  load: (bookId: string) => Promise<void>;
  /** The engine's current native player; null when nothing is loaded. */
  useSession: (nativePlayer: unknown) => void;
  setPreset: (preset: PresetName) => Promise<void>;
  setSlider: (which: 'boost' | 'clarity' | 'warmth', value: number) => Promise<void>;
  /** Clears this book's own settings, so the all-books default applies. */
  useDefaultForBook: () => Promise<void>;
  /** Makes what this book is using the default for every book. */
  makeDefault: () => Promise<void>;
};

async function readRow(bookId: string): Promise<SoundSettings | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    'SELECT book_id, preset, boost, clarity, warmth FROM sound_settings WHERE book_id = ?',
    bookId,
  );
  return toSettings(row ?? null);
}

async function writeRow(bookId: string, settings: SoundSettings): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sound_settings (book_id, preset, boost, clarity, warmth)
     VALUES (?,?,?,?,?)
     ON CONFLICT(book_id) DO UPDATE SET
       preset = excluded.preset, boost = excluded.boost,
       clarity = excluded.clarity, warmth = excluded.warmth`,
    bookId, settings.preset, settings.boost, settings.clarity, settings.warmth,
  );
}

export const useSound = create<SoundState>((set, get) => {
  let diskQueue = Promise.resolve();
  let nativeQueue = Promise.resolve();
  let revision = 0;
  const persist = (work: () => Promise<void>) => {
    diskQueue = diskQueue.then(work).then(
      () => { set({ saveError: null }); },
      () => { set({ saveError: 'Sound settings could not be saved. Try again.' }); },
    );
    return diskQueue;
  };
  const push = async () => {
    const { possible, capabilities, effective } = get();
    if (possible && capabilities.attached) {
      const tuned = gate(canCustomiseSound) ? effective : DEFAULT_SETTINGS;
      set({ capabilities: await applySettings(tuned, capabilities) });
    }
  };
  const native = (work: () => Promise<void>) => {
    nativeQueue = nativeQueue.then(work).catch(() => { set({ capabilities: NOTHING_AVAILABLE }); });
  };
  onAudioSessionChanged(() => native(async () => {
    set({ capabilities: await readCapabilities() });
    await push();
  }));
  const change = async (next: SoundSettings) => {
    const bookId = get().bookId;
    if (!bookId) return;
    revision += 1;
    set({ own: next, effective: next });
    native(push);
    await persist(() => writeRow(bookId, next));
  };
  return {
    bookId: null, own: null, allBooks: null, effective: DEFAULT_SETTINGS,
    capabilities: NOTHING_AVAILABLE, possible: soundEffectsPossible(), saveError: null,
    load: async (bookId) => {
      const version = ++revision;
      set({ bookId, own: null, effective: DEFAULT_SETTINGS });
      await diskQueue;
      try {
        const [own, allBooks] = await Promise.all([readRow(bookId), readRow(ALL_BOOKS)]);
        if (revision !== version) return;
        set({ own, allBooks, effective: resolveSettings(own, allBooks), saveError: null });
        native(push);
      } catch {
        if (revision !== version) return;
        set({ own: null, allBooks: null, effective: DEFAULT_SETTINGS,
          saveError: 'Sound settings could not be loaded.' });
        native(push);
      }
    },
    useSession: (player) => {
      if (!get().possible) return;
      native(async () => {
        if (!player) {
          await detachEffects();
          set({ capabilities: NOTHING_AVAILABLE });
        } else {
          set({ capabilities: await attachEffects(player as never) });
          await push();
        }
      });
    },
    setPreset: async (preset) => {
      // `off` is free: the app sounds like the recording, which is normal
      // rather than broken. Pro is what tunes it.
      if (preset !== 'off' && !gate(canCustomiseSound)) return;
      await change(settingsForPreset(preset));
    },
    setSlider: async (which, value) => {
      if (!gate(canCustomiseSound)) return;
      await change(withSlider(get().effective, which, value));
    },
    useDefaultForBook: async () => {
      const { bookId, allBooks } = get();
      if (!bookId) return;
      revision += 1;
      set({ own: null, effective: resolveSettings(null, allBooks) });
      native(push);
      await persist(async () => {
        const db = await getDb();
        await db.runAsync('DELETE FROM sound_settings WHERE book_id = ?', bookId);
      });
    },
    makeDefault: async () => {
      if (!gate(canCustomiseSound)) return;
      const settings = get().effective;
      revision += 1;
      set({ allBooks: settings });
      await persist(() => writeRow(ALL_BOOKS, settings));
    },
  };
});

export function hasSession(): boolean {
  return useSound.getState().capabilities.attached;
}
