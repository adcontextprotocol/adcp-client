/**
 * Storyboard YAML parsing, with an opt-in cross-process cache.
 *
 * Every storyboard and discovery process parses the same compliance YAML. With
 * `ADCP_VALIDATOR_CACHE_DIR` set to an absolute directory, the parsed document
 * is stored there as a JSON data entry (see validation/validator-cache) and the
 * next process reads it back instead of parsing. The entry key digests the
 * document text, this module's code, the `yaml` package version and the SDK
 * version, so a changed file or parser is a miss and an entry cannot go stale.
 *
 * Only clean parses are stored: a document with YAML errors or warnings goes
 * through `parse` every time, so it throws or warns exactly as before. A value
 * is stored only when it survives the JSON round trip unchanged; objects that
 * YAML aliases share are recorded and shared again on read. Each call returns
 * new objects. With the variable unset, empty or relative, this is `parse`.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, parseDocument } from 'yaml';
import type { ValidatorCache } from '../../validation/validator-cache';
import { LIBRARY_VERSION } from '../../version';

const ENTRY_KIND = 'storyboard-yaml';

/** Path segments from the document root to a value. */
type ValuePath = Array<string | number>;

/** A stored document: the value, plus each repeated object as [path, path of its first occurrence]. */
interface StoredDocument {
  value: unknown;
  shared: Array<[ValuePath, ValuePath]>;
}

/** Same rule as schema-loader: a non-empty absolute path, else the cache is off. */
function cacheDir(): string | undefined {
  const dir = process.env.ADCP_VALIDATOR_CACHE_DIR;
  return dir && path.isAbsolute(dir) ? dir : undefined;
}

let opened: { dir: string; cache: ValidatorCache | undefined } | undefined;
let staticKey: unknown[] | undefined;

function openCache(dir: string): ValidatorCache | undefined {
  if (opened?.dir !== dir) {
    const { openValidatorCache } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../validation/validator-cache') as typeof import('../../validation/validator-cache');
    opened = { dir, cache: openValidatorCache(dir, path.join(__dirname, 'yaml-cache.js')) };
  }
  return opened.cache;
}

/** The parser inputs besides the text: this module's code, `yaml` and the SDK version. */
function parserKey(): unknown[] {
  if (staticKey) return staticKey;
  const { filesDigest } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../validation/validator-cache') as typeof import('../../validation/validator-cache');
  let yamlVersion: string | null = null;
  try {
    const moduleRequire = createRequire(path.join(__dirname, 'yaml-cache.js'));
    yamlVersion = (moduleRequire('yaml/package.json') as { version?: string }).version ?? null;
  } catch {
    // The code digest and SDK version still key the entry.
  }
  staticKey = [
    LIBRARY_VERSION,
    filesDigest(['yaml-cache.js', 'yaml-cache.mjs'].map(file => path.join(__dirname, file))),
    yamlVersion,
  ];
  return staticKey;
}

/** Each object reached a second time, as [its path, the path where it was first reached]. */
function sharedObjects(root: unknown): Array<[ValuePath, ValuePath]> {
  const firstPath = new Map<object, ValuePath>();
  const shared: Array<[ValuePath, ValuePath]> = [];
  const visit = (value: unknown, at: ValuePath): void => {
    if (value === null || typeof value !== 'object') return;
    const first = firstPath.get(value);
    if (first) {
      shared.push([at, first]);
      return;
    }
    firstPath.set(value, at);
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...at, index]));
    else for (const [key, item] of Object.entries(value)) visit(item, [...at, key]);
  };
  visit(root, []);
  return shared;
}

/** The value with every repeated object written out once, as null, so JSON can hold it. */
function withoutRepeats(root: unknown, shared: Array<[ValuePath, ValuePath]>): unknown {
  if (shared.length === 0) return root;
  const repeats = new Set(shared.map(([at]) => JSON.stringify(at)));
  const copy = (value: unknown, at: ValuePath): unknown => {
    if (repeats.has(JSON.stringify(at))) return null;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item, index) => copy(item, [...at, index]));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = copy(item, [...at, key]);
    return out;
  };
  return copy(root, []);
}

function valueAt(root: unknown, at: ValuePath): unknown {
  let value = root;
  for (const segment of at) value = (value as Record<string | number, unknown>)[segment];
  return value;
}

/** The document a stored entry describes, as new objects with the original sharing. */
function restore(stored: StoredDocument): unknown {
  const value = stored.value;
  for (const [at, first] of stored.shared) {
    const parent = valueAt(value, at.slice(0, -1)) as Record<string | number, unknown>;
    parent[at[at.length - 1]!] = valueAt(value, first);
  }
  return value;
}

function isStoredDocument(value: unknown): value is StoredDocument {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'value') &&
    Array.isArray((value as StoredDocument).shared)
  );
}

/**
 * The entry to store for a parsed document, or `undefined` when JSON cannot
 * reproduce it (non-finite numbers, -0, non-plain objects and the like).
 */
function storable(document: unknown): StoredDocument | undefined {
  const shared = sharedObjects(document);
  let json: string | undefined;
  try {
    json = JSON.stringify({ value: withoutRepeats(document, shared), shared });
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  const stored = JSON.parse(json) as StoredDocument;
  const restored = restore(JSON.parse(json) as StoredDocument);
  if (!isDeepStrictEqual(restored, document)) return undefined;
  if (!isDeepStrictEqual(sharedObjects(restored), shared)) return undefined;
  return stored;
}

/**
 * Parse a storyboard YAML document: the result of `yaml`'s `parse(source)`,
 * read from the opt-in cache when an earlier process stored it.
 */
export function parseStoryboardYaml(source: string): unknown {
  const dir = cacheDir();
  if (dir === undefined) return parse(source);
  const cache = openCache(dir);
  if (!cache) return parse(source);
  const { validatorCacheKey } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../validation/validator-cache') as typeof import('../../validation/validator-cache');
  const key = validatorCacheKey([
    ENTRY_KIND,
    ...parserKey(),
    createHash('sha256').update(source, 'utf8').digest('hex'),
  ]);
  const hit = cache.readData(key);
  if (isStoredDocument(hit)) {
    try {
      return restore(hit);
    } catch {
      // A malformed entry is a miss; the write below replaces it.
    }
  }

  // parse() is parseDocument() followed by logging warnings, throwing the
  // first error and toJS(); a clean document skips straight to toJS().
  const doc = parseDocument(source);
  if (doc.errors.length > 0 || doc.warnings.length > 0) return parse(source);
  const document: unknown = doc.toJS();
  const stored = storable(document);
  if (stored) cache.writeData(key, stored);
  return document;
}
