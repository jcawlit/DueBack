import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { MIGRATIONS, migrate } from '../src/db/migrations.ts';
import { localFolderId } from '../src/lib/files/localNames.ts';
import { buildGeneration } from '../src/lib/sync/generations.ts';
import { emptyPayload, mergeNote, type NoteRecord } from '../src/lib/sync/records.ts';

function sqlite() {
  const raw = new DatabaseSync(':memory:');
  // Match the app's current foreign-key setting.
  raw.exec('PRAGMA foreign_keys = OFF');
  const db = {
    async execAsync(sql: string) { raw.exec(sql); },
    async runAsync(sql: string, ...args: SQLInputValue[]) {
      const expanded: SQLInputValue[] = [];
      const query = sql.replace(/\?(\d+)/g, (_, n) => { expanded.push(args[Number(n) - 1]); return '?'; });
      return raw.prepare(query).run(...(expanded.length ? expanded : args));
    },
    async getFirstAsync<T>(sql: string, ...args: SQLInputValue[]) { return raw.prepare(sql).get(...args) as T ?? null; },
    async getAllAsync<T>(sql: string, ...args: SQLInputValue[]) { return raw.prepare(sql).all(...args) as T[]; },
    async withTransactionAsync(fn: () => Promise<void>) {
      raw.exec('BEGIN');
      try { await fn(); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    async closeAsync() {},
  };
  return { raw, db };
}

describe('upgrade of a populated database', () => {
  it('keeps audio addresses and every authored reference, including the last player book', async () => {
    const { raw, db } = sqlite();
    try {
      for (const migration of MIGRATIONS.slice(0, 6)) await migration(db as never);
      raw.exec(`PRAGMA user_version = 6;
        INSERT INTO books(id, folder_rel_path, raw_folder_name, title, local_status, local_path, progress_sec, hold_since)
          VALUES ('old', 'A', 'A', 'A', 'checked-out', 'books/old', 123, 'hold');
        INSERT INTO settings VALUES ('player.lastBookId','old');
        INSERT INTO settings VALUES ('library.root.uri','file:///library');
        INSERT INTO parts(book_id,idx,rel_path,name,uri,local_rel_path) VALUES ('old',0,'A/1','1','drive','books/old/0000.mp3');
        INSERT INTO chapters VALUES ('old',0,'One',0);
        INSERT INTO checkouts(book_id,out_at) VALUES ('old','out');
        INSERT INTO notes VALUES ('n','old',20,0,'words','created','updated',NULL);
        INSERT INTO characters VALUES ('c','old','Name','','bio','created','updated',NULL);
        INSERT INTO note_characters VALUES ('n','c','updated',NULL);`);
      await migrate(db as never);
      const book = raw.prepare('SELECT * FROM books').get()!;
      assert.notEqual(book.id, 'old');
      assert.equal(book.progress_sec, 123);
      assert.equal(book.local_path, 'books/old');
      assert.equal(book.hold_since, 'hold');
      for (const table of ['parts', 'chapters', 'checkouts', 'notes', 'characters']) {
        assert.equal(raw.prepare(`SELECT book_id FROM ${table}`).get()!.book_id, book.id);
      }
      assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'player.lastBookId'").get()!.value, book.id);
      const file = raw.prepare('SELECT local_rel_path FROM parts').get()!.local_rel_path as string;
      const ownedFolders = new Set([localFolderId(file, 'books')]);
      assert.ok(ownedFolders.has('old'), 'startup sweep must retain the pre-UUID directory');
      assert.equal(localFolderId(book.local_path as string, 'books'), 'old', 'Return must target the original directory');
    } finally { raw.close(); }
  });

  it('rolls back DDL and rewritten references if identity migration is interrupted, then retries', async () => {
    const { raw, db } = sqlite();
    try {
      for (const migration of MIGRATIONS.slice(0, 6)) await migration(db as never);
      raw.exec("PRAGMA user_version = 6; INSERT INTO books(id,folder_rel_path,raw_folder_name,title) VALUES ('old','A','A','A'); INSERT INTO notes VALUES ('n','old',0,0,'keep','c','u',NULL);");
      const broken = { ...db, async runAsync(sql: string, ...args: SQLInputValue[]) {
        if (sql.startsWith('UPDATE books SET id')) throw new Error('power loss');
        return db.runAsync(sql, ...args);
      } };
      await assert.rejects(migrate(broken as never), /power loss/);
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 6);
      assert.equal(raw.prepare('SELECT book_id FROM notes').get()!.book_id, 'old');
      assert.equal(raw.prepare('PRAGMA table_info(books)').all().some((c) => c.name === 'path_key'), false);
      await migrate(db as never);
      assert.notEqual(raw.prepare('SELECT book_id FROM notes').get()!.book_id, 'old');
    } finally { raw.close(); }
  });
});

// Only native boundaries are replaced. These tests execute the production SQL and
// drive orchestration, rather than comparing copies of their algorithms.
const appDb = sqlite();
type Entry = { kind: 'dir' | 'file'; text: string };
const entries = new Map<string, Entry>();
let failDriveWrites = false;
class FakeFile {
  uri: string;
  constructor(uri: string) { this.uri = uri.replace(/\/$/, ''); }
  get name() { return this.uri.split('/').at(-1)!; }
  get exists() { return entries.has(this.uri); }
  textSync() { return entries.get(this.uri)!.text; }
  write(text: string) {
    if (failDriveWrites) throw new Error('drive unplugged');
    entries.set(this.uri, { kind: 'file', text });
  }
  delete() { entries.delete(this.uri); }
}
class FakeDirectory extends FakeFile {
  list() {
    return [...entries].filter(([uri]) => uri.startsWith(this.uri + '/') && !uri.slice(this.uri.length + 1).includes('/'))
      .map(([uri, e]) => e.kind === 'dir' ? new FakeDirectory(uri) : new FakeFile(uri));
  }
  createDirectory(name: string) {
    const uri = `${this.uri}/${name}`;
    if (entries.has(uri)) throw new Error('exists');
    entries.set(uri, { kind: 'dir', text: '' });
    return new FakeDirectory(uri);
  }
  createFile(name: string) {
    const file = new FakeFile(`${this.uri}/${name}`);
    if (file.exists) throw new Error('exists');
    file.write(''); return file;
  }
  delete() {
    for (const uri of entries.keys()) if (uri === this.uri || uri.startsWith(this.uri + '/')) entries.delete(uri);
  }
}
Object.assign(globalThis, { auditDb: appDb.db, auditFile: FakeFile, auditDirectory: FakeDirectory,
  auditLibrary: { libraryRoot: { uri: 'root' }, libraryOnDevice: false, driveConnected: true,
    async refresh() {}, showSlip() {} } });
const native = (text: string) => ({ url: `data:text/javascript,${encodeURIComponent(text)}`, shortCircuit: true });
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'expo-sqlite') return native('export async function openDatabaseAsync() { return globalThis.auditDb; }');
  if (specifier === 'expo-file-system') return native('export const File = globalThis.auditFile; export const Directory = globalThis.auditDirectory;');
  if (specifier === '@/lib/files/access') return native('export const coverUri = x => x; export const asDirectoryUri = x => x;');
  if (specifier === './library' && context.parentURL?.endsWith('/store/backup.ts')) return native('export const useLibrary = { getState: () => globalThis.auditLibrary };');
  if (specifier.startsWith('@/')) return { url: pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !path.extname(specifier)) {
    const candidate = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
after(() => { hooks.deregister(); appDb.raw.close(); });

describe('production sync and restore', () => {
  let sync: typeof import('../src/db/sync.ts');
  let identity: typeof import('../src/db/identity.ts');
  let drive: typeof import('../src/lib/sync/driveSync.ts');
  before(async () => {
    sync = await import('../src/db/sync.ts');
    identity = await import('../src/db/identity.ts');
    drive = await import('../src/lib/sync/driveSync.ts');
    await migrate(appDb.db as never);
    appDb.raw.exec("INSERT INTO books(id,folder_rel_path,raw_folder_name,title,library_id,progress_updated_at,progress_mutation_id,progress_writer_device) VALUES ('b','A','A','A','lib','2026-01-02','zero','phone');");
  });

  it('exports an explicit rewind to zero and excludes other libraries', async () => {
    assert.equal((await sync.collectPayload('lib')).progress[0].positionSec, 0);
    assert.equal((await sync.collectPayload('other')).progress.length, 0);
  });

  it('seeds missing identities so renamed audio can reconnect on a fresh installation', async () => {
    const record = { id: 'restored', pathKey: 'old-folder', title: 'Restored', author: 'A', sizeBytes: 12,
      durationSec: 10, partSizes: [12], sampleHash: 'hash', updatedAt: '2026-01-01', mutationId: 'm', writerDevice: 'd' };
    await identity.seedRestoredIdentities('lib', [record]);
    const vanished = await identity.loadVanishedBooks(['b']);
    assert.ok(vanished.some((b) => b.id === 'restored' && b.sampleHash === 'hash'));
    appDb.raw.exec("INSERT INTO books(id,folder_rel_path,raw_folder_name,title,library_id) VALUES ('found','new-folder','new-folder','Restored','lib');");
    await identity.reconnectBook('found', 'restored');
    const data = emptyPayload();
    data.notes = [{ id: 'restored-note', bookId: 'restored', text: 'Kept', chapterIndex: 0, positionSec: 1,
      createdAt: '2026-01-01', updatedAt: '2026-01-01', mutationId: 'm', writerDevice: 'd' }];
    await sync.applyPayload(data);
    assert.equal(appDb.raw.prepare("SELECT folder_rel_path FROM books WHERE id='restored'").get()!.folder_rel_path, 'new-folder');
    assert.equal(appDb.raw.prepare("SELECT text FROM notes WHERE id='restored-note'").get()!.text, 'Kept');
  });

  it('does not overwrite a newer local note with an older collected snapshot', async () => {
    const data = emptyPayload();
    data.notes = [{ id: 'race', bookId: 'b', text: 'new draft', chapterIndex: 0, positionSec: 1,
      createdAt: '2026-01-01', updatedAt: '2026-01-03', mutationId: 'new', writerDevice: 'd' }];
    await sync.applyPayload(data);
    data.notes[0] = { ...data.notes[0], text: 'stale', updatedAt: '2026-01-02', mutationId: 'old' };
    await sync.applyPayload(data);
    assert.equal(appDb.raw.prepare("SELECT text FROM notes WHERE id='race'").get()!.text, 'new draft');
  });

  it('never writes or prunes when a newer-schema generation exists', async () => {
    entries.clear(); entries.set('root', { kind: 'dir', text: '' });
    const folder = new FakeDirectory('root').createDirectory('.dueback');
    for (const n of [1, 2]) {
      const gen = buildGeneration(emptyPayload(), { libraryId: 'lib', generation: n, writerDevice: 'd' });
      if (n === 2) gen.manifest.schemaVersion = 999;
      const dir = folder.createDirectory(`gen-${n}`);
      for (const part of gen.parts) dir.createFile(`${part.part}.json`).write(JSON.stringify(part));
      dir.createFile('manifest.json').write(JSON.stringify(gen.manifest));
    }
    const before = JSON.stringify([...entries]);
    const result = await drive.syncToDrive('root', 'lib', 'phone', emptyPayload());
    assert.equal(result.ok, false);
    assert.equal(result.needsNewerApp, true);
    assert.equal(JSON.stringify([...entries]), before);
  });

  it('recovers library identity from a complete generation despite a corrupt marker', () => {
    new FakeDirectory('root/.dueback').createFile('library.json').write('{');
    assert.equal(drive.recoverDriveLibraryId('root'), 'lib');
  });

  it('gives an unrelated new root its own library id and reuses that id on rescan', async () => {
    const { resolveLibraryId } = await import('../src/lib/sync/libraryIdentity.ts');
    entries.set('other-root', { kind: 'dir', text: '' });
    const first = await resolveLibraryId('root');
    const second = await resolveLibraryId('other-root');
    assert.notEqual(second, first);
    assert.equal(await resolveLibraryId('other-root'), second);
    assert.equal(drive.recoverDriveLibraryId('other-root'), second);
    new FakeDirectory('other-root/.dueback').createDirectory('gen-2')
      .createFile('manifest.json').write('{"schemaVersion":1,"libraryId":"damaged"}');
    assert.equal(drive.recoverDriveLibraryId('other-root'), second, 'a malformed newest manifest must fall back');
  });

  it('does not mark notes agreed when the drive write fails', async () => {
    // Start with a readable, current-schema generation and an unsynced local note.
    entries.clear(); entries.set('root', { kind: 'dir', text: '' });
    await drive.syncToDrive('root', 'lib', 'phone', emptyPayload());
    appDb.raw.exec("INSERT OR REPLACE INTO settings VALUES ('library.id','lib'); UPDATE notes SET base_updated_at = NULL WHERE id = 'race';");
    const { useBackup } = await import('../src/store/backup.ts');
    failDriveWrites = true;
    try { await useBackup.getState().run(); } finally { failDriveWrites = false; }
    assert.equal(appDb.raw.prepare("SELECT base_updated_at FROM notes WHERE id='race'").get()!.base_updated_at, null);
    assert.match(useBackup.getState().status ?? '', /could not/);
    assert.equal(useBackup.getState().pending, true);
  });

  it('marks edits pending immediately and debounces backup after authored database writes', async () => {
    const { useBackup } = await import('../src/store/backup.ts');
    const { saveNoteText } = await import('../src/db/notes.ts');
    const { closeCheckout } = await import('../src/db/books.ts');
    const original = useBackup.getState().run;
    let runs = 0;
    useBackup.setState({ pending: false, run: async () => { runs += 1; } });
    try {
      await saveNoteText('race', 'first edit', []);
      assert.equal(useBackup.getState().pending, true);
      await saveNoteText('race', 'second edit', []);
      await closeCheckout('b', new Date().toISOString());
      assert.equal(runs, 0, 'Return must not wait for a drive write');
      await new Promise((resolve) => setTimeout(resolve, 1700));
      assert.equal(runs, 1, 'one backup should cover the burst of edits and Return');
    } finally { useBackup.setState({ run: original }); }
  });

  it('does not back up the drive every time a playing position is saved', async () => {
    /*
     * Found on a real drive: the generation numbers climbed several at a time
     * between two looks at the same folder. Pruning kept only two, which is
     * why nothing looked wrong — but a full read-merge-write-validate cycle,
     * in synchronous file calls, was running every few seconds for as long as
     * a book played.
     *
     * A position is written every five seconds. None of those may reach the
     * drive on its own; the phone already holds the position safely, and the
     * next note or scan carries it across with everything else.
     */
    const { useBackup, cancelScheduledBackup } = await import('../src/store/backup.ts');
    const { readingDataChanged } = await import('../src/lib/sync/changes.ts');
    const original = useBackup.getState().run;
    let runs = 0;
    useBackup.setState({ pending: false, run: async () => { runs += 1; } });
    try {
      for (let tick = 0; tick < 6; tick += 1) {
        readingDataChanged('progress');
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      assert.equal(
        useBackup.getState().pending,
        true,
        'the Book screen should still say the drive is behind',
      );
      await new Promise((resolve) => setTimeout(resolve, 1700));
      assert.equal(runs, 0, 'a position tick must not reach the drive on its own');
    } finally {
      // The ten-minute timer would otherwise hold the test process open.
      cancelScheduledBackup();
      useBackup.setState({ run: original });
    }
  });

  it('keeps newer typing on screen when an earlier save finishes', async () => {
    const { onReadingDataChanged } = await import('../src/lib/sync/changes.ts');
    onReadingDataChanged(() => {});
    const { useNotes } = await import('../src/store/notes.ts');
    await useNotes.getState().load('b');
    const original = appDb.db.runAsync;
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    appDb.db.runAsync = async (sql, ...args) => {
      if (sql.includes('UPDATE notes SET text') && args[0] === 'first draft') { started(); await gate; }
      return original(sql, ...args);
    };
    try {
      useNotes.getState().setNoteText('race', 'first draft');
      const saving = useNotes.getState().flush();
      await reached;
      useNotes.getState().setNoteText('race', 'newer typing');
      release(); await saving;
      assert.equal(useNotes.getState().notes.find((n) => n.id === 'race')!.text, 'newer typing');
      await useNotes.getState().flush();
      assert.equal(appDb.raw.prepare("SELECT text FROM notes WHERE id='race'").get()!.text, 'newer typing');
    } finally { release(); appDb.db.runAsync = original; }
  });
});

it('conflict retention is symmetric when devices remember different agreements', () => {
  const a: NoteRecord = { id: 'n', bookId: 'b', text: 'A', positionSec: 0, chapterIndex: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-02', baseUpdatedAt: '2026-01-02', mutationId: 'a', writerDevice: 'a' };
  const b = { ...a, text: 'B', updatedAt: '2026-01-03', baseUpdatedAt: '2026-01-01', mutationId: 'b', writerDevice: 'b' };
  assert.deepEqual(mergeNote(a, b), mergeNote(b, a));
  assert.equal(mergeNote(a, b).conflicted?.text, 'A');
});
