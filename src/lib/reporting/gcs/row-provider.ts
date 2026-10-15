import { createHash } from 'node:crypto';
import type { BucketMetadata, File, FileMetadata, Storage } from '@google-cloud/storage';
import { ReportingRowStoreError } from '../ledger/row-storage-errors';
import type { ReportingRowObjectListEntryV1, ReportingRowObjectProviderV1 } from '../ledger/row-storage-object';
import {
  assertReportingRowLocationKeys,
  assertReportingRowReadBounds,
  readReportingRowStream,
  reportingRowClientMap,
  reportingRowPrefixFilterOverlaps,
  runReportingRowProviderOperation,
  selectReportingRowClient,
} from '../ledger/row-storage-provider-io';

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface CreateGcsReportingRowObjectProviderOptionsV1 {
  /** Official client used by bindings without a `credentialRef`. */
  storage?: Storage;
  /**
   * Official clients keyed by `credentialRef`. This map is the closed set of
   * references a binding may name; an unknown reference fails `UNSAFE_BINDING`.
   */
  clients?: Readonly<Record<string, Storage>>;
}

const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
// Generations are microsecond timestamps; the official client sends them as JS numbers.
const GENERATION = /^[1-9][0-9]{0,15}$/;
const NONCURRENT_ONLY_CONDITIONS = ['numNewerVersions', 'daysSinceNoncurrentTime', 'noncurrentTimeBefore'] as const;

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = Number((error as { code: unknown }).code);
  return Number.isInteger(code) ? code : undefined;
}

function generationOf(metadata: FileMetadata | undefined): string {
  const generation = metadata?.generation === undefined ? '' : String(metadata.generation);
  if (!GENERATION.test(generation) || !Number.isSafeInteger(Number(generation))) {
    throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'object generation is missing');
  }
  return generation;
}

function pinnedGeneration(nativeVersionRef: string): string | null {
  return typeof nativeVersionRef === 'string' &&
    GENERATION.test(nativeVersionRef) &&
    Number.isSafeInteger(Number(nativeVersionRef))
    ? nativeVersionRef
    : null;
}

/**
 * Row-binding bucket policy (shared persistence spec §3.4). Unlike the Managed
 * Delivery probe, versioning, soft delete and retention are allowed as
 * backstops. Refused: buckets without uniform bucket-level access or enforced
 * public access prevention, and any lifecycle `Delete` rule that can match a
 * live object under the binding prefix (no prefix filter, or a prefix that
 * overlaps it). Rules limited to noncurrent versions are allowed.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function assertGcsReportingRowBucketPolicyV1(metadata: BucketMetadata, prefix: string): void {
  if (!metadata || typeof metadata !== 'object') {
    throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket policy is unavailable');
  }
  if (metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) {
    throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket must enable uniform bucket-level access');
  }
  if (metadata.iamConfiguration?.publicAccessPrevention !== 'enforced') {
    throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket must enforce public access prevention');
  }
  for (const rule of metadata.lifecycle?.rule ?? []) {
    if (rule?.action?.type !== 'Delete') continue;
    const condition = rule.condition ?? {};
    if (condition.isLive === false) continue;
    if (NONCURRENT_ONLY_CONDITIONS.some(name => condition[name] !== undefined && condition[name] !== null)) continue;
    const prefixes = condition.matchesPrefix ?? [];
    if (prefixes.length === 0 || prefixes.some(filter => reportingRowPrefixFilterOverlaps(filter, prefix))) {
      throw new ReportingRowStoreError('UNSAFE_BINDING', 'a bucket lifecycle rule can delete live row objects');
    }
  }
}

/**
 * Google Cloud Storage row-object provider (`@adcp/sdk/reporting/gcs`).
 *
 * Inject official `Storage` clients with host-owned, keyless credentials.
 * Bindings use `location: { bucket }`; `credentialRef` selects an injected
 * client. Writes are single-request uploads with `ifGenerationMatch: 0`, so an
 * existing object is never replaced; the recorded native version is the
 * object generation, and reads and deletes pin it. Objects are stored without
 * `Content-Encoding`, and reads request raw stored bytes, so GCS never
 * transcodes them.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createGcsReportingRowObjectProviderV1(
  options: CreateGcsReportingRowObjectProviderOptionsV1
): ReportingRowObjectProviderV1 {
  if (!options || typeof options !== 'object') {
    throw new ReportingRowStoreError('INVALID_INPUT', 'GCS row provider options are required');
  }
  const clients = reportingRowClientMap(options.clients);
  const isStorage = (value: unknown) =>
    !!value && typeof value === 'object' && typeof (value as Storage).bucket === 'function';
  if (
    (options.storage !== undefined && !isStorage(options.storage)) ||
    [...clients.values()].some(client => !isStorage(client)) ||
    (options.storage === undefined && clients.size === 0)
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'inject an official Storage client as storage or clients');
  }

  const validateLocation = (location: Readonly<Record<string, string>>) => {
    assertReportingRowLocationKeys(location, ['bucket']);
    if (!BUCKET.test(location.bucket!) || location.bucket!.includes('..')) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'GCS bucket name is invalid');
    }
  };
  const bucketFor = (input: { location: Readonly<Record<string, string>>; credentialRef?: string }) => {
    validateLocation(input.location);
    return selectReportingRowClient(options.storage, clients, input.credentialRef).bucket(input.location.bucket!);
  };
  const assertKey = (key: string) => {
    if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key) > 1024) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'object key is invalid');
    }
  };

  return {
    name: 'gcs',
    rangedReads: true,
    validateLocation,
    probe(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        let metadata: BucketMetadata;
        try {
          [metadata] = await bucket.getMetadata();
        } catch (error) {
          const code = status(error);
          if (code === 404) throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket does not exist');
          if (code === 401 || code === 403) {
            throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket policy cannot be read with this client');
          }
          throw error;
        }
        assertGcsReportingRowBucketPolicyV1(metadata, input.prefix);
      });
    },
    putIfAbsent(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.objectRef);
        const file = bucket.file(input.objectRef);
        try {
          const bytes = Buffer.from(input.bytes);
          await file.save(bytes, {
            resumable: false,
            gzip: false,
            // GCS verifies the declared MD5 before creating the object, so a corrupted upload
            // is refused server-side. Client-side validation is off because on mismatch the
            // client deletes the key without a generation precondition.
            validation: false,
            contentType: input.contentType,
            metadata: {
              contentType: input.contentType,
              md5Hash: createHash('md5').update(bytes).digest('base64'),
              cacheControl: 'no-store',
              metadata: { ...input.metadata },
            },
            preconditionOpts: { ifGenerationMatch: 0 },
          });
        } catch (error) {
          if (status(error) !== 412) throw error;
          context.signal.throwIfAborted();
          // The key is taken. Report the existing generation; the caller adopts it only on identical bytes.
          const [existing] = await bucket.file(input.objectRef).getMetadata();
          return { created: false, nativeVersionRef: generationOf(existing) };
        }
        if (file.metadata?.generation !== undefined) {
          return { created: true, nativeVersionRef: generationOf(file.metadata) };
        }
        const [created] = await file.getMetadata();
        return { created: true, nativeVersionRef: generationOf(created) };
      });
    },
    get(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.objectRef);
        assertReportingRowReadBounds(input);
        const generation = pinnedGeneration(input.nativeVersionRef);
        if (generation === null) return null;
        const file: File = bucket.file(input.objectRef, { generation });
        try {
          if (input.range?.length === 0) {
            const [metadata] = await file.getMetadata();
            if (input.range.offset > Number(metadata.size)) {
              throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
            }
            return Buffer.alloc(0);
          }
          const stream = file.createReadStream({
            // The client always sends `Accept-Encoding: gzip`; with `decompress: false`
            // neither GCS nor the client transcodes, so these are the stored bytes.
            decompress: false,
            // Digests recorded in PostgreSQL verify every byte returned.
            validation: false,
            ...(input.range ? { start: input.range.offset, end: input.range.offset + input.range.length - 1 } : {}),
          });
          return await readReportingRowStream(stream, input.maxBytes, context.signal);
        } catch (error) {
          const code = status(error);
          if (code === 404) return null;
          if (code === 416) {
            throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
          }
          throw error;
        }
      });
    },
    stat(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.objectRef);
        const generation = pinnedGeneration(input.nativeVersionRef);
        if (generation === null) return null;
        try {
          // A generation-pinned metadata read: 404 for any other generation, so a hit proves this exact
          // write (generations are unique per write) and its stored size without reading the bytes.
          const [metadata] = await bucket.file(input.objectRef, { generation }).getMetadata();
          const size = Number(metadata.size);
          // A store that ignores the pin and answers for another generation is not this object.
          if (String(metadata.generation) !== generation) return null;
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'object metadata is malformed');
          }
          return { nativeVersionRef: generation, sizeBytes: size };
        } catch (error) {
          if (status(error) === 404) return null;
          throw error;
        }
      });
    },
    list(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        if (typeof input.prefix !== 'string' || Buffer.byteLength(input.prefix) > 1024) {
          throw new ReportingRowStoreError('INVALID_INPUT', 'list prefix is invalid');
        }
        if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
          throw new ReportingRowStoreError('INVALID_INPUT', 'pageSize must be a positive integer');
        }
        // `versions: true` lists every generation, noncurrent ones included, so each (key, generation) a
        // delete could name is visible. On a bucket without versioning it lists the live objects.
        const [files, next] = await bucket.getFiles({
          prefix: input.prefix,
          versions: true,
          autoPaginate: false,
          maxResults: Math.min(input.pageSize, 1000),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        });
        const objects: ReportingRowObjectListEntryV1[] = [];
        for (const file of files) {
          const metadata = file.metadata as FileMetadata;
          const size = Number(metadata.size);
          // The later of the generation's creation and last metadata update: an object is never reported
          // older than it is.
          const created = Math.max(Date.parse(String(metadata.timeCreated)), Date.parse(String(metadata.updated)) || 0);
          // An entry that cannot be addressed or aged is left out: it is never collected, and one bad entry
          // must not stop the listing of the rest.
          if (
            typeof file.name !== 'string' ||
            !file.name.startsWith(input.prefix) ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            !Number.isFinite(created) ||
            !GENERATION.test(String(metadata.generation))
          ) {
            continue;
          }
          objects.push({
            objectRef: file.name,
            nativeVersionRef: generationOf(metadata),
            sizeBytes: size,
            createdAt: new Date(created).toISOString(),
          });
        }
        const token = (next as { pageToken?: unknown } | null | undefined)?.pageToken;
        return { objects, ...(typeof token === 'string' && token ? { nextPageToken: token } : {}) };
      });
    },
    delete(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.objectRef);
        const generation = pinnedGeneration(input.nativeVersionRef);
        if (generation === null) return 'absent' as const;
        try {
          // The generation parameter is the exact-version precondition: it deletes only the
          // recorded object (live or noncurrent) and returns 404 for any other generation. An
          // extra `ifGenerationMatch` would strand a recorded noncurrent generation on versioned
          // buckets, so it is deliberately not added.
          await bucket.file(input.objectRef, { generation }).delete();
          return 'deleted' as const;
        } catch (error) {
          const code = status(error);
          if (code === 404 || code === 412) return 'absent' as const;
          throw error;
        }
      });
    },
  };
}
