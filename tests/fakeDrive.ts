/**
 * An in-memory stand-in for `expo-file-system`, so the drive can be read,
 * copied from and written to inside `node --test`.
 *
 * Importing this module **registers resolution hooks** and must therefore
 * happen before the modules under test are loaded. That means a test file
 * imports this one statically and everything it exercises with
 * `await import(...)`, exactly as `tests/audit-regressions.test.ts` does.
 *
 * ## What this is and is not
 *
 * Only the native leaf is replaced. The production walk, grouping, copy and
 * import code all run for real — this is not a second implementation of them
 * to compare against, which would prove nothing.
 *
 * But it is still a model of the Storage Access Framework, not the thing
 * itself, and the repository's history is mostly bugs a model would have got
 * wrong: SAF renaming a file you asked it to create, a handle dying mid-copy,
 * `delete()` not returning a promise. So the fidelity rules below are not
 * tidiness. Each one exists because getting it wrong would let a test pass on
 * code that fails on the phone.
 *
 * **1. `File` and `Directory` are unrelated classes.** In the real module they
 * extend `FileSystemFile` and `FileSystemDirectory` respectively, so a
 * directory is *not* an `instanceof File`. `listTree` branches on `instanceof
 * Directory` and `collectAudio` on `instanceof File`; a fake with one
 * extending the other makes both branches wrong in a way that still passes.
 *
 * **2. `copy` and `move` return promises; `delete`, `write`, `create`,
 * `createFile`, `createDirectory` and `list` do not.** Mixing them once
 * reported a copy as finished while it was still in flight. A fake that made
 * everything async would have let that bug through.
 * `npm run kb -- "asynchronous"`.
 *
 * **3. `exists`, `size` and `modificationTime` are properties, not methods**,
 * and reading them can throw for a file the platform will not stat.
 *
 * **4. A URI is the identity.** Nothing here is case-folded or normalised,
 * because SAF is not: two names differing in case are two files.
 *
 * What is deliberately *not* modelled, so nothing here is mistaken for
 * covering it: SAF's renaming of created files (tested by the real-drive
 * checks and `safNames.ts`), descriptors going stale, permission revocation
 * between app launches, and anything to do with speed.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

type Kind = 'file' | 'dir';

type Entry = {
  kind: Kind;
  bytes: Uint8Array;
  modifiedMs: number;
};

/** Every path that exists, keyed by URI. The whole filesystem. */
const entries = new Map<string, Entry>();

/**
 * What `entry.name` returns, where it differs from the last path segment.
 *
 * SAF names are **document ids**, not display names: a provider hands back
 * `primary:Download/My Book/01.mp3` where a filename was expected. Untrimmed,
 * that volume prefix ended up in a book's title and in every one of its
 * chapter names, so `safDisplayName` exists to strip it — and a fake that
 * could only produce tidy names could not test that it is still applied.
 * `npm run kb -- "document ids"`.
 */
const displayNames = new Map<string, string>();

/** Makes `entry.name` report a SAF document id for a file that exists. */
export function nameAs(uri: string, documentId: string) {
  displayNames.set(trim(uri), documentId);
}

/**
 * Ways to make the platform misbehave.
 *
 * Half the value of being able to run this code at all is the failure paths:
 * a folder that will not list is the difference between "no books here" and
 * "I could not look", and that distinction is what stops a scan deleting a
 * library.
 */
export const faults = {
  /** Listing any folder at or under one of these throws. */
  unlistable: new Set<string>(),
  /** Reading `size`/`modificationTime` on these throws, as an unstattable file does. */
  unstattable: new Set<string>(),
  /** Writing anything at or under one of these throws, as an unplugged drive does. */
  unwritable: new Set<string>(),
  /** What `Paths.availableDiskSpace` reports. */
  freeBytes: 8 * 1024 * 1024 * 1024,
  /** Throws on the nth write, counting from zero. Null disables it. */
  failWriteAfter: null as number | null,
  writeCount: 0,
};

export function resetDrive() {
  entries.clear();
  displayNames.clear();
  // The app's own storage always exists on a phone, and the copy and import
  // paths build inside it without creating it first.
  for (const root of [DOCUMENT_ROOT, 'file:///data/app/cache']) {
    entries.set(root, { kind: 'dir', bytes: new Uint8Array(), modifiedMs: 1 });
  }
  faults.unlistable.clear();
  faults.unstattable.clear();
  faults.unwritable.clear();
  faults.freeBytes = 8 * 1024 * 1024 * 1024;
  faults.failWriteAfter = null;
  faults.writeCount = 0;
  picker.directory = null;
  picker.file = null;
}

/**
 * Strips trailing slashes without eating the scheme's own.
 *
 * `asDirectoryUri` appends a slash before listing, because the real module
 * treats a folder URI without one as a file. Keys here carry no trailing
 * slash, so the two have to meet — and a naive strip turns `file:///library`
 * into `file://library`, which then matches nothing and reads as an
 * unreadable root.
 */
const trim = (uri: string): string => {
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(uri);
  if (scheme) return scheme[1] + scheme[2].replace(/\/+$/, '');
  return uri.replace(/\/+$/, '');
};

const isUnder = (uri: string, prefixes: Set<string>) => {
  for (const prefix of prefixes) {
    if (uri === prefix || uri.startsWith(`${prefix}/`)) return true;
  }
  return false;
};

const asUri = (segments: unknown[]): string => {
  const parts = segments
    .map((s) => (typeof s === 'string' ? s : String((s as { uri: string }).uri)))
    .filter((p) => p !== '');
  if (parts.length === 0) return '';
  let uri = trim(parts[0]);
  for (const part of parts.slice(1)) {
    uri += `/${trim(part.replace(/^\/+/, ''))}`;
  }
  return uri;
};

const bytesOf = (content: string | Uint8Array): Uint8Array =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content;

/** The parent folder must exist before anything can be made inside it. */
const requireParent = (uri: string) => {
  const parent = uri.slice(0, uri.lastIndexOf('/'));
  if (parent === '' || !parent.includes('/')) return;
  const found = entries.get(parent);
  if (!found) throw new Error(`ENOENT: no such directory, '${parent}'`);
  if (found.kind !== 'dir') throw new Error(`ENOTDIR: not a directory, '${parent}'`);
};

/**
 * Where a copy or move actually lands.
 *
 * Transcribed from `CopyMoveStrategy.prepareAsDestination` in
 * expo-file-system's Android source, because the rule is not in the docs and
 * is not what it looks like:
 *
 * - **dir → existing dir**: lands *inside* it, as `dest/sourceName`.
 * - **dir → missing dir**: the destination path itself becomes the target,
 *   provided its parent exists. A rename, in other words.
 * - **dir → file**: refused outright.
 * - **file → dir**: the dir must already exist; lands as `dest/sourceName`.
 * - **file → file**: the destination path is the target, parent must exist.
 *
 * This is why `swapIntoPlace` moves the old folder aside *before* moving the
 * new one in. Were the order reversed, the destination would still exist and
 * the staged book would land at `books/<id>/<id>` — a checked-out book whose
 * audio is one folder too deep, which nothing would find. Getting this wrong
 * in the fake would have made that test assert the bug.
 */
function resolveDestination(
  source: { uri: string; name: string; isDir: boolean },
  destination: File | Directory,
  overwrite: boolean,
): string {
  const destIsDir = destination instanceof Directory;
  let target: string;

  if (source.isDir && !destIsDir) {
    throw new Error('CopyOrMoveDirectoryToFile: cannot copy or move a directory onto a file');
  }
  if (source.isDir) {
    if (destination.exists) {
      target = `${destination.uri}/${source.name}`;
    } else {
      requireParent(destination.uri);
      target = destination.uri;
    }
  } else if (destIsDir) {
    if (!destination.exists) {
      throw new Error(`DestinationDoesNotExist: '${destination.uri}'`);
    }
    target = `${destination.uri}/${source.name}`;
  } else {
    requireParent(destination.uri);
    target = destination.uri;
  }

  if (entries.has(target)) {
    if (!overwrite) throw new Error(`DestinationAlreadyExists: '${target}'`);
    // Deleted recursively, as the native code does.
    for (const uri of [...entries.keys()]) {
      if (uri === target || uri.startsWith(`${target}/`)) entries.delete(uri);
    }
  }
  return target;
}

class FakeNode {
  uri: string;

  constructor(...segments: unknown[]) {
    this.uri = asUri(segments);
  }

  get name(): string {
    return displayNames.get(this.uri) ?? this.uri.split('/').at(-1) ?? '';
  }

  get exists(): boolean {
    return entries.has(this.uri);
  }

  /** Metadata can be unreadable while the name is still listable. */
  protected stat(): Entry | null {
    if (faults.unstattable.has(this.uri)) {
      throw new Error(`EACCES: permission denied, stat '${this.uri}'`);
    }
    return entries.get(this.uri) ?? null;
  }

  get modificationTime(): number | null {
    return this.stat()?.modifiedMs ?? null;
  }

  guardWrite() {
    if (isUnder(this.uri, faults.unwritable)) {
      throw new Error(`EIO: i/o error, write '${this.uri}'`);
    }
    if (faults.failWriteAfter !== null && faults.writeCount >= faults.failWriteAfter) {
      throw new Error('ENOSPC: No space left on device, write');
    }
    faults.writeCount += 1;
  }
}

export class File extends FakeNode {
  get size(): number | null {
    const found = this.stat();
    return found ? found.bytes.length : null;
  }

  create(options: { overwrite?: boolean; intermediates?: boolean } = {}) {
    this.guardWrite();
    if (this.exists && !options.overwrite) {
      throw new Error(`EEXIST: file already exists, '${this.uri}'`);
    }
    if (!options.intermediates) requireParent(this.uri);
    entries.set(this.uri, { kind: 'file', bytes: new Uint8Array(), modifiedMs: Date.now() });
  }

  write(content: string | Uint8Array) {
    this.guardWrite();
    requireParent(this.uri);
    entries.set(this.uri, { kind: 'file', bytes: bytesOf(content), modifiedMs: Date.now() });
  }

  bytesSync(): Uint8Array {
    const found = entries.get(this.uri);
    if (!found) throw new Error(`ENOENT: no such file, '${this.uri}'`);
    return found.bytes;
  }

  async bytes(): Promise<Uint8Array> {
    return this.bytesSync();
  }

  textSync(): string {
    return new TextDecoder().decode(this.bytesSync());
  }

  async text(): Promise<string> {
    return this.textSync();
  }

  delete() {
    entries.delete(this.uri);
  }

  /** Async, as the real one is. See fidelity rule 2. */
  async copy(destination: File | Directory, options: { overwrite?: boolean } = {}) {
    const source = entries.get(this.uri);
    if (!source) throw new Error(`ENOENT: no such file, '${this.uri}'`);
    const target = resolveDestination(
      { uri: this.uri, name: this.name, isDir: false },
      destination,
      options.overwrite === true,
    );
    new File(target).guardWrite();
    entries.set(target, { ...source, bytes: source.bytes.slice() });
  }

  async move(destination: File | Directory, options: { overwrite?: boolean } = {}) {
    const source = entries.get(this.uri);
    if (!source) throw new Error(`ENOENT: no such file, '${this.uri}'`);
    const target = resolveDestination(
      { uri: this.uri, name: this.name, isDir: false },
      destination,
      options.overwrite === true,
    );
    new File(target).guardWrite();
    entries.set(target, { ...source, bytes: source.bytes.slice() });
    entries.delete(this.uri);
    // The real one updates the instance's uri, and callers read it afterwards.
    this.uri = target;
  }

  open(_mode?: unknown): FileHandle {
    const found = entries.get(this.uri);
    if (!found) throw new Error(`ENOENT: no such file, '${this.uri}'`);
    return new FileHandle(found);
  }
}

/**
 * A seekable read over one file.
 *
 * `offset` is settable and `readBytes` is synchronous, which is what the
 * byte-range discipline in `openReader` is built on: a 1.5 GB `.m4b` must
 * never be read whole to find its metadata.
 */
export class FileHandle {
  offset = 0;
  private entry: Entry;
  private closed = false;
  /** Every range actually asked for, so a test can assert what was read. */
  reads: { offset: number; length: number }[] = [];

  constructor(entry: Entry) {
    this.entry = entry;
  }

  get size(): number {
    return this.entry.bytes.length;
  }

  readBytes(length: number): Uint8Array {
    if (this.closed) throw new Error('EBADF: bad file descriptor');
    this.reads.push({ offset: this.offset, length });
    const slice = this.entry.bytes.slice(this.offset, this.offset + length);
    this.offset += slice.length;
    return slice;
  }

  close() {
    this.closed = true;
  }
}

export class Directory extends FakeNode {
  get size(): number | null {
    return this.stat() ? 0 : null;
  }

  list(): (File | Directory)[] {
    if (isUnder(this.uri, faults.unlistable)) {
      throw new Error(`EACCES: permission denied, scandir '${this.uri}'`);
    }
    const found = entries.get(this.uri);
    if (!found) throw new Error(`ENOENT: no such directory, '${this.uri}'`);
    if (found.kind !== 'dir') throw new Error(`ENOTDIR: not a directory, '${this.uri}'`);
    const prefix = `${this.uri}/`;
    const out: (File | Directory)[] = [];
    for (const [uri, entry] of entries) {
      if (!uri.startsWith(prefix)) continue;
      // Immediate children only.
      if (uri.slice(prefix.length).includes('/')) continue;
      out.push(entry.kind === 'dir' ? new Directory(uri) : new File(uri));
    }
    return out;
  }

  create(options: { intermediates?: boolean; idempotent?: boolean } = {}) {
    this.guardWrite();
    if (this.exists) {
      if (options.idempotent) return;
      throw new Error(`EEXIST: directory already exists, '${this.uri}'`);
    }
    if (options.intermediates) {
      const bits = this.uri.split('/');
      for (let i = 2; i <= bits.length; i += 1) {
        const at = bits.slice(0, i).join('/');
        if (!entries.has(at)) {
          entries.set(at, { kind: 'dir', bytes: new Uint8Array(), modifiedMs: Date.now() });
        }
      }
      return;
    }
    requireParent(this.uri);
    entries.set(this.uri, { kind: 'dir', bytes: new Uint8Array(), modifiedMs: Date.now() });
  }

  createFile(name: string, _mimeType?: string | null): File {
    const file = new File(this.uri, name);
    file.create();
    return file;
  }

  createDirectory(name: string): Directory {
    const dir = new Directory(this.uri, name);
    dir.create();
    return dir;
  }

  delete() {
    for (const uri of [...entries.keys()]) {
      if (uri === this.uri || uri.startsWith(`${this.uri}/`)) entries.delete(uri);
    }
  }

  async copy(destination: File | Directory, options: { overwrite?: boolean } = {}) {
    if (!this.exists) throw new Error(`ENOENT: no such directory, '${this.uri}'`);
    const target = resolveDestination(
      { uri: this.uri, name: this.name, isDir: true },
      destination,
      options.overwrite === true,
    );
    new Directory(target).guardWrite();
    for (const [uri, entry] of [...entries]) {
      if (uri !== this.uri && !uri.startsWith(`${this.uri}/`)) continue;
      entries.set(target + uri.slice(this.uri.length), { ...entry, bytes: entry.bytes.slice() });
    }
  }

  async move(destination: File | Directory, options: { overwrite?: boolean } = {}) {
    if (!this.exists) throw new Error(`ENOENT: no such directory, '${this.uri}'`);
    const target = resolveDestination(
      { uri: this.uri, name: this.name, isDir: true },
      destination,
      options.overwrite === true,
    );
    new Directory(target).guardWrite();
    const from = this.uri;
    for (const [uri, entry] of [...entries]) {
      if (uri !== from && !uri.startsWith(`${from}/`)) continue;
      entries.set(target + uri.slice(from.length), entry);
    }
    for (const uri of [...entries.keys()]) {
      if (uri === from || uri.startsWith(`${from}/`)) entries.delete(uri);
    }
    this.uri = target;
  }
}

/**
 * What the system picker returns next.
 *
 * `null` is a cancel, which the import path has to treat as "nothing added"
 * rather than a failure. The URI is set by the test standing in for the person
 * choosing a folder.
 */
export const picker = {
  directory: null as string | null,
  file: null as string | null,
};

/* Statics on the classes, as the real module has them. */
Object.assign(Directory, {
  async pickDirectoryAsync(): Promise<Directory | null> {
    return picker.directory === null ? null : new Directory(picker.directory);
  },
});

Object.assign(File, {
  async pickFileAsync(): Promise<File | null> {
    return picker.file === null ? null : new File(picker.file);
  },
});

/** The real module's enum, as far as anything here uses it. */
export const FileMode = {
  Read: 'r',
  ReadOnly: 'r',
  Write: 'w',
  ReadWrite: 'rw',
  Append: 'a',
} as const;

/** The app's own storage, and the only number the copy path asks for. */
export const DOCUMENT_ROOT = 'file:///data/app/documents';

export const Paths = {
  document: DOCUMENT_ROOT,
  cache: 'file:///data/app/cache',
  get availableDiskSpace() {
    return faults.freeBytes;
  },
  get totalDiskSpace() {
    return 64 * 1024 * 1024 * 1024;
  },
};

/* ------------------------------------------------------------------------ */

/**
 * Builds a tree from a nested description.
 *
 * A string value is a file with that text; a number is a file of that many
 * bytes, which is what grouping and the budget care about; an object is a
 * folder. Written this way because the shapes that matter here are shapes —
 * `Disc 1/`, a cover beside the audio, junk the platform leaves behind — and
 * they should be legible in the test that needs them.
 */
export type Tree = { [name: string]: Tree | string | number | Uint8Array };

export function build(root: string, tree: Tree) {
  new Directory(root).create({ intermediates: true, idempotent: true });
  const walk = (at: string, node: Tree) => {
    for (const [name, value] of Object.entries(node)) {
      const uri = `${at}/${name}`;
      if (typeof value === 'number') {
        entries.set(uri, { kind: 'file', bytes: new Uint8Array(value), modifiedMs: 1 });
      } else if (typeof value === 'string') {
        entries.set(uri, { kind: 'file', bytes: bytesOf(value), modifiedMs: 1 });
      } else if (value instanceof Uint8Array) {
        entries.set(uri, { kind: 'file', bytes: value, modifiedMs: 1 });
      } else {
        entries.set(uri, { kind: 'dir', bytes: new Uint8Array(), modifiedMs: 1 });
        walk(uri, value);
      }
    }
  };
  walk(trim(root), tree);
}

/** Every URI that exists, sorted — for asserting on what a write left behind. */
export function listAll(prefix = ''): string[] {
  return [...entries.keys()].filter((uri) => uri.startsWith(prefix)).sort();
}

export function readText(uri: string): string | null {
  const found = entries.get(trim(uri));
  return found ? new TextDecoder().decode(found.bytes) : null;
}

export function sizeOf(uri: string): number | null {
  const found = entries.get(trim(uri));
  return found ? found.bytes.length : null;
}

/* ------------------------------------------------------------------------ */

const native = (text: string) => ({
  url: `data:text/javascript,${encodeURIComponent(text)}`,
  shortCircuit: true as const,
});

/**
 * Points `expo-file-system` at this module, and teaches Node the two things
 * the bundler does for the app: the `@/` alias, and extension-less relative
 * imports.
 */
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-file-system') {
      const here = pathToFileURL(path.resolve('tests/fakeDrive.ts')).href;
      return native(
        `export { File, Directory, FileMode, Paths, FileHandle } from ${JSON.stringify(here)};`,
      );
    }
    if (specifier.startsWith('@/')) {
      // `<name>.ts` first, then `<name>/index.ts`: the bundler resolves a
      // folder to its index and several modules here are folders
      // (`@/lib/metadata`, `@/data`).
      const base = path.resolve('src', specifier.slice(2));
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`fakeDrive: cannot resolve ${specifier}`);
    }
    if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith('file:') &&
      !path.extname(specifier)
    ) {
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
});

export function deregisterDriveHooks() {
  hooks.deregister();
}
