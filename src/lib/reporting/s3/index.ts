import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type LifecycleRule,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
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

export interface CreateS3ReportingRowObjectProviderOptionsV1 {
  /** Official client used by bindings without a `credentialRef`. */
  client?: S3Client;
  /**
   * Official clients keyed by `credentialRef`. This map is the closed set of
   * references a binding may name; an unknown reference fails `UNSAFE_BINDING`.
   * Endpoint, region, credentials and path style all come from these clients,
   * never from binding locations.
   */
  clients?: Readonly<Record<string, S3Client>>;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
// Version IDs are opaque printable tokens (never the literal `null` of an unversioned object).
const VERSION_ID = /^[\x21\x23-\x7e]{1,1024}$/;

type S3Error = { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };

function statusOf(error: unknown): number | undefined {
  const status = Number((error as S3Error | undefined)?.$metadata?.httpStatusCode);
  return Number.isInteger(status) ? status : undefined;
}

function nameOf(error: unknown): string {
  const value = (error as S3Error | undefined)?.name ?? (error as S3Error | undefined)?.Code;
  return typeof value === 'string' ? value : '';
}

const isPreconditionFailed = (error: unknown) => statusOf(error) === 412 || nameOf(error) === 'PreconditionFailed';
const isConditionalConflict = (error: unknown) =>
  statusOf(error) === 409 || nameOf(error) === 'ConditionalRequestConflict';
const isNotFound = (error: unknown) =>
  statusOf(error) === 404 || ['NoSuchKey', 'NotFound', 'NoSuchVersion', 'NoSuchBucket'].includes(nameOf(error));
const isNotImplemented = (error: unknown) => statusOf(error) === 501 || nameOf(error) === 'NotImplemented';
const isForbidden = (error: unknown) => statusOf(error) === 401 || statusOf(error) === 403;
const isRangeError = (error: unknown) => statusOf(error) === 416 || nameOf(error) === 'InvalidRange';

/**
 * The native version is the S3 `VersionId`, which is unique per write. ETags are
 * content-derived (identical bytes give identical ETags), so they can never identify
 * one write and are not accepted as a version.
 */
function versionOf(output: { VersionId?: string }): string {
  const id = output.VersionId;
  if (typeof id !== 'string' || id === 'null' || !VERSION_ID.test(id)) {
    throw new ReportingRowStoreError(
      'UNSAFE_BINDING',
      'store returned no object VersionId; S3 bucket versioning must be enabled so deletes are fenced to one write'
    );
  }
  return id;
}

/** `VersionId` selector, or `null` when the recorded version is unusable. */
function selectorOf(nativeVersion: string): { VersionId: string } | null {
  if (typeof nativeVersion !== 'string' || nativeVersion === 'null') return null;
  return VERSION_ID.test(nativeVersion) ? { VersionId: nativeVersion } : null;
}

/** Whether a response came from the pinned version (echoed `VersionId`). */
function servedVersion(output: { VersionId?: string }, selector: { VersionId: string }): boolean {
  return output.VersionId === selector.VersionId;
}

function liveExpirationCovers(rule: LifecycleRule, prefix: string): boolean {
  if (rule.Status !== 'Enabled') return false;
  if (rule.Expiration?.Days === undefined && rule.Expiration?.Date === undefined) return false;
  // Row objects are never tagged, so a rule that requires tags cannot match them.
  if (rule.Filter?.Tag !== undefined || (rule.Filter?.And?.Tags?.length ?? 0) > 0) return false;
  const filter = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix;
  return reportingRowPrefixFilterOverlaps(filter, prefix);
}

/**
 * Amazon S3 (and S3-compatible) row-object provider (`@adcp/sdk/reporting/s3`).
 *
 * Inject official `S3Client`s configured by the host (region, endpoint,
 * credentials). Bindings use `location: { bucket, region? }`; when `region` is
 * set the probe requires the selected client to be configured for it.
 *
 * Writes use `PutObject` with `If-None-Match: *`. Bucket versioning must be
 * enabled: the recorded native version is the write-unique `VersionId`, and every
 * read and delete is pinned to it, so a delayed delete can never remove a later
 * write that re-created identical bytes at the same key (ETags are content-derived
 * and cannot fence that). The probe refuses unversioned or suspended buckets.
 * Because S3-compatible stores may silently ignore `If-None-Match`, the probe
 * also proves create-only behaviour empirically before any binding is used.
 */
export function createS3ReportingRowObjectProviderV1(
  options: CreateS3ReportingRowObjectProviderOptionsV1
): ReportingRowObjectProviderV1 {
  if (!options || typeof options !== 'object') {
    throw new ReportingRowStoreError('INVALID_INPUT', 'S3 row provider options are required');
  }
  const clients = reportingRowClientMap(options.clients);
  const isClient = (value: unknown) =>
    !!value && typeof value === 'object' && typeof (value as S3Client).send === 'function';
  if (
    (options.client !== undefined && !isClient(options.client)) ||
    [...clients.values()].some(client => !isClient(client)) ||
    (options.client === undefined && clients.size === 0)
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'inject an official S3Client as client or clients');
  }

  const validateLocation = (location: Readonly<Record<string, string>>) => {
    assertReportingRowLocationKeys(location, ['bucket'], ['region']);
    const bucket = location.bucket!;
    if (!BUCKET.test(bucket) || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'S3 bucket name is invalid');
    }
    if (location.region !== undefined && !REGION.test(location.region)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'S3 region is invalid');
    }
  };
  const target = (input: { location: Readonly<Record<string, string>>; credentialRef?: string }) => {
    validateLocation(input.location);
    return {
      client: selectReportingRowClient(options.client, clients, input.credentialRef),
      Bucket: input.location.bucket!,
    };
  };
  const assertKey = (key: string) => {
    if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key) > 1024) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'object key is invalid');
    }
  };

  /** Create-only put; a 409 ConditionalRequestConflict is retried once. Raw errors propagate. */
  async function putCreateOnly(client: S3Client, params: PutObjectCommandInput, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.send(new PutObjectCommand({ ...params, IfNoneMatch: '*' }), { abortSignal: signal });
      } catch (error) {
        if (attempt === 0 && isConditionalConflict(error) && !signal.aborted) continue;
        throw error;
      }
    }
  }

  /** Fail closed unless versioning is `Enabled`; `Suspended` or absent versioning yields no unique VersionId. */
  async function assertVersioningEnabled(client: S3Client, Bucket: string, signal: AbortSignal) {
    let status: string | undefined;
    try {
      status = (await client.send(new GetBucketVersioningCommand({ Bucket }), { abortSignal: signal })).Status;
    } catch (error) {
      if (isForbidden(error) || isNotImplemented(error)) {
        throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket versioning status cannot be verified');
      }
      throw error;
    }
    if (status !== 'Enabled') {
      throw new ReportingRowStoreError(
        'UNSAFE_BINDING',
        'S3 bucket versioning must be enabled so row object deletes are fenced to one write'
      );
    }
  }

  async function assertCreateOnlyEnforced(client: S3Client, Bucket: string, prefix: string, signal: AbortSignal) {
    const Key = `${prefix}/.adcp-probe/${randomUUID()}`;
    const written: PutObjectCommandOutput[] = [];
    const put = async (body: string) => {
      const output = await putCreateOnly(
        client,
        { Bucket, Key, Body: Buffer.from(body), ContentType: 'application/x-ndjson', CacheControl: 'no-store' },
        signal
      );
      written.push(output);
      versionOf(output);
    };
    try {
      try {
        await put('{"probe":1}\n');
      } catch (error) {
        if (isNotImplemented(error) || isPreconditionFailed(error)) {
          throw new ReportingRowStoreError('UNSAFE_BINDING', 'store does not support create-only writes');
        }
        throw error;
      }
      try {
        await put('{"probe":2}\n');
      } catch (error) {
        if (isPreconditionFailed(error)) return;
        if (isNotImplemented(error)) {
          throw new ReportingRowStoreError('UNSAFE_BINDING', 'store does not support create-only writes');
        }
        throw error;
      }
      throw new ReportingRowStoreError('UNSAFE_BINDING', 'store ignores If-None-Match and replaces objects');
    } finally {
      // Best-effort cleanup of the probe key; it is a fresh random key under the owned prefix.
      const versionIds = written.map(output => output.VersionId).filter((id): id is string => !!id);
      const deletes = versionIds.length > 0 ? versionIds.map(VersionId => ({ VersionId })) : written.length ? [{}] : [];
      for (const selector of deletes) {
        if (signal.aborted) break;
        await client
          .send(new DeleteObjectCommand({ Bucket, Key, ...selector }), { abortSignal: signal })
          .catch(() => undefined);
      }
    }
  }

  return {
    name: 's3',
    rangedReads: true,
    validateLocation,
    probe(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const { client, Bucket } = target(input);
        const signal = context.signal;
        try {
          await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: signal });
        } catch (error) {
          if (isNotFound(error)) throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket does not exist');
          if (isForbidden(error)) throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket is not accessible');
          if (statusOf(error) === 301) {
            throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket is in a different region');
          }
          throw error;
        }
        if (input.location.region !== undefined) {
          const configured = client.config?.region;
          const region = typeof configured === 'function' ? await configured() : configured;
          if (region !== input.location.region) {
            throw new ReportingRowStoreError('UNSAFE_BINDING', 'client region does not match the binding');
          }
        }
        // Best effort: S3-compatible stores often lack this API; a positive "public" answer is refused.
        const policy = await client
          .send(new GetBucketPolicyStatusCommand({ Bucket }), { abortSignal: signal })
          .catch(() => undefined);
        if (policy?.PolicyStatus?.IsPublic === true) {
          throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket policy makes objects public');
        }
        let rules: LifecycleRule[] = [];
        try {
          const lifecycle = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket }), {
            abortSignal: signal,
          });
          rules = lifecycle.Rules ?? [];
        } catch (error) {
          if (isForbidden(error)) {
            throw new ReportingRowStoreError('UNSAFE_BINDING', 'bucket lifecycle cannot be read with this client');
          }
          // No configuration, or a store without lifecycle support.
          if (!isNotFound(error) && !isNotImplemented(error) && nameOf(error) !== 'NoSuchLifecycleConfiguration') {
            throw error;
          }
        }
        if (rules.some(rule => liveExpirationCovers(rule, input.prefix))) {
          throw new ReportingRowStoreError('UNSAFE_BINDING', 'a bucket lifecycle rule can expire live row objects');
        }
        await assertVersioningEnabled(client, Bucket, signal);
        await assertCreateOnlyEnforced(client, Bucket, input.prefix, signal);
      });
    },
    putIfAbsent(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const { client, Bucket } = target(input);
        assertKey(input.key);
        const bytes = Buffer.from(input.bytes);
        try {
          const output = await putCreateOnly(
            client,
            {
              Bucket,
              Key: input.key,
              Body: bytes,
              ContentLength: bytes.byteLength,
              ContentType: input.contentType,
              CacheControl: 'no-store',
              Metadata: { ...input.metadata },
            },
            context.signal
          );
          return { created: true, nativeVersion: versionOf(output) };
        } catch (error) {
          if (!isPreconditionFailed(error)) throw error;
        }
        // The key is taken. Report the existing version; the caller adopts it only on identical bytes.
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: input.key }), {
          abortSignal: context.signal,
        });
        return { created: false, nativeVersion: versionOf(head) };
      });
    },
    get(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const { client, Bucket } = target(input);
        assertKey(input.key);
        assertReportingRowReadBounds(input);
        const selector = selectorOf(input.nativeVersion);
        if (selector === null) return null;
        const Key = input.key;
        try {
          if (input.range?.length === 0) {
            const head = await client.send(new HeadObjectCommand({ Bucket, Key, ...selector }), {
              abortSignal: context.signal,
            });
            if (!servedVersion(head, selector)) return null;
            if (input.range.offset > Number(head.ContentLength ?? 0)) {
              throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
            }
            return Buffer.alloc(0);
          }
          const output = await client.send(
            new GetObjectCommand({
              Bucket,
              Key,
              ...selector,
              ...(input.range
                ? { Range: `bytes=${input.range.offset}-${input.range.offset + input.range.length - 1}` }
                : {}),
            }),
            { abortSignal: context.signal }
          );
          const body = output.Body as unknown as AsyncIterable<unknown> & { destroy?: (error?: Error) => unknown };
          if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
            throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'object body is not a stream');
          }
          // Some S3-compatible stores ignore `versionId`; only an echoed exact version counts.
          if (!servedVersion(output, selector)) {
            body.destroy?.();
            return null;
          }
          if (typeof output.ContentLength === 'number' && output.ContentLength > input.maxBytes) {
            body.destroy?.();
            throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'stored object exceeds its recorded size');
          }
          return await readReportingRowStream(body, input.maxBytes, context.signal);
        } catch (error) {
          if (isNotFound(error) || isPreconditionFailed(error)) return null;
          // A malformed or foreign version ID is not this object.
          if (statusOf(error) === 400 && nameOf(error) !== 'InvalidRange') return null;
          if (isRangeError(error)) {
            throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
          }
          throw error;
        }
      });
    },
    delete(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const { client, Bucket } = target(input);
        assertKey(input.key);
        const selector = selectorOf(input.nativeVersion);
        if (selector === null) return 'absent' as const;
        const Key = input.key;
        const signal = context.signal;
        // S3 deletes succeed for missing keys and versions, so confirm the exact version first.
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket, Key, ...selector }), { abortSignal: signal });
          if (!servedVersion(head, selector)) return 'absent' as const;
        } catch (error) {
          if (isNotFound(error) || isPreconditionFailed(error)) return 'absent' as const;
          // 400: malformed or foreign version ID; 405: the version is a delete marker.
          if (statusOf(error) === 400 || statusOf(error) === 405) return 'absent' as const;
          throw error;
        }
        // Deleting a specific VersionId permanently removes that version (no delete marker).
        await client.send(new DeleteObjectCommand({ Bucket, Key, VersionId: selector.VersionId }), {
          abortSignal: signal,
        });
        return 'deleted' as const;
      });
    },
  };
}
