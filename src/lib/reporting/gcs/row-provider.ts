import { createHash } from 'node:crypto';
import type { BucketMetadata, File, FileMetadata, Storage } from '@google-cloud/storage';
import { ReportingRowStoreError } from '../ledger/row-storage-errors';
import type { ReportingRowObjectProviderV1 } from '../ledger/row-storage-object';
import {
  assertReportingRowLocationKeys,
  assertReportingRowReadBounds,
  readReportingRowStream,
  reportingRowClientMap,
  reportingRowPrefixFilterOverlaps,
  runReportingRowProviderOperation,
  selectReportingRowClient,
} from '../ledger/row-storage-provider-io';

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

function pinnedGeneration(nativeVersion: string): string | null {
  return typeof nativeVersion === 'string' &&
    GENERATION.test(nativeVersion) &&
    Number.isSafeInteger(Number(nativeVersion))
    ? nativeVersion
    : null;
}

/**
 * Row-binding bucket policy (shared persistence spec §3.4). Unlike the Managed
 * Delivery probe, versioning, soft delete and retention are allowed as
 * backstops. Refused: buckets without uniform bucket-level access or enforced
 * public access prevention, and any lifecycle `Delete` rule that can match a
 * live object under the binding prefix (no prefix filter, or a prefix that
 * overlaps it). Rules limited to noncurrent versions are allowed.
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
        assertKey(input.key);
        const file = bucket.file(input.key);
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
          const [existing] = await bucket.file(input.key).getMetadata();
          return { created: false, nativeVersion: generationOf(existing) };
        }
        if (file.metadata?.generation !== undefined) {
          return { created: true, nativeVersion: generationOf(file.metadata) };
        }
        const [created] = await file.getMetadata();
        return { created: true, nativeVersion: generationOf(created) };
      });
    },
    get(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.key);
        assertReportingRowReadBounds(input);
        const generation = pinnedGeneration(input.nativeVersion);
        if (generation === null) return null;
        const file: File = bucket.file(input.key, { generation });
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
    delete(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const bucket = bucketFor(input);
        assertKey(input.key);
        const generation = pinnedGeneration(input.nativeVersion);
        if (generation === null) return 'absent' as const;
        try {
          // The generation parameter is the exact-version precondition: it deletes only the
          // recorded object (live or noncurrent) and returns 404 for any other generation. An
          // extra `ifGenerationMatch` would strand a recorded noncurrent generation on versioned
          // buckets, so it is deliberately not added.
          await bucket.file(input.key, { generation }).delete();
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
