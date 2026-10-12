import { createHash, randomInt, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { canonicalize } from '../../utils/jcs';
import { ReportingRowStoreError } from './row-storage-errors';
import { reportingPeriodDate } from './schedule';

/**
 * Object-storage providers for revision row chunks (shared SDK persistence
 * spec, adcontextprotocol/adcp#7996 §3.3–§3.4).
 *
 * A provider is a thin, credential-free port over one object store. It never
 * decides where bytes go: keys are rendered by the SDK from an allowlisted
 * binding, and every byte a provider returns is verified against digests
 * committed in PostgreSQL before rows are released.
 */

export interface ReportingRowObjectContextV1 {
  signal: AbortSignal;
}

export interface ReportingRowObjectLocationV1 {
  /** Non-secret provider coordinates (bucket, container, filesystem root name, endpoint host). */
  readonly location: Readonly<Record<string, string>>;
  /** Host-mapped client reference; never a secret. */
  readonly credentialRef?: string;
}

/**
 * Bounds AdCP puts on `object_ref` and `native_version_ref`
 * (`reporting-file-object-ref.json`, `reporting-native-version-ref.json`):
 * 1 to 1024 characters. The row-storage `CHECK` constraints enforce the same.
 */
export const REPORTING_ROW_OBJECT_REF_MAX_LENGTH = 1024;
export const REPORTING_ROW_NATIVE_VERSION_REF_MAX_LENGTH = 1024;

export interface ReportingRowObjectPutInputV1 extends ReportingRowObjectLocationV1 {
  /** AdCP `object_ref`: decoded, destination-relative object key. */
  objectRef: string;
  bytes: Uint8Array;
  contentType: 'application/x-ndjson' | 'application/gzip';
  /** Non-secret object metadata (installation and intent identifiers). */
  metadata: Readonly<Record<string, string>>;
}

export interface ReportingRowObjectGetInputV1 extends ReportingRowObjectLocationV1 {
  objectRef: string;
  /** AdCP `native_version_ref`: the exact native version recorded at write time. */
  nativeVersionRef: string;
  /** Byte range within the stored object; omit for the whole object. */
  range?: { offset: number; length: number };
  /** Hard cap on bytes read; providers abort beyond it. */
  maxBytes: number;
}

export interface ReportingRowObjectDeleteInputV1 extends ReportingRowObjectLocationV1 {
  objectRef: string;
  nativeVersionRef: string;
}

export interface ReportingRowObjectStatInputV1 extends ReportingRowObjectLocationV1 {
  objectRef: string;
  nativeVersionRef: string;
}

export interface ReportingRowObjectProviderV1 {
  /** Registry name, e.g. `filesystem`, `gcs`, `s3`, `azure_blob`. */
  readonly name: string;
  /** Whether `get` honours `range` without reading the whole object. */
  readonly rangedReads: boolean;
  /**
   * Validate binding coordinates against the provider's closed schema. Throw
   * `INVALID_INPUT` for unknown fields or values that could carry secrets.
   */
  validateLocation(location: Readonly<Record<string, string>>): void;
  /** Fail closed (`UNSAFE_BINDING`) when the destination is unsafe or create-only writes are not enforced. */
  probe(input: ReportingRowObjectLocationV1 & { prefix: string }, context: ReportingRowObjectContextV1): Promise<void>;
  /**
   * Create-only write. Returns `created: true` with the new native version, or
   * `created: false` with the existing object's version when the key is taken.
   * Must never replace an existing object.
   */
  putIfAbsent(
    input: ReportingRowObjectPutInputV1,
    context: ReportingRowObjectContextV1
  ): Promise<{ created: boolean; nativeVersionRef: string }>;
  /** Bytes at the exact native version, or `null` when that version is absent. */
  get(input: ReportingRowObjectGetInputV1, context: ReportingRowObjectContextV1): Promise<Uint8Array | null>;
  /**
   * Metadata of the exact native version without reading its bytes: the version it resolved (which must equal the
   * requested `nativeVersionRef`) and its stored size (`size_bytes`), or `null` when that version is absent. Optional. The commit transaction uses it to
   * prove an adopted object is unchanged (native versions are write-unique, so the same version at
   * the recorded size is the same bytes) without downloading it under the account lock. A provider
   * without `stat` falls back to a full read there. Never return a size for a different version.
   */
  stat?(
    input: ReportingRowObjectStatInputV1,
    context: ReportingRowObjectContextV1
  ): Promise<{ nativeVersionRef: string; sizeBytes: number } | null>;
  /** Delete the exact native version. Idempotent: `absent` is success. */
  delete(input: ReportingRowObjectDeleteInputV1, context: ReportingRowObjectContextV1): Promise<'deleted' | 'absent'>;
}

/**
 * Placeholders allowed in object key templates. `{period_date}` renders AdCP's `YYYY-MM-DD`: the calendar
 * date of the period start in the period's `source_timezone` (never UTC, unless that is the source
 * timezone). It is one path segment, so the default layout is
 * `.../{account_key}/2026-10-02/{finality}/...`.
 */
export const REPORTING_ROW_KEY_PLACEHOLDERS = Object.freeze([
  'prefix',
  'namespace_key',
  'account_key',
  'period_date',
  'finality',
  'revision_key',
  'content_sha256',
  'chunk_index',
] as const);

export const REPORTING_ROW_DEFAULT_KEY_TEMPLATE =
  '{prefix}/{namespace_key}/{account_key}/{period_date}/{finality}/{revision_key}/{content_sha256}/{chunk_index}';

const PREFIX = /^[A-Za-z0-9_.=-]+(?:\/[A-Za-z0-9_.=-]+)*$/;
const KEY = /^[A-Za-z0-9_.=-]+(?:\/[A-Za-z0-9_.=-]+)*$/;
const PLACEHOLDER = /\{([a-z0-9_]+)\}/g;

/** Validate an object key template; throws `INVALID_INPUT`. */
export function assertReportingRowKeyTemplateV1(template: string): void {
  if (!template.startsWith('{prefix}/{namespace_key}/')) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'key templates must begin with {prefix}/{namespace_key}/');
  }
  for (const required of ['{content_sha256}', '{chunk_index}']) {
    if (!template.includes(required)) {
      throw new ReportingRowStoreError('INVALID_INPUT', `key templates must include ${required}`);
    }
  }
  const unknown = [...template.matchAll(PLACEHOLDER)]
    .map(match => match[1]!)
    .filter(name => !(REPORTING_ROW_KEY_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ReportingRowStoreError('INVALID_INPUT', `unknown key template placeholders: ${unknown.join(', ')}`);
  }
  const literal = template.replace(PLACEHOLDER, 'x');
  if (!KEY.test(literal) || literal.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'key template contains unsafe characters or segments');
  }
}

export function assertReportingRowPrefixV1(prefix: string): void {
  if (
    !PREFIX.test(prefix) ||
    prefix.length > 512 ||
    prefix.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'row binding prefix is invalid');
  }
}

/** Pseudonymous account segment; never a raw account ID. */
export function reportingRowAccountKeyV1(namespaceKey: string, accountId: string): string {
  return sha256Hex(canonicalize(['adcp.account_key.v1', namespaceKey, accountId]));
}

export function reportingRowRevisionKeyV1(rowSetId: string): string {
  return sha256Hex(canonicalize(['adcp.revision_key.v1', rowSetId]));
}

/** Render one chunk's object key and confine it to the binding's owned prefix. */
export function renderReportingRowObjectKeyV1(input: {
  template: string;
  prefix: string;
  namespaceKey: string;
  accountId: string;
  rowSetId: string;
  /** Period start instant; with `sourceTimezone`, renders `{period_date}`. Absent renders `undated`. */
  periodStart?: string;
  /** The period's `source_timezone`; required whenever `periodStart` is set. Invalid values fail closed. */
  sourceTimezone?: string;
  finality?: 'snapshot' | 'official';
  contentSha256: string;
  chunkIndex: number;
  compression: 'none' | 'gzip';
}): string {
  const values: Record<string, string> = {
    prefix: input.prefix,
    namespace_key: input.namespaceKey,
    account_key: reportingRowAccountKeyV1(input.namespaceKey, input.accountId),
    // Rendered only when the template uses it, so a template without {period_date} needs no timezone.
    period_date: input.template.includes('{period_date}')
      ? renderedPeriodDate(input.periodStart, input.sourceTimezone)
      : '',
    finality: input.finality ?? 'adjustment',
    revision_key: reportingRowRevisionKeyV1(input.rowSetId),
    content_sha256: input.contentSha256,
    chunk_index: String(input.chunkIndex).padStart(6, '0'),
  };
  const key =
    input.template.replace(PLACEHOLDER, (_, name: string) => values[name]!) +
    (input.compression === 'gzip' ? '.jsonl.gz' : '.jsonl');
  if (
    !KEY.test(key) ||
    key.split('/').some(segment => segment === '.' || segment === '..') ||
    !key.startsWith(`${input.prefix}/${input.namespaceKey}/`)
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'rendered object key escapes the binding prefix');
  }
  if (key.length > REPORTING_ROW_OBJECT_REF_MAX_LENGTH) {
    throw new ReportingRowStoreError(
      'INVALID_INPUT',
      `rendered object key exceeds ${REPORTING_ROW_OBJECT_REF_MAX_LENGTH} characters (AdCP object_ref bound)`
    );
  }
  return key;
}

function renderedPeriodDate(periodStart: string | undefined, sourceTimezone: string | undefined): string {
  if (!periodStart) return 'undated';
  if (!sourceTimezone) {
    throw new ReportingRowStoreError(
      'INVALID_INPUT',
      'a period start needs its source_timezone to render {period_date}'
    );
  }
  try {
    return reportingPeriodDate(periodStart, sourceTimezone);
  } catch {
    throw new ReportingRowStoreError(
      'INVALID_INPUT',
      'period start or source_timezone is invalid; cannot render {period_date}'
    );
  }
}

export interface FilesystemReportingRowObjectProviderOptionsV1 {
  /**
   * Root name → absolute directory. Bindings name a root (`location.root`);
   * they never carry paths, so the database cannot point writes elsewhere.
   */
  roots: Readonly<Record<string, string>>;
}

/**
 * Local filesystem provider for tests and single-host deployments. Create-only
 * writes use a temporary file, `fsync`, and `link()` to the final name, which
 * fails rather than replacing an existing object.
 */
export function createFilesystemReportingRowObjectProviderV1(
  options: FilesystemReportingRowObjectProviderOptionsV1
): ReportingRowObjectProviderV1 {
  const roots = new Map<string, string>();
  for (const [name, directory] of Object.entries(options.roots)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !path.isAbsolute(directory)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'filesystem roots need a simple name and an absolute path');
    }
    roots.set(name, path.resolve(directory));
  }
  const resolve = (location: Readonly<Record<string, string>>, key: string) => {
    const root = roots.get(location.root ?? '');
    if (!root) throw new ReportingRowStoreError('UNSAFE_BINDING', 'filesystem root is not configured');
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'object key escapes the filesystem root');
    }
    return target;
  };
  // Write-unique: inode numbers are reused after a delete, so the version also carries
  // nanosecond birth and modify times (not ctime, which changes when the temporary link is
  // removed). `putIfAbsent` stamps a random sub-millisecond mtime so an identical
  // re-creation inside one coarse timestamp tick still differs. Filesystems with whole-second
  // mtime truncate the stamp away; `write-unique-version` conformance refuses them.
  const versionOf = (stat: { ino: bigint; birthtimeNs: bigint; mtimeNs: bigint; size: bigint }) =>
    `${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.size}`;
  const version = async (target: string) => versionOf(await fs.stat(target, { bigint: true }));
  return {
    name: 'filesystem',
    rangedReads: true,
    validateLocation(location) {
      const keys = Object.keys(location);
      if (keys.length !== 1 || keys[0] !== 'root' || !roots.has(location.root!)) {
        throw new ReportingRowStoreError('INVALID_INPUT', 'filesystem locations name exactly one configured root');
      }
    },
    async probe(input) {
      const root = roots.get(input.location.root ?? '');
      if (!root) throw new ReportingRowStoreError('UNSAFE_BINDING', 'filesystem root is not configured');
      await fs.mkdir(root, { recursive: true });
    },
    async putIfAbsent(input, context) {
      context.signal.throwIfAborted();
      const target = resolve(input.location, input.objectRef);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(input.bytes);
        const mtime = Date.now() / 1000 + randomInt(0, 1000) / 1_000_000;
        await handle.utimes(mtime, mtime);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temporary, target);
        return { created: true, nativeVersionRef: await version(target) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { created: false, nativeVersionRef: await version(target) };
        }
        throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'filesystem write failed');
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async get(input, context) {
      context.signal.throwIfAborted();
      const target = resolve(input.location, input.objectRef);
      let handle;
      try {
        handle = await fs.open(target, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'filesystem read failed');
      }
      try {
        const stat = await handle.stat({ bigint: true });
        if (versionOf(stat) !== input.nativeVersionRef) return null;
        const size = Number(stat.size);
        const offset = input.range?.offset ?? 0;
        const length = input.range?.length ?? size - offset;
        if (offset < 0 || length < 0 || offset + length > size) {
          throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
        }
        if (length > input.maxBytes) {
          throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'stored object exceeds its recorded size');
        }
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        return buffer;
      } finally {
        await handle.close();
      }
    },
    async stat(input, context) {
      context.signal.throwIfAborted();
      const target = resolve(input.location, input.objectRef);
      try {
        const stat = await fs.stat(target, { bigint: true });
        return versionOf(stat) === input.nativeVersionRef
          ? { nativeVersionRef: input.nativeVersionRef, sizeBytes: Number(stat.size) }
          : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'filesystem stat failed');
      }
    },
    async delete(input, context) {
      context.signal.throwIfAborted();
      const target = resolve(input.location, input.objectRef);
      try {
        if ((await version(target)) !== input.nativeVersionRef) return 'absent';
        await fs.unlink(target);
        return 'deleted';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'filesystem delete failed');
      }
    },
  };
}

/**
 * Behavioural conformance for a custom object provider. Writes and deletes
 * only under `prefix`; run it against a dedicated test bucket or prefix.
 * Resolves with the checks that passed; rejects on the first violation.
 */
export async function runReportingRowObjectProviderConformanceV1(
  provider: ReportingRowObjectProviderV1,
  input: ReportingRowObjectLocationV1 & { prefix: string }
): Promise<string[]> {
  assertReportingRowPrefixV1(input.prefix);
  provider.validateLocation(input.location);
  const context = { signal: AbortSignal.timeout(60_000) };
  const passed: string[] = [];
  const key = `${input.prefix}/conformance/${randomUUID()}.jsonl`;
  const first = Buffer.from('{"a":1}\n{"b":2}\n');
  const metadata = { 'adcp-installation': 'conformance', 'adcp-intent': 'conformance' };
  const base = { location: input.location, ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}) };
  await provider.probe(input, context);
  passed.push('probe');
  const created = await provider.putIfAbsent(
    { ...base, objectRef: key, bytes: first, contentType: 'application/x-ndjson', metadata },
    context
  );
  if (!created.created || !created.nativeVersionRef) throw new Error('putIfAbsent did not create a new object');
  passed.push('create');
  const conflict = await provider.putIfAbsent(
    { ...base, objectRef: key, bytes: Buffer.from('{"c":3}\n'), contentType: 'application/x-ndjson', metadata },
    context
  );
  if (conflict.created || conflict.nativeVersionRef !== created.nativeVersionRef) {
    throw new Error('putIfAbsent replaced or re-versioned an existing object');
  }
  const stored = await provider.get(
    { ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef, maxBytes: 1024 },
    context
  );
  if (!stored || !Buffer.from(stored).equals(first))
    throw new Error('create-only write did not preserve the first bytes');
  passed.push('create-only');
  if (provider.rangedReads) {
    const ranged = await provider.get(
      {
        ...base,
        objectRef: key,
        nativeVersionRef: created.nativeVersionRef,
        range: { offset: 8, length: 8 },
        maxBytes: 1024,
      },
      context
    );
    if (!ranged || Buffer.from(ranged).toString('utf8') !== '{"b":2}\n')
      throw new Error('ranged read returned wrong bytes');
    passed.push('ranged-read');
  }
  if (
    (await provider.get({ ...base, objectRef: key, nativeVersionRef: 'not-a-version', maxBytes: 1024 }, context)) !==
    null
  ) {
    throw new Error('get returned bytes for a version that does not exist');
  }
  passed.push('version-pinned-read');
  if (provider.stat) {
    const stat = await provider.stat({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context);
    if (!stat || stat.sizeBytes !== first.byteLength) throw new Error('stat did not report the stored object size');
    if (stat.nativeVersionRef !== created.nativeVersionRef) throw new Error('stat did not echo the version it checked');
    if ((await provider.stat({ ...base, objectRef: key, nativeVersionRef: 'not-a-version' }, context)) !== null) {
      throw new Error('stat returned metadata for a version that does not exist');
    }
    passed.push('version-pinned-stat');
  }
  if ((await provider.delete({ ...base, objectRef: key, nativeVersionRef: 'not-a-version' }, context)) !== 'absent') {
    throw new Error('delete removed an object at a different version');
  }
  if (
    (await provider.delete({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context)) !==
    'deleted'
  ) {
    throw new Error('delete did not remove the exact version');
  }
  if (
    (await provider.delete({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context)) !==
    'absent'
  ) {
    throw new Error('repeated delete was not idempotent');
  }
  passed.push('exact-version-delete');
  if (
    provider.stat &&
    (await provider.stat({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context)) !== null
  ) {
    throw new Error('stat returned metadata for a deleted version');
  }
  // A delayed delete of an old version must never remove a later write at the same key, even
  // one with identical bytes: native versions must be unique per write, not content-derived.
  const recreated = await provider.putIfAbsent(
    { ...base, objectRef: key, bytes: first, contentType: 'application/x-ndjson', metadata },
    context
  );
  if (!recreated.created || !recreated.nativeVersionRef)
    throw new Error('putIfAbsent did not re-create a deleted object');
  if (recreated.nativeVersionRef === created.nativeVersionRef) {
    throw new Error('re-creating identical bytes produced the same native version; versions must be write-unique');
  }
  if (
    (await provider.delete({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context)) !==
    'absent'
  ) {
    throw new Error('delete of a stale version removed or reported a later write');
  }
  if (provider.stat) {
    // A stale version must never be proven present by a later write at the same key, even with identical bytes.
    if (
      (await provider.stat({ ...base, objectRef: key, nativeVersionRef: created.nativeVersionRef }, context)) !== null
    ) {
      throw new Error('stat of a stale version reported a later write at the same key');
    }
    const current = await provider.stat(
      { ...base, objectRef: key, nativeVersionRef: recreated.nativeVersionRef },
      context
    );
    if (!current || current.sizeBytes !== first.byteLength || current.nativeVersionRef !== recreated.nativeVersionRef) {
      throw new Error('stat did not report the re-created object');
    }
  }
  const survivor = await provider.get(
    { ...base, objectRef: key, nativeVersionRef: recreated.nativeVersionRef, maxBytes: 1024 },
    context
  );
  if (!survivor || !Buffer.from(survivor).equals(first)) {
    throw new Error('delete of a stale version removed a later write with identical bytes');
  }
  if (
    (await provider.delete({ ...base, objectRef: key, nativeVersionRef: recreated.nativeVersionRef }, context)) !==
    'deleted'
  ) {
    throw new Error('delete did not remove the re-created version');
  }
  passed.push('write-unique-version');
  return passed;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
