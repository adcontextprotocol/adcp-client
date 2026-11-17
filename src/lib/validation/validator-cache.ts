/**
 * Opt-in on-disk cache of compiled bundled-schema validators.
 *
 * Enabled only when `ADCP_VALIDATOR_CACHE_DIR` names an absolute directory.
 * schema-loader requires this module only in that case, so with the variable
 * unset the SDK touches no cache files and loads no cache code.
 *
 * An entry is Ajv's standalone module for one compiled validator, stored under
 * a key that digests every input of the compile (see schema-loader). Entries
 * are executable code, so the directory and every entry must belong to the
 * current user and be closed to group and other users, entries are written
 * atomically, and each body is checked against the SHA-256 in its header
 * before it is evaluated. Any doubt (wrong owner or mode, symlink, digest
 * mismatch, truncation, evaluation error) means the caller compiles live.
 *
 * The same directory also holds JSON data entries under the same rules
 * (schema-root document identities, see schema-loader's persistRootCheck).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInThisContext } from 'node:vm';

const FORMAT = 1;
const HEADER_PREFIX = '// adcp-validator-cache ';
const ENTRY_SUFFIX = '.js';
const DATA_SUFFIX = '.json';
const TMP_SUFFIX = '.tmp';
const ORPHAN_TMP_AGE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export interface CachedValidatorEntry {
  /** The validator function, as Ajv's standalone module exports it. */
  validate: ((data: unknown) => boolean) & { errors?: unknown };
  /** The raw root `$id` of the schema the validator was compiled from, when it was a string. */
  rootSchemaId: string | undefined;
}

export interface ValidatorCache {
  read(key: string): CachedValidatorEntry | undefined;
  write(key: string, moduleCode: string, rootSchemaId: string | undefined): void;
  /** The JSON value stored under `key` by {@link ValidatorCache.writeData}, or `undefined`. */
  readData(key: string): unknown;
  /** Store a JSON value under `key`, with the same integrity and ownership rules as validators. */
  writeData(key: string, value: unknown): void;
}

interface EntryHeader {
  format: number;
  sha256: string;
  rootSchemaId: string | null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A directory the current user owns that no other user can write into. */
function isPrivateDirectory(dir: string, uid: number, requireOwnerOnly: boolean): boolean {
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (stat.uid !== uid) return false;
    return requireOwnerOnly ? (stat.mode & 0o077) === 0 : (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function maxBytes(): number {
  const raw = process.env.ADCP_VALIDATOR_CACHE_MAX_MB;
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value * 1024 * 1024) : DEFAULT_MAX_BYTES;
}

/**
 * Open the cache at `dir`, or return `undefined` when it cannot be used
 * safely. `requireFrom` anchors module resolution for the generated code
 * (`ajv/dist/runtime/*`, `ajv-formats/dist/formats`), so cached code resolves
 * the same packages as the loader that compiled it.
 */
export function openValidatorCache(dir: string, requireFrom: string): ValidatorCache | undefined {
  if (!path.isAbsolute(dir) || typeof process.getuid !== 'function') return undefined;
  const uid = process.getuid();
  const entries = path.join(dir, `v${FORMAT}`);
  // Check the configured directory before creating anything inside it.
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  if (!isPrivateDirectory(dir, uid, false)) return undefined;
  try {
    mkdirSync(entries, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
  }
  if (!isPrivateDirectory(entries, uid, true)) return undefined;
  const moduleRequire = createRequire(requireFrom);
  const limit = maxBytes();

  const entryPath = (key: string): string => path.join(entries, `${key}${ENTRY_SUFFIX}`);
  const discard = (file: string): void => {
    try {
      unlinkSync(file);
    } catch {
      // Another process may have replaced or removed it.
    }
  };

  const prune = (): void => {
    let names: string[];
    try {
      names = readdirSync(entries);
    } catch {
      return;
    }
    const now = Date.now();
    const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const name of names) {
      const file = path.join(entries, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (name.endsWith(TMP_SUFFIX)) {
        if (now - stat.mtimeMs > ORPHAN_TMP_AGE_MS) discard(file);
        continue;
      }
      files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      total += stat.size;
    }
    if (total <= limit) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of files) {
      if (total <= limit) break;
      discard(entry.file);
      total -= entry.size;
    }
  };

  /**
   * The verified body of an entry file, or `undefined` (and the file removed
   * when it is damaged). Reads the bytes once through a descriptor opened
   * without following symlinks, after checking owner and mode on it.
   */
  const readVerified = (file: string): { header: EntryHeader; body: string } | undefined => {
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return undefined;
    }
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return undefined;
      bytes = readFileSync(fd);
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
    const text = bytes.toString('utf8');
    const newline = text.indexOf('\n');
    let header: EntryHeader | undefined;
    try {
      if (newline > 0 && text.startsWith(HEADER_PREFIX)) {
        header = JSON.parse(text.slice(HEADER_PREFIX.length, newline)) as EntryHeader;
      }
    } catch {
      header = undefined;
    }
    const body = newline > 0 ? text.slice(newline + 1) : '';
    if (!header || header.format !== FORMAT || header.sha256 !== sha256(body)) {
      discard(file);
      return undefined;
    }
    return { header, body };
  };

  /** Write `body` under `file` atomically: a private temp file, then rename. */
  const writeAtomic = (key: string, file: string, header: EntryHeader, body: string): boolean => {
    const tmp = path.join(entries, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`);
    try {
      writeFileSync(tmp, `${HEADER_PREFIX}${JSON.stringify(header)}\n${body}`, { flag: 'wx', mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch {
      discard(tmp);
      return false;
    }
  };

  const touch = (file: string): void => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // Recency only drives pruning.
    }
  };

  return {
    read(key) {
      const file = entryPath(key);
      const entry = readVerified(file);
      if (!entry) return undefined;
      const { header, body } = entry;
      let validate: CachedValidatorEntry['validate'];
      try {
        const factory = runInThisContext(`(function (require, module, exports) {${body}\n})`, {
          filename: file,
        }) as (req: NodeRequire, mod: { exports: unknown }, exp: unknown) => void;
        const mod: { exports: unknown } = { exports: {} };
        factory(moduleRequire, mod, mod.exports);
        validate = mod.exports as CachedValidatorEntry['validate'];
        if (typeof validate !== 'function') throw new Error('not a validator');
      } catch {
        discard(file);
        return undefined;
      }
      // Standalone modules export the function as both module.exports and
      // its .default; a live validator has no .default, and starts with
      // errors = null.
      delete (validate as { default?: unknown }).default;
      validate.errors = null;
      touch(file);
      return { validate, rootSchemaId: typeof header.rootSchemaId === 'string' ? header.rootSchemaId : undefined };
    },

    write(key, moduleCode, rootSchemaId) {
      const header: EntryHeader = { format: FORMAT, sha256: sha256(moduleCode), rootSchemaId: rootSchemaId ?? null };
      if (writeAtomic(key, entryPath(key), header, moduleCode)) prune();
    },

    readData(key) {
      const file = path.join(entries, `${key}${DATA_SUFFIX}`);
      const entry = readVerified(file);
      if (!entry) return undefined;
      try {
        const value = JSON.parse(entry.body) as unknown;
        touch(file);
        return value;
      } catch {
        discard(file);
        return undefined;
      }
    },

    writeData(key, value) {
      const body = JSON.stringify(value);
      const header: EntryHeader = { format: FORMAT, sha256: sha256(body), rootSchemaId: null };
      if (writeAtomic(key, path.join(entries, `${key}${DATA_SUFFIX}`), header, body)) prune();
    },
  };
}

/** SHA-256 of the given files' bytes (missing files contribute their name only). */
export function filesDigest(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${path.basename(file)}\0`);
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update('missing');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Cache key over a JSON-serializable list of compile inputs. */
export function validatorCacheKey(parts: readonly unknown[]): string {
  return sha256(JSON.stringify([FORMAT, ...parts]));
}
