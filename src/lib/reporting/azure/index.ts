import { randomUUID } from 'node:crypto';
import type { BlobClient, BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { ReportingRowStoreError } from '../ledger/row-storage-errors';
import type { ReportingRowObjectProviderV1 } from '../ledger/row-storage-object';
import {
  assertReportingRowLocationKeys,
  assertReportingRowReadBounds,
  isReportingRowEtagVersion,
  readReportingRowStream,
  reportingRowClientMap,
  reportingRowEtagVersion,
  runReportingRowProviderOperation,
  selectReportingRowClient,
} from '../ledger/row-storage-provider-io';

export interface CreateAzureBlobReportingRowObjectProviderOptionsV1 {
  /** Official client used by bindings without a `credentialRef`. */
  client?: BlobServiceClient;
  /**
   * Official clients keyed by `credentialRef`. This map is the closed set of
   * references a binding may name; an unknown reference fails `UNSAFE_BINDING`.
   * Endpoint and credentials come only from these clients.
   */
  clients?: Readonly<Record<string, BlobServiceClient>>;
}

const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/;
// Version IDs are RFC 3339 timestamps; ETags are kept quoted, which version IDs never are.
const VERSION_ID = /^[0-9A-Za-z:.+-]{1,64}$/;

type AzureError = { statusCode?: unknown; code?: unknown; details?: { errorCode?: unknown } };

function statusOf(error: unknown): number | undefined {
  const status = Number((error as AzureError | undefined)?.statusCode);
  return Number.isInteger(status) ? status : undefined;
}

function codeOf(error: unknown): string {
  const value = (error as AzureError | undefined)?.code ?? (error as AzureError | undefined)?.details?.errorCode;
  return typeof value === 'string' ? value : '';
}

const isConflict = (error: unknown) =>
  statusOf(error) === 409 || statusOf(error) === 412 || codeOf(error) === 'BlobAlreadyExists';
const isMissing = (error: unknown) => statusOf(error) === 404 || statusOf(error) === 412;
const isForbidden = (error: unknown) => statusOf(error) === 401 || statusOf(error) === 403;

function versionOf(response: { versionId?: string; etag?: string }): string {
  if (typeof response.versionId === 'string' && VERSION_ID.test(response.versionId)) return response.versionId;
  if (typeof response.etag === 'string' && response.etag.length > 0 && response.etag.length <= 1024) {
    return reportingRowEtagVersion(response.etag);
  }
  throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'blob version is missing');
}

/** Whether a response came from the pinned version (echoed `versionId`, or the matching ETag). */
function servedVersion(
  response: { versionId?: string; etag?: string },
  versionId: string | undefined,
  nativeVersion: string
): boolean {
  if (versionId !== undefined) return response.versionId === versionId;
  return typeof response.etag === 'string' && reportingRowEtagVersion(response.etag) === nativeVersion;
}

/** Blob metadata names must be C# identifiers; `adcp-intent` is stored as `adcp_intent`. */
function metadataOf(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata)) {
    const identifier = name.replace(/[^A-Za-z0-9_]/g, '_');
    result[/^[A-Za-z_]/.test(identifier) ? identifier : `_${identifier}`] = value;
  }
  return result;
}

/**
 * Azure Blob Storage row-object provider (`@adcp/sdk/reporting/azure`).
 *
 * Inject official `BlobServiceClient`s with host-owned credentials (managed
 * identity, workload identity). Bindings use `location: { account, container }`;
 * the selected client must belong to `account`. Writes are block-blob uploads
 * with `If-None-Match: *`; the recorded native version is the `versionId` when
 * blob versioning is enabled, else the quoted ETag, and pins every read and
 * delete. The probe proves create-only behaviour empirically.
 */
export function createAzureBlobReportingRowObjectProviderV1(
  options: CreateAzureBlobReportingRowObjectProviderOptionsV1
): ReportingRowObjectProviderV1 {
  if (!options || typeof options !== 'object') {
    throw new ReportingRowStoreError('INVALID_INPUT', 'Azure Blob row provider options are required');
  }
  const clients = reportingRowClientMap(options.clients);
  const isClient = (value: unknown) =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as BlobServiceClient).getContainerClient === 'function' &&
    typeof (value as BlobServiceClient).accountName === 'string';
  if (
    (options.client !== undefined && !isClient(options.client)) ||
    [...clients.values()].some(client => !isClient(client)) ||
    (options.client === undefined && clients.size === 0)
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'inject an official BlobServiceClient as client or clients');
  }

  const validateLocation = (location: Readonly<Record<string, string>>) => {
    assertReportingRowLocationKeys(location, ['account', 'container']);
    if (!ACCOUNT.test(location.account!)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'Azure storage account name is invalid');
    }
    if (!CONTAINER.test(location.container!)) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'Azure container name is invalid');
    }
  };
  const containerFor = (input: {
    location: Readonly<Record<string, string>>;
    credentialRef?: string;
  }): ContainerClient => {
    validateLocation(input.location);
    const client = selectReportingRowClient(options.client, clients, input.credentialRef);
    if (client.accountName !== input.location.account) {
      throw new ReportingRowStoreError('UNSAFE_BINDING', 'client does not belong to the binding account');
    }
    return client.getContainerClient(input.location.container!);
  };
  const blobFor = (input: { location: Readonly<Record<string, string>>; credentialRef?: string; key: string }) => {
    if (typeof input.key !== 'string' || input.key.length === 0 || input.key.length > 1024) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'object key is invalid');
    }
    return containerFor(input).getBlockBlobClient(input.key);
  };
  /** Pinned blob client plus download/delete conditions, or `null` when the version is unusable. */
  const pinned = (blob: BlobClient, nativeVersion: string) => {
    if (typeof nativeVersion !== 'string') return null;
    if (isReportingRowEtagVersion(nativeVersion)) {
      return nativeVersion.length <= 1026
        ? { blob, conditions: { ifMatch: nativeVersion }, versionId: undefined }
        : null;
    }
    return VERSION_ID.test(nativeVersion)
      ? { blob: blob.withVersion(nativeVersion), conditions: {}, versionId: nativeVersion }
      : null;
  };

  async function assertCreateOnlyEnforced(container: ContainerClient, prefix: string, signal: AbortSignal) {
    const blob = container.getBlockBlobClient(`${prefix}/.adcp-probe/${randomUUID()}`);
    const versionIds: string[] = [];
    let written = false;
    const upload = async (body: string) => {
      const bytes = Buffer.from(body);
      const response = await blob.upload(bytes, bytes.byteLength, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/x-ndjson', blobCacheControl: 'no-store' },
        abortSignal: signal,
      });
      written = true;
      if (response.versionId) versionIds.push(response.versionId);
    };
    try {
      await upload('{"probe":1}\n');
      try {
        await upload('{"probe":2}\n');
      } catch (error) {
        if (isConflict(error)) return;
        throw error;
      }
      throw new ReportingRowStoreError('UNSAFE_BINDING', 'store ignores If-None-Match and replaces blobs');
    } finally {
      // Best-effort cleanup of the fresh probe blob and any versions it produced.
      if (written && !signal.aborted) {
        await blob.delete({ abortSignal: signal }).catch(() => undefined);
        for (const versionId of versionIds) {
          if (signal.aborted) break;
          await blob
            .withVersion(versionId)
            .delete({ abortSignal: signal })
            .catch(() => undefined);
        }
      }
    }
  }

  return {
    name: 'azure_blob',
    rangedReads: true,
    validateLocation,
    probe(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const container = containerFor(input);
        let properties;
        try {
          properties = await container.getProperties({ abortSignal: context.signal });
        } catch (error) {
          if (statusOf(error) === 404) throw new ReportingRowStoreError('UNSAFE_BINDING', 'container does not exist');
          if (isForbidden(error)) throw new ReportingRowStoreError('UNSAFE_BINDING', 'container is not accessible');
          throw error;
        }
        if (properties.blobPublicAccess) {
          throw new ReportingRowStoreError('UNSAFE_BINDING', 'container allows anonymous read access');
        }
        await assertCreateOnlyEnforced(container, input.prefix, context.signal);
      });
    },
    putIfAbsent(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const blob = blobFor(input);
        const bytes = Buffer.from(input.bytes);
        try {
          const response = await blob.upload(bytes, bytes.byteLength, {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: input.contentType, blobCacheControl: 'no-store' },
            metadata: metadataOf(input.metadata),
            abortSignal: context.signal,
          });
          return { created: true, nativeVersion: versionOf(response) };
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
        // The key is taken. Report the existing version; the caller adopts it only on identical bytes.
        const existing = await blob.getProperties({ abortSignal: context.signal });
        return { created: false, nativeVersion: versionOf(existing) };
      });
    },
    get(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const blob = blobFor(input);
        assertReportingRowReadBounds(input);
        const target = pinned(blob, input.nativeVersion);
        if (target === null) return null;
        try {
          if (input.range?.length === 0) {
            const properties = await target.blob.getProperties({
              conditions: target.conditions,
              abortSignal: context.signal,
            });
            if (!servedVersion(properties, target.versionId, input.nativeVersion)) return null;
            if (input.range.offset > Number(properties.contentLength ?? 0)) {
              throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
            }
            return Buffer.alloc(0);
          }
          const response = await target.blob.download(input.range?.offset ?? 0, input.range?.length, {
            conditions: target.conditions,
            abortSignal: context.signal,
          });
          const body = response.readableStreamBody as
            | (AsyncIterable<unknown> & { destroy?: (error?: Error) => unknown })
            | undefined;
          if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
            throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE', 'blob body is not a stream');
          }
          // Stores without blob versioning ignore `versionid`; only an echoed exact version counts.
          if (!servedVersion(response, target.versionId, input.nativeVersion)) {
            body.destroy?.();
            return null;
          }
          if (typeof response.contentLength === 'number' && response.contentLength > input.maxBytes) {
            body.destroy?.();
            throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'stored object exceeds its recorded size');
          }
          return await readReportingRowStream(body, input.maxBytes, context.signal);
        } catch (error) {
          if (isMissing(error)) return null;
          // A malformed or foreign version ID is not this blob.
          if (target.versionId !== undefined && statusOf(error) === 400) return null;
          if (statusOf(error) === 416 || codeOf(error) === 'InvalidRange') {
            throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the stored object');
          }
          throw error;
        }
      });
    },
    delete(input, context) {
      return runReportingRowProviderOperation(context.signal, async () => {
        const blob = blobFor(input);
        const target = pinned(blob, input.nativeVersion);
        if (target === null) return 'absent' as const;
        const signal = context.signal;
        if (target.versionId === undefined) {
          try {
            await blob.delete({ conditions: target.conditions, abortSignal: signal });
            return 'deleted' as const;
          } catch (error) {
            if (isMissing(error)) return 'absent' as const;
            throw error;
          }
        }
        // Confirm the store resolved the exact version; stores without versioning ignore `versionid`.
        try {
          const recorded = await target.blob.getProperties({ abortSignal: signal });
          if (recorded.versionId !== target.versionId) return 'absent' as const;
        } catch (error) {
          if (isMissing(error) || statusOf(error) === 400) return 'absent' as const;
          throw error;
        }
        // When the recorded version is still current, delete the base blob first (if it is
        // still that version), then remove the version itself.
        let deletedCurrent = false;
        try {
          const current = await blob.getProperties({ abortSignal: signal });
          if (current.versionId === target.versionId && current.etag) {
            await blob.delete({ conditions: { ifMatch: current.etag }, abortSignal: signal });
            deletedCurrent = true;
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        try {
          await target.blob.delete({ abortSignal: signal });
          return 'deleted' as const;
        } catch (error) {
          if (isMissing(error) || statusOf(error) === 400) return deletedCurrent ? 'deleted' : 'absent';
          throw error;
        }
      });
    },
  };
}
