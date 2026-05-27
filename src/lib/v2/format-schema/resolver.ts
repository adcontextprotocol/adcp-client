import Ajv2019 from 'ajv/dist/2019';
import addFormats from 'ajv-formats';
import draft7MetaSchema from 'ajv/dist/refs/json-schema-draft-07.json';
import {
  fetchFormatSchema,
  FormatSchemaFetchError,
  type FetchFormatSchemaOptions,
  type FormatSchemaCache,
  type FormatSchemaFetchErrorCode,
  type FormatSchemaFetchResult,
  type FormatSchemaRef,
} from './fetch';
import {
  DEFAULT_MAX_KEYWORDS,
  DEFAULT_MAX_REF_COUNT,
  DEFAULT_MAX_REF_DEPTH,
  resolveSchemaRefs,
  SchemaRefSandboxError,
  type ResolveSchemaRefsOptions,
  type SchemaRefSandboxErrorCode,
} from './sandbox-refs';

export type CanonicalReferenceKind = 'format_schema' | 'platform_extensions';
export type CanonicalRef = FormatSchemaRef;

export type CanonicalReferenceResolutionStatus =
  | 'resolved'
  | 'invalid_ref'
  | 'blocked_unsafe_url'
  | 'digest_mismatch'
  | 'invalid_schema'
  | 'unresolvable';

export type CanonicalReferenceResolutionCode =
  | FormatSchemaFetchErrorCode
  | SchemaRefSandboxErrorCode
  | 'schema_dialect_unsupported'
  | 'schema_compile_failed'
  | 'schema_keyword_limit_exceeded';

export interface CanonicalReferenceResolvedResult {
  ok: true;
  status: 'resolved';
  kind: CanonicalReferenceKind;
  ref: FormatSchemaRef;
  /**
   * Resolved document. For `format_schema`, every allowed `$ref` has
   * been inlined and the result has compiled as JSON Schema. For
   * `platform_extensions`, this is the fetched JSON object.
   */
  document: Record<string, unknown>;
  /** Original digest-verified document, before `$ref` inlining. */
  rawDocument: Record<string, unknown>;
  /** True when returned from the caller-scoped immutable cache. */
  fromCache: boolean;
  /** `format_schema` only: count of `$ref` occurrences resolved. */
  refCount?: number;
  /** `format_schema` only: deepest transitive `$ref` depth observed. */
  maxDepthSeen?: number;
}

export interface CanonicalReferenceFailureResult {
  ok: false;
  status: Exclude<CanonicalReferenceResolutionStatus, 'resolved'>;
  kind: CanonicalReferenceKind;
  ref: Partial<FormatSchemaRef>;
  /** Stable transport/schema subreason. Same value as `code`. */
  reason: CanonicalReferenceResolutionCode;
  code: CanonicalReferenceResolutionCode;
  /** True for transient network/server/cap failures callers may retry. */
  retryable: boolean;
  message: string;
  httpStatus?: number;
  details?: Record<string, unknown>;
}

export type CanonicalReferenceResolutionResult = CanonicalReferenceResolvedResult | CanonicalReferenceFailureResult;

export interface CanonicalReferenceCache {
  get(key: string): CanonicalReferenceResolvedResult | undefined;
  set(key: string, value: CanonicalReferenceResolvedResult): void;
}

export interface CanonicalReferenceResolverOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  cache?: CanonicalReferenceCache;
  maxRefDepth?: number;
  maxRefCount?: number;
  maxKeywords?: number;
  allowInternalReferences?: boolean;
  mirrorHost?: ResolveSchemaRefsOptions['mirrorHost'];
  mirrorHosts?: ResolveSchemaRefsOptions['mirrorHosts'];
  fetchExternal?: ResolveSchemaRefsOptions['fetchExternal'];
}

export interface ResolveCanonicalReferenceOptions extends CanonicalReferenceResolverOptions {
  kind: CanonicalReferenceKind;
}

export interface CanonicalReferenceResolver {
  resolveReference(
    ref: FormatSchemaRef,
    options: ResolveCanonicalReferenceOptions
  ): Promise<CanonicalReferenceResolutionResult>;
  resolveFormatSchema(
    ref: FormatSchemaRef,
    options?: CanonicalReferenceResolverOptions
  ): Promise<CanonicalReferenceResolutionResult>;
  resolvePlatformExtension(
    ref: FormatSchemaRef,
    options?: CanonicalReferenceResolverOptions
  ): Promise<CanonicalReferenceResolutionResult>;
}

export function createMemoryCanonicalReferenceCache(): CanonicalReferenceCache {
  const store = new Map<string, CanonicalReferenceResolvedResult>();
  return {
    get: key => {
      const cached = store.get(key);
      return cached ? cloneResolvedResult(cached, false) : undefined;
    },
    set: (key, value) => {
      store.set(key, cloneResolvedResult(value, false));
    },
  };
}

function createMemoryFormatSchemaCache(): FormatSchemaCache {
  const store = new Map<string, FormatSchemaFetchResult>();
  return {
    get: key => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function cacheKey(kind: CanonicalReferenceKind, ref: FormatSchemaRef): string {
  return `${kind}:${ref.uri}@${ref.digest}`;
}

function cloneJsonRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneResolvedResult(
  result: CanonicalReferenceResolvedResult,
  fromCache: boolean
): CanonicalReferenceResolvedResult {
  return {
    ...result,
    ref: { ...result.ref },
    document: cloneJsonRecord(result.document),
    rawDocument: cloneJsonRecord(result.rawDocument),
    fromCache,
  };
}

function toFetchOptions(
  options: CanonicalReferenceResolverOptions,
  fetchCache: FormatSchemaCache
): FetchFormatSchemaOptions {
  return {
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
    allowInternalReferences: options.allowInternalReferences,
    cache: fetchCache,
  };
}

function fail(
  kind: CanonicalReferenceKind,
  ref: Partial<FormatSchemaRef>,
  status: CanonicalReferenceFailureResult['status'],
  code: CanonicalReferenceResolutionCode,
  message: string,
  meta: { httpStatus?: number; details?: Record<string, unknown>; retryable?: boolean } = {}
): CanonicalReferenceFailureResult {
  return {
    ok: false,
    status,
    kind,
    ref,
    reason: code,
    code,
    retryable: meta.retryable ?? status === 'unresolvable',
    message,
    httpStatus: meta.httpStatus,
    details: meta.details,
  };
}

function mapFetchError(kind: CanonicalReferenceKind, ref: Partial<FormatSchemaRef>, err: FormatSchemaFetchError) {
  if (err.code === 'digest_mismatch') {
    return fail(kind, ref, 'digest_mismatch', err.code, err.message, {
      details: err.details,
      retryable: false,
    });
  }
  if (
    err.code === 'ssrf_refused' &&
    (err.details?.code === 'dns_lookup_failed' ||
      err.details?.code === 'dns_empty' ||
      err.details?.code === 'body_exceeds_limit')
  ) {
    return fail(kind, ref, 'unresolvable', err.code, err.message, {
      details: err.details,
      retryable: true,
    });
  }
  if (
    err.code === 'ssrf_refused' ||
    err.code === 'redirect_blocked' ||
    (err.code === 'invalid_ref' && /uri must use https/i.test(err.message))
  ) {
    return fail(kind, ref, 'blocked_unsafe_url', err.code, err.message, {
      httpStatus: err.httpStatus,
      details: err.details,
      retryable: false,
    });
  }
  if (err.code === 'invalid_ref') {
    return fail(kind, ref, 'invalid_ref', err.code, err.message, { details: err.details, retryable: false });
  }
  if (err.code === 'invalid_json') {
    return fail(kind, ref, 'invalid_schema', err.code, err.message, { details: err.details, retryable: false });
  }
  return fail(kind, ref, 'unresolvable', err.code, err.message, {
    httpStatus: err.httpStatus,
    details: err.details,
    retryable: true,
  });
}

function mapSandboxError(kind: CanonicalReferenceKind, ref: FormatSchemaRef, err: SchemaRefSandboxError) {
  if (err.code === 'fetch_failed' && err.details?.transient === true) {
    return fail(kind, ref, 'unresolvable', err.code, err.message, { details: err.details, retryable: true });
  }
  if (err.code === 'fetch_failed' && typeof err.details?.httpStatus === 'number') {
    const httpStatus = err.details.httpStatus;
    if (httpStatus >= 300 && httpStatus < 400) {
      return fail(kind, ref, 'blocked_unsafe_url', err.code, err.message, { details: err.details, retryable: false });
    }
    return fail(kind, ref, 'unresolvable', err.code, err.message, {
      details: err.details,
      retryable: httpStatus === 404 || httpStatus >= 500,
    });
  }
  const status =
    err.code === 'file_scheme_rejected' || err.code === 'cross_origin_rejected'
      ? 'blocked_unsafe_url'
      : 'invalid_schema';
  return fail(kind, ref, status, err.code, err.message, { details: err.details, retryable: false });
}

const DRAFT_07_DIALECTS = new Set([
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema',
]);
const DRAFT_2019_09_DIALECTS = new Set([
  'http://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2019-09/schema',
]);

function normalizeDialect(dialect: string | undefined): 'draft-07' | 'draft-2019-09' | undefined {
  if (!dialect) return 'draft-2019-09';
  const normalized = dialect.endsWith('#') ? dialect.slice(0, -1) : dialect;
  if (DRAFT_07_DIALECTS.has(normalized)) return 'draft-07';
  if (DRAFT_2019_09_DIALECTS.has(normalized)) return 'draft-2019-09';
  return undefined;
}

function countSchemaKeywords(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countSchemaKeywords(item), 0);
  let count = 0;
  for (const value of Object.values(node as Record<string, unknown>)) {
    count += 1;
    count += countSchemaKeywords(value);
  }
  return count;
}

function validateJsonSchema(
  schema: Record<string, unknown>,
  maxKeywords: number
):
  | { ok: true }
  | { ok: false; code: CanonicalReferenceResolutionCode; message: string; details?: Record<string, unknown> } {
  const dialect = typeof schema.$schema === 'string' ? schema.$schema : undefined;
  const normalizedDialect = normalizeDialect(dialect);
  if (!normalizedDialect) {
    return {
      ok: false,
      code: 'schema_dialect_unsupported',
      message: `unsupported JSON Schema dialect${dialect ? `: ${dialect}` : ''}; expected Draft-07 or Draft 2019-09`,
      details: { dialect },
    };
  }

  const keywordCount = countSchemaKeywords(schema);
  if (keywordCount > maxKeywords) {
    return {
      ok: false,
      code: 'schema_keyword_limit_exceeded',
      message: `JSON Schema keyword count ${keywordCount} exceeds limit ${maxKeywords}`,
      details: { keywordCount, maxKeywords },
    };
  }

  const ajv = new Ajv2019({ strict: false, allErrors: true, validateSchema: true });
  addFormats(ajv);
  ajv.addMetaSchema(draft7MetaSchema);
  ajv.addMetaSchema({ ...draft7MetaSchema, $id: 'https://json-schema.org/draft-07/schema#' });
  const schemaToCompile =
    normalizedDialect === 'draft-07'
      ? { ...schema, $schema: 'http://json-schema.org/draft-07/schema#' }
      : { ...schema, $schema: 'https://json-schema.org/draft/2019-09/schema' };
  try {
    ajv.compile(schemaToCompile);
  } catch (err) {
    return {
      ok: false,
      code: 'schema_compile_failed',
      message: err instanceof Error ? err.message : String(err),
      details: { errors: ajv.errors?.slice(0, 10) ?? [] },
    };
  }
  return { ok: true };
}

export function createCanonicalReferenceResolver(
  defaultOptions: CanonicalReferenceResolverOptions = {}
): CanonicalReferenceResolver {
  const cache = defaultOptions.cache ?? createMemoryCanonicalReferenceCache();
  const fetchCache = createMemoryFormatSchemaCache();

  async function resolveReference(
    ref: FormatSchemaRef,
    options: ResolveCanonicalReferenceOptions
  ): Promise<CanonicalReferenceResolutionResult> {
    const merged: CanonicalReferenceResolverOptions = { ...defaultOptions, ...options };
    const kind = options.kind;
    const key = ref && typeof ref.uri === 'string' && typeof ref.digest === 'string' ? cacheKey(kind, ref) : undefined;
    if (key) {
      const cached = cache.get(key);
      if (cached) return cloneResolvedResult(cached, true);
    }

    let fetched: FormatSchemaFetchResult;
    try {
      fetched = await fetchFormatSchema(ref, toFetchOptions(merged, fetchCache));
    } catch (err) {
      if (err instanceof FormatSchemaFetchError) return mapFetchError(kind, ref ?? {}, err);
      return fail(kind, ref ?? {}, 'unresolvable', 'network_error', err instanceof Error ? err.message : String(err));
    }

    let document = fetched.schema;
    let refCount: number | undefined;
    let maxDepthSeen: number | undefined;

    if (kind === 'format_schema') {
      try {
        const resolved = await resolveSchemaRefs(document, fetched.ref.uri, {
          maxDepth: merged.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH,
          maxRefCount: merged.maxRefCount ?? DEFAULT_MAX_REF_COUNT,
          mirrorHost: merged.mirrorHost,
          mirrorHosts: merged.mirrorHosts,
          timeoutMs: merged.timeoutMs,
          maxBodyBytes: merged.maxBodyBytes,
          allowInternalReferences: merged.allowInternalReferences,
          fetchExternal: merged.fetchExternal,
        });
        document = resolved.schema;
        refCount = resolved.refCount;
        maxDepthSeen = resolved.maxDepthSeen;
      } catch (err) {
        if (err instanceof SchemaRefSandboxError) return mapSandboxError(kind, fetched.ref, err);
        return fail(
          kind,
          fetched.ref,
          'invalid_schema',
          'fetch_failed',
          err instanceof Error ? err.message : String(err)
        );
      }

      const schemaValidation = validateJsonSchema(document, merged.maxKeywords ?? DEFAULT_MAX_KEYWORDS);
      if (!schemaValidation.ok) {
        return fail(kind, fetched.ref, 'invalid_schema', schemaValidation.code, schemaValidation.message, {
          details: schemaValidation.details,
        });
      }
    }

    const resolved: CanonicalReferenceResolvedResult = {
      ok: true,
      status: 'resolved',
      kind,
      ref: fetched.ref,
      document,
      rawDocument: fetched.schema,
      fromCache: false,
      refCount,
      maxDepthSeen,
    };
    if (key) cache.set(key, resolved);
    return cloneResolvedResult(resolved, false);
  }

  return {
    resolveReference,
    resolveFormatSchema(ref, options = {}) {
      return resolveReference(ref, { ...options, kind: 'format_schema' });
    },
    resolvePlatformExtension(ref, options = {}) {
      return resolveReference(ref, { ...options, kind: 'platform_extensions' });
    },
  };
}

export async function resolveFormatSchema(
  ref: FormatSchemaRef,
  options: CanonicalReferenceResolverOptions = {}
): Promise<CanonicalReferenceResolutionResult> {
  return createCanonicalReferenceResolver(options).resolveFormatSchema(ref);
}

export async function resolvePlatformExtension(
  ref: FormatSchemaRef,
  options: CanonicalReferenceResolverOptions = {}
): Promise<CanonicalReferenceResolutionResult> {
  return createCanonicalReferenceResolver(options).resolvePlatformExtension(ref);
}

export const createCanonicalRefResolver = createCanonicalReferenceResolver;
