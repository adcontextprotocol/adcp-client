import type { Storage } from '@google-cloud/storage';
import {
  CanonicalDocumentReadError,
  createCanonicalReferenceResolver,
  type CanonicalDocumentReader,
  type CanonicalReference,
  type CanonicalReferenceKind,
  type CanonicalReferenceFailureResult,
  type CanonicalReferenceResolver,
  type CanonicalReferenceResolverOptions,
} from '../../canonical-references';
import type { ReportingResourceReader } from '../inspection';
import { assertReportingObjectWriteScope, type ReportingObjectWriteScopeV1 } from '../ledger/object-writes';
import { ReportingGcsFenceError, isReportingGcsFenceError } from './errors';
import { activeGcsSignal, readGcsBytes, withGcsDeadline } from './io';

export interface GcsReportingReadScopeV1 extends ReportingObjectWriteScopeV1 {
  /** Non-secret identity from the host's authenticated principal registry. Never a bearer. */
  principal_id: string;
}

export interface GcsReportingReadAuthorizationV1 {
  scope: Readonly<GcsReportingReadScopeV1>;
  bucket: string;
  objectPrefix: string;
  objectName: string;
}

export interface GcsReportingReaderOptionsV1 {
  scope: GcsReportingReadScopeV1;
  bucket: string;
  /** Exact saved destination prefix, including the trailing slash. */
  objectPrefix: string;
  /** Resolve an official client with keyless credentials for this operation. */
  getStorage(scope: Readonly<GcsReportingReadScopeV1>, context: { signal: AbortSignal }): Promise<Storage>;
  /** Host verifies principal/account/destination ownership and the current grant generation. */
  authorize(request: Readonly<GcsReportingReadAuthorizationV1>, context: { signal: AbortSignal }): Promise<boolean>;
  /** Optional operation lifetime, composed with each read deadline/caller signal. */
  signal?: AbortSignal;
  operationDeadlineMilliseconds?: number;
  maxBytes?: number;
}

/** Restrictive provider-native URL grammar: no credentials, queries, encoding or traversal. */
export function gcsReportingObjectFromUriV1(uri: string, bucket: string, prefix: string): string {
  if (typeof uri !== 'string' || uri.length > 2048) throw new ReportingGcsFenceError('INVALID_INPUT');
  const expectedBase = `https://storage.googleapis.com/${bucket}/`;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ReportingGcsFenceError('INVALID_INPUT');
  }
  const name = uri.startsWith(expectedBase) ? uri.slice(expectedBase.length) : '';
  if (
    parsed.href !== uri ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !name.startsWith(prefix) ||
    name.length <= prefix.length ||
    name.length > 1024 ||
    !/^[A-Za-z0-9/_.-]+$/.test(name) ||
    name.split('/').some(part => !part || part === '.' || part === '..')
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
  return name;
}

export function createGcsScopedObjectReadV1(options: GcsReportingReaderOptionsV1) {
  let scope: GcsReportingReadScopeV1;
  try {
    scope = structuredClone(options.scope);
    assertReportingObjectWriteScope(scope);
  } catch {
    throw new ReportingGcsFenceError('INVALID_INPUT');
  }
  if (
    typeof scope.principal_id !== 'string' ||
    scope.principal_id.length < 1 ||
    scope.principal_id.length > 255 ||
    typeof options.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(options.bucket) ||
    typeof options.objectPrefix !== 'string' ||
    !/^[A-Za-z0-9/_.-]+\/$/.test(options.objectPrefix) ||
    options.objectPrefix.length > 1000 ||
    options.objectPrefix
      .split('/')
      .slice(0, -1)
      .some(p => !p || p === '.' || p === '..') ||
    typeof options.authorize !== 'function' ||
    typeof options.getStorage !== 'function'
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
  Object.freeze(scope);
  const { bucket, objectPrefix, authorize, getStorage, signal: parentSignal } = options;
  if (parentSignal !== undefined && !(parentSignal instanceof AbortSignal))
    throw new ReportingGcsFenceError('INVALID_INPUT');
  const maximum = options.maxBytes ?? 64 * 1024 * 1024;
  const milliseconds = options.operationDeadlineMilliseconds ?? 60_000;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 60_000
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
  async function authorized(signal: AbortSignal, objectName: string) {
    activeGcsSignal(signal);
    const allowed = await authorize({ scope, bucket, objectPrefix, objectName }, { signal });
    activeGcsSignal(signal);
    if (allowed !== true) throw new ReportingGcsFenceError('REVOKED');
  }
  return async (uri: string, maxBytes: number, signal?: AbortSignal, nativeVersion?: string) =>
    withGcsDeadline(
      async active => {
        const name = gcsReportingObjectFromUriV1(uri, bucket, objectPrefix);
        if (
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          (nativeVersion !== undefined && !/^[1-9][0-9]{0,39}$/.test(nativeVersion))
        )
          throw new ReportingGcsFenceError('INVALID_INPUT');
        await authorized(active, name);
        const storage = await getStorage(scope, { signal: active });
        activeGcsSignal(active);
        try {
          const file = storage.bucket(bucket).file(name, nativeVersion ? { generation: nativeVersion } : undefined);
          const [metadata] = await file.getMetadata();
          activeGcsSignal(active);
          if (metadata.metadata?.adcp_reporting_tombstone !== undefined) throw new ReportingGcsFenceError('REVOKED');
          const generation = String(metadata.generation);
          if (nativeVersion !== undefined && generation !== nativeVersion)
            throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          if (
            !/^[1-9][0-9]{0,39}$/.test(generation) ||
            !/^(?:0|[1-9][0-9]{0,19})$/.test(String(metadata.size)) ||
            BigInt(String(metadata.size)) > BigInt(Math.min(maxBytes, maximum))
          )
            throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          const body = await readGcsBytes(
            storage.bucket(bucket).file(name, { generation }),
            Math.min(maxBytes, maximum),
            active
          );
          activeGcsSignal(active);
          await authorized(active, name);
          return { body, contentType: metadata.contentType, generation };
        } catch (error) {
          activeGcsSignal(active);
          if (isReportingGcsFenceError(error)) throw error;
          await authorized(active, name);
          throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
        }
      },
      {
        signal: parentSignal && signal ? AbortSignal.any([parentSignal, signal]) : (parentSignal ?? signal),
        milliseconds,
      }
    );
}

/** Destination-bound manifest/object reader. The caller never supplies bucket or credential scope. */
export function createGcsReportingResourceReaderV1(options: GcsReportingReaderOptionsV1): ReportingResourceReader {
  const read = createGcsScopedObjectReadV1(options);
  const scope = structuredClone(options.scope);
  const { bucket, objectPrefix } = options;
  return {
    async read(request) {
      if (
        !request?.context?.materialization?.resource ||
        !['manifest', 'object'].includes(request.role) ||
        request.context.obligation?.account_id !== scope.account_id ||
        request.location !== request.context.materialization.resource.location ||
        request.context.materialization.destination_ref !== scope.destination_ref
      )
        throw new ReportingGcsFenceError('INVALID_INPUT');
      let uri = request.location;
      if (request.role === 'object') {
        if (
          typeof request.objectRef !== 'string' ||
          !/^[A-Za-z0-9_.-]+$/.test(request.objectRef) ||
          request.objectRef === '.' ||
          request.objectRef === '..'
        )
          throw new ReportingGcsFenceError('INVALID_INPUT');
        const name = gcsReportingObjectFromUriV1(request.location, bucket, objectPrefix);
        uri = `https://storage.googleapis.com/${bucket}/${name.slice(0, name.lastIndexOf('/') + 1)}${request.objectRef}`;
      }
      return read(
        uri,
        request.maxBytes,
        request.signal,
        request.role === 'manifest' ? request.context.materialization.resource?.native_version_ref : undefined
      );
    },
  };
}

/** Digest-pinned private contract resolver; all resolutions re-authorize and bypass caches. */
export function createGcsReportingReferenceResolverV1(
  options: GcsReportingReaderOptionsV1
): CanonicalReferenceResolver {
  const read = createGcsScopedObjectReadV1(options);
  const documentReader: CanonicalDocumentReader = {
    async read(request) {
      try {
        return await read(request.uri, request.maxBytes, request.signal);
      } catch (error) {
        if (isReportingGcsFenceError(error)) {
          if (error.code === 'ABORTED') throw new CanonicalDocumentReadError('aborted');
          if (error.code === 'INVALID_INPUT') throw new CanonicalDocumentReadError('unsafe_url');
          if (error.code === 'REVOKED') throw new CanonicalDocumentReadError('access_denied');
          if (error.code === 'CONTENT_CONFLICT') throw new CanonicalDocumentReadError('body_too_large');
        }
        throw new CanonicalDocumentReadError('network_error');
      }
    },
  };
  const parentSignal = options.signal;
  const resolver = createCanonicalReferenceResolver({ documentReader, signal: parentSignal });
  const routing = { bucket: options.bucket, objectPrefix: options.objectPrefix };
  const forced = (input?: CanonicalReferenceResolverOptions) => ({
    ...input,
    documentReader,
    signal:
      parentSignal && input?.signal ? AbortSignal.any([parentSignal, input.signal]) : (parentSignal ?? input?.signal),
  });
  function blocked(ref: CanonicalReference, kind: CanonicalReferenceKind): CanonicalReferenceFailureResult | undefined {
    try {
      gcsReportingObjectFromUriV1(ref.uri, routing.bucket, routing.objectPrefix);
      return undefined;
    } catch {
      return {
        ok: false,
        status: 'blocked_unsafe_url',
        kind,
        ref: {
          uri: 'https://storage.googleapis.com/redacted-invalid-reference',
          digest: /^sha256:[a-f0-9]{64}$/.test(ref?.digest) ? ref.digest : 'invalid',
        },
        cacheKey: 'private-reference-refused',
        fromCache: false,
        error: {
          code: 'unsafe_url',
          message: 'Private reference is outside the saved destination scope',
          retryable: false,
        },
      };
    }
  }
  return {
    cache: resolver.cache,
    resolve: async (ref, context) => blocked(ref, 'generic') ?? resolver.resolve(ref, forced(context)),
    resolveFormatSchema: async (ref, context) =>
      blocked(ref, 'format_schema') ?? resolver.resolveFormatSchema(ref, forced(context)),
    resolvePlatformExtensions: async (ref, context) =>
      blocked(ref, 'platform_extensions') ?? resolver.resolvePlatformExtensions(ref, forced(context)),
  };
}
