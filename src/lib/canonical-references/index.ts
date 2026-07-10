/**
 * Hardened resolver for immutable AdCP canonical references.
 *
 * `format_schema` and `platform_extensions` share the same reference shape:
 * `{ uri, digest }`, where digest is `sha256:` plus a 64-character lowercase
 * hex digest of the fetched body. This module gives callers one security
 * boundary for resolving those references: HTTPS-only by default, DNS-pinned
 * SSRF-safe fetches, redirects disabled, body and timeout caps, digest
 * verification, caller-owned caching, and structured non-throwing results.
 */
import { createHash } from 'crypto';
import Ajv from 'ajv';
// Loaded via `require` (extension-lenient CJS resolution) rather than a
// bare-specifier `import` — ajv ships no `exports` map, so Node's ESM resolver
// would demand an explicit `ajv/dist/2020.js`. The ESM build gets a
// `createRequire` shim, so `require` is available in both formats.
const Ajv2020 = require('ajv/dist/2020') as typeof import('ajv/dist/2020').default;
import addFormats from 'ajv-formats';
import { ssrfSafeFetch, SSRF_TRANSIENT_CODES, SsrfRefusedError } from '../net/ssrf-fetch';
import {
  DEFAULT_MAX_KEYWORDS,
  DEFAULT_MAX_REF_COUNT,
  DEFAULT_MAX_REF_DEPTH,
  DEFAULT_VALIDATION_BUDGET_MS,
  resolveSchemaRefs,
  SchemaRefSandboxError,
  type ResolveSchemaRefsOptions,
} from '../v2/format-schema/sandbox-refs';
import { findUnsafeRegexPattern, unsafeRegexDetails } from '../v2/format-schema/regex-safety';

export interface CanonicalReference {
  uri: string;
  /** `sha256:` prefix plus 64 lowercase hex characters. */
  digest: string;
}

export type CanonicalReferenceKind = 'format_schema' | 'platform_extensions' | 'generic';

export type CanonicalReferenceStatus =
  | 'resolved'
  | 'unresolvable'
  | 'invalid_document'
  | 'invalid_schema'
  | 'digest_mismatch'
  | 'blocked_unsafe_url'
  | 'invalid_ref';

export type CanonicalReferenceErrorCode =
  | 'invalid_ref'
  | 'non_https_url'
  | 'unsafe_url'
  | 'redirect_blocked'
  | 'http_error'
  | 'network_error'
  | 'body_too_large'
  | 'invalid_json'
  | 'invalid_json_schema'
  | 'unsupported_schema_draft'
  | 'ref_sandbox_violation'
  | 'external_ref_unpinned'
  | 'keyword_limit_exceeded'
  | 'budget_exceeded'
  | 'digest_mismatch';

export interface CanonicalReferenceError {
  code: CanonicalReferenceErrorCode;
  message: string;
  /** True only for transient network/server classes callers may retry later. */
  retryable: boolean;
  /** Digest mismatch means the fetched body was not the immutable document requested. */
  securitySignal?: 'substitution_attack';
  details?: Record<string, unknown>;
}

interface CanonicalReferenceResultBase {
  ok: boolean;
  status: CanonicalReferenceStatus;
  kind: CanonicalReferenceKind;
  ref: CanonicalReference;
  cacheKey: string;
  fromCache: boolean;
}

export interface CanonicalReferenceResolvedResult<TDocument = unknown> extends CanonicalReferenceResultBase {
  ok: true;
  status: 'resolved';
  document: TDocument;
  body: Uint8Array;
  text: string;
  contentType?: string;
  httpStatus: number;
  schemaMeta?: {
    draft: 'draft-07' | '2020-12';
    refCount: number;
    maxRefDepthSeen: number;
    keywordCount: number;
    validationTimeMs: number;
  };
}

export interface FormatSchemaReferenceResolvedResult extends CanonicalReferenceResolvedResult<Record<string, unknown>> {
  kind: 'format_schema';
  schemaMeta: NonNullable<CanonicalReferenceResolvedResult['schemaMeta']>;
}

export interface CanonicalReferenceFailureResult extends CanonicalReferenceResultBase {
  ok: false;
  status: Exclude<CanonicalReferenceStatus, 'resolved'>;
  error: CanonicalReferenceError;
  httpStatus?: number;
}

export type CanonicalReferenceResult<TDocument = unknown> =
  | CanonicalReferenceResolvedResult<TDocument>
  | CanonicalReferenceFailureResult;

export type FormatSchemaReferenceResult = FormatSchemaReferenceResolvedResult | CanonicalReferenceFailureResult;
export type PlatformExtensionsReferenceResult = CanonicalReferenceResult<unknown>;

export type ExternalRefDigestMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface CanonicalReferenceCache {
  get(key: string): CanonicalReferenceResolvedResult | undefined;
  set(key: string, value: CanonicalReferenceResolvedResult): void;
}

export interface CanonicalReferenceResolverOptions {
  /** Caller-owned cache. Defaults to a fresh per-resolver Map. */
  cache?: CanonicalReferenceCache;
  /** Default 5_000 ms. */
  timeoutMs?: number;
  /** Default 1 MiB. */
  maxBodyBytes?: number;
  /** Test/dev-only escape hatch for loopback fixtures. Production callers should leave false. */
  allowUnsafeHttp?: boolean;
  /** Test/dev-only escape hatch for loopback/private-network fixtures. Production callers should leave false. */
  allowPrivateNetwork?: boolean;
  /** Default 8 for `format_schema` `$ref` walks. */
  maxRefDepth?: number;
  /** Default 256 for `format_schema` `$ref` walks. */
  maxRefCount?: number;
  /** Default 10_000 approximate schema keyword/object-key bound. */
  maxKeywords?: number;
  /** Default 250 ms soft compile-time budget for JSON Schema validation. */
  validationBudgetMs?: number;
  /** Required for each external `$ref` URI in `format_schema`; keeps transitive schemas immutable. */
  externalRefDigests?: ExternalRefDigestMap;
  /** Default 8 MiB cumulative cap across external `$ref` bodies. */
  maxTotalRefBytes?: number;
  /** Default 5_000 ms total wall-clock budget across external `$ref` resolution. */
  maxRefResolutionMs?: number;
  /** Override the trusted mirror host set for `format_schema` external `$ref`s. */
  mirrorHosts?: readonly string[];
  /** Single-host convenience override for `format_schema` external `$ref`s. */
  mirrorHost?: string;
}

export interface CanonicalReferenceResolveOptions extends Omit<CanonicalReferenceResolverOptions, 'cache'> {
  cache?: CanonicalReferenceCache;
  kind?: CanonicalReferenceKind;
}

export interface CanonicalReferenceResolver {
  cache: CanonicalReferenceCache;
  resolveFormatSchema(
    ref: CanonicalReference,
    options?: Omit<CanonicalReferenceResolveOptions, 'cache' | 'kind'>
  ): Promise<FormatSchemaReferenceResult>;
  resolvePlatformExtensions(
    ref: CanonicalReference,
    options?: Omit<CanonicalReferenceResolveOptions, 'cache' | 'kind'>
  ): Promise<CanonicalReferenceResult<unknown>>;
  resolve(
    ref: CanonicalReference,
    options?: Omit<CanonicalReferenceResolveOptions, 'cache'>
  ): Promise<CanonicalReferenceResult<unknown>>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_REF_BYTES = 8 * 1024 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DRAFT_07_URIS = new Set(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#']);
const DRAFT_2020_12_URIS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
]);
const SPECIAL_USE_HOSTS = new Set([
  'localhost',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'home.arpa',
  'invalid',
  'local',
  'test',
]);

export function createCanonicalReferenceCache(): CanonicalReferenceCache {
  const store = new Map<string, CanonicalReferenceResolvedResult>();
  return {
    get: key => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

export function canonicalReferenceCacheKey(
  ref: CanonicalReference,
  options: Pick<CanonicalReferenceResolveOptions, 'allowPrivateNetwork' | 'allowUnsafeHttp' | 'maxBodyBytes'> = {}
): string {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const privateNetwork = options.allowPrivateNetwork === true ? 1 : 0;
  const unsafeHttp = options.allowUnsafeHttp === true ? 1 : 0;
  return `${ref.uri}@${ref.digest}#priv=${privateNetwork}#http=${unsafeHttp}#max=${maxBodyBytes}`;
}

function cloneResolved<TDocument>(
  result: CanonicalReferenceResolvedResult<TDocument>
): CanonicalReferenceResolvedResult<TDocument> {
  return {
    ...result,
    ref: { ...result.ref },
    body: Uint8Array.from(result.body),
    document: structuredClone(result.document),
    schemaMeta: result.schemaMeta ? { ...result.schemaMeta } : undefined,
  };
}

export function createCanonicalReferenceResolver(
  defaults: CanonicalReferenceResolverOptions = {}
): CanonicalReferenceResolver {
  const cache = defaults.cache ?? createCanonicalReferenceCache();
  const merge = (options: Omit<CanonicalReferenceResolveOptions, 'cache'> = {}): CanonicalReferenceResolveOptions => ({
    ...defaults,
    ...options,
    cache,
  });
  return {
    cache,
    resolveFormatSchema: (ref, options) =>
      resolveFormatSchemaReference(ref, merge({ ...options, kind: 'format_schema' })),
    resolvePlatformExtensions: (ref, options) =>
      resolvePlatformExtensionsReference(ref, merge({ ...options, kind: 'platform_extensions' })),
    resolve: (ref, options) => resolveCanonicalReference(ref, merge(options)),
  };
}

export async function resolvePlatformExtensionsReference(
  ref: CanonicalReference,
  options: CanonicalReferenceResolveOptions = {}
): Promise<PlatformExtensionsReferenceResult> {
  return resolveCanonicalReference(ref, { ...options, kind: 'platform_extensions' });
}

export async function resolveFormatSchemaReference(
  ref: CanonicalReference,
  options: CanonicalReferenceResolveOptions = {}
): Promise<FormatSchemaReferenceResult> {
  const fetched = await fetchJsonReference(ref, { ...options, kind: 'format_schema' });
  if (!fetched.ok) return fetched;
  if (!fetched.document || typeof fetched.document !== 'object' || Array.isArray(fetched.document)) {
    return fail(
      'format_schema',
      ref,
      fetched.cacheKey,
      'invalid_schema',
      'invalid_json',
      'format_schema must be a JSON object'
    );
  }

  const schema = fetched.document as Record<string, unknown>;
  const validated = await validateFormatSchema(schema, ref.uri, options);
  if (!validated.ok) {
    return {
      ok: false,
      status: validated.status ?? 'invalid_schema',
      kind: 'format_schema',
      ref,
      cacheKey: fetched.cacheKey,
      fromCache: false,
      error: validated.error,
    };
  }

  return cloneResolved({
    ...fetched,
    kind: 'format_schema',
    document: validated.schema,
    schemaMeta: validated.meta,
  }) as FormatSchemaReferenceResolvedResult;
}

export async function resolveCanonicalReference(
  ref: CanonicalReference,
  options: CanonicalReferenceResolveOptions = {}
): Promise<CanonicalReferenceResult<unknown>> {
  return fetchJsonReference(ref, options);
}

async function fetchJsonReference(
  ref: CanonicalReference,
  options: CanonicalReferenceResolveOptions
): Promise<CanonicalReferenceResult<unknown>> {
  const kind = options.kind ?? 'generic';
  const valid = validateRef(ref, kind, options);
  if (!valid.ok) return valid.result;

  const cache = options.cache;
  const cacheKey = canonicalReferenceCacheKey(ref, options);
  const cached = cache?.get(cacheKey);
  if (cached) {
    return { ...cloneResolved(cached), kind, ref, cacheKey, fromCache: true };
  }

  let response;
  try {
    response = await ssrfSafeFetch(ref.uri, {
      method: 'GET',
      headers: { accept: 'application/json, application/schema+json' },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      allowPrivateIp: options.allowPrivateNetwork === true,
    });
  } catch (err) {
    if (err instanceof SsrfRefusedError) {
      if (err.code === 'body_exceeds_limit') {
        return fail(
          kind,
          ref,
          cacheKey,
          'unresolvable',
          'body_too_large',
          'Response body exceeded the configured cap',
          {
            retryable: false,
          }
        );
      }
      if (SSRF_TRANSIENT_CODES.has(err.code)) {
        return fail(
          kind,
          ref,
          cacheKey,
          'unresolvable',
          'network_error',
          'Transient network failure while fetching canonical reference',
          {
            retryable: true,
          }
        );
      }
      const blockedCode = err.code === 'non_https_without_opt_in' ? 'non_https_url' : 'unsafe_url';
      return fail(
        kind,
        ref,
        cacheKey,
        'blocked_unsafe_url',
        blockedCode,
        'Canonical reference URL was blocked by SSRF policy',
        {
          details: { ssrfCode: err.code, hostname: err.hostname },
        }
      );
    }
    return fail(
      kind,
      ref,
      cacheKey,
      'unresolvable',
      'network_error',
      'Network failure while fetching canonical reference',
      {
        retryable: true,
      }
    );
  }

  if (response.status >= 300 && response.status < 400) {
    return fail(
      kind,
      ref,
      cacheKey,
      'blocked_unsafe_url',
      'redirect_blocked',
      'HTTP redirects are disabled for canonical references',
      {
        httpStatus: response.status,
      }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    return fail(
      kind,
      ref,
      cacheKey,
      'unresolvable',
      'http_error',
      `HTTP ${response.status} while fetching canonical reference`,
      {
        retryable: response.status >= 500 || response.status === 429,
        httpStatus: response.status,
      }
    );
  }

  const actualDigest = `sha256:${createHash('sha256').update(response.body).digest('hex')}`;
  if (actualDigest !== ref.digest) {
    return fail(kind, ref, cacheKey, 'digest_mismatch', 'digest_mismatch', 'Canonical reference digest mismatch', {
      securitySignal: 'substitution_attack',
      details: { actualDigest },
    });
  }

  const text = new TextDecoder('utf-8').decode(response.body);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail(kind, ref, cacheKey, 'invalid_document', 'invalid_json', 'Canonical reference body is not valid JSON');
  }

  const result: CanonicalReferenceResolvedResult = {
    ok: true,
    status: 'resolved',
    kind,
    ref,
    cacheKey,
    fromCache: false,
    document,
    body: response.body,
    text,
    contentType: response.headers['content-type'],
    httpStatus: response.status,
  };
  const cachedResult = cloneResolved(result);
  cache?.set(cacheKey, cachedResult);
  return cloneResolved(cachedResult);
}

async function fetchJsonReferenceDocument(
  ref: CanonicalReference,
  kind: CanonicalReferenceKind,
  options: CanonicalReferenceResolveOptions
): Promise<CanonicalReferenceResult<unknown>> {
  return fetchJsonReference(ref, { ...options, kind });
}

function validateRef(
  ref: CanonicalReference,
  kind: CanonicalReferenceKind,
  options: CanonicalReferenceResolveOptions
): { ok: true } | { ok: false; result: CanonicalReferenceFailureResult } {
  const fallbackRef: CanonicalReference = {
    uri: typeof ref?.uri === 'string' ? ref.uri : '<missing>',
    digest: typeof ref?.digest === 'string' ? ref.digest : '<missing>',
  };
  const cacheKey = canonicalReferenceCacheKey(fallbackRef, options);
  if (!ref || typeof ref.uri !== 'string' || typeof ref.digest !== 'string') {
    return {
      ok: false,
      result: fail(
        kind,
        fallbackRef,
        cacheKey,
        'invalid_ref',
        'invalid_ref',
        'Canonical reference must carry { uri, digest }'
      ),
    };
  }
  if (!DIGEST_RE.test(ref.digest)) {
    return {
      ok: false,
      result: fail(
        kind,
        ref,
        cacheKey,
        'invalid_ref',
        'invalid_ref',
        'Canonical reference digest must be `sha256:` plus 64 lowercase hex characters'
      ),
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(ref.uri);
  } catch {
    return {
      ok: false,
      result: fail(kind, ref, cacheKey, 'invalid_ref', 'invalid_ref', 'Canonical reference URI is not a valid URL'),
    };
  }
  const specialUseHost = specialUseHostname(parsed.hostname);
  if (specialUseHost) {
    return {
      ok: false,
      result: fail(
        kind,
        ref,
        cacheKey,
        'blocked_unsafe_url',
        'unsafe_url',
        'Canonical reference URI uses a special-use hostname',
        { details: { hostname: specialUseHost } }
      ),
    };
  }
  if (parsed.protocol !== 'https:') {
    if (parsed.protocol === 'http:' && options.allowUnsafeHttp === true) return { ok: true };
    return {
      ok: false,
      result: fail(
        kind,
        ref,
        cacheKey,
        'blocked_unsafe_url',
        'non_https_url',
        'Canonical reference URI must use https://'
      ),
    };
  }
  return { ok: true };
}

function specialUseHostname(hostname: string): string | null {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (SPECIAL_USE_HOSTS.has(host)) return host;
  if (host.endsWith('.example')) return host;
  if (host.endsWith('.home.arpa')) return host;
  if (host.endsWith('.localhost')) return host;
  if (host.endsWith('.local')) return host;
  if (host.endsWith('.invalid')) return host;
  if (host.endsWith('.test')) return host;
  if (host.endsWith('.example.com')) return host;
  if (host.endsWith('.example.net')) return host;
  if (host.endsWith('.example.org')) return host;
  return null;
}

function fail(
  kind: CanonicalReferenceKind,
  ref: CanonicalReference,
  cacheKey: string,
  status: Exclude<CanonicalReferenceStatus, 'resolved'>,
  code: CanonicalReferenceErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    securitySignal?: 'substitution_attack';
    details?: Record<string, unknown>;
    httpStatus?: number;
  } = {}
): CanonicalReferenceFailureResult {
  return {
    ok: false,
    status,
    kind,
    ref,
    cacheKey,
    fromCache: false,
    httpStatus: options.httpStatus,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      securitySignal: options.securitySignal,
      details: options.details,
    },
  };
}

type FormatSchemaValidation =
  | {
      ok: true;
      schema: Record<string, unknown>;
      meta: NonNullable<CanonicalReferenceResolvedResult['schemaMeta']>;
    }
  | { ok: false; status?: Exclude<CanonicalReferenceStatus, 'resolved'>; error: CanonicalReferenceError };

async function validateFormatSchema(
  schema: Record<string, unknown>,
  parentUri: string,
  options: CanonicalReferenceResolveOptions
): Promise<FormatSchemaValidation> {
  const draft = detectDraft(schema);
  if (!draft.ok) return { ok: false, error: draft.error };

  let resolved;
  try {
    resolved = await resolveSchemaRefs(schema, parentUri, {
      maxDepth: options.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH,
      maxRefCount: options.maxRefCount ?? DEFAULT_MAX_REF_COUNT,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      mirrorHost: options.mirrorHost,
      mirrorHosts: options.mirrorHosts,
      fetchExternal: makeExternalSchemaFetcher(options),
    } satisfies ResolveSchemaRefsOptions);
  } catch (err) {
    if (err instanceof SchemaRefSandboxError) {
      const mapped = canonicalFailureFromSchemaRefError(err);
      if (mapped) {
        return {
          ok: false,
          status: mapped.status,
          error: mapped.error,
        };
      }
      return {
        ok: false,
        status: 'invalid_schema',
        error: {
          code: 'ref_sandbox_violation',
          message: 'format_schema $ref sandbox rejected a reference',
          retryable: false,
          details: { sandboxCode: err.code, ref: err.ref },
        },
      };
    }
    return {
      ok: false,
      status: 'invalid_schema',
      error: { code: 'invalid_json_schema', message: 'format_schema $ref resolution failed', retryable: false },
    };
  }

  const keywordCount = countSchemaKeywords(resolved.schema);
  const maxKeywords = options.maxKeywords ?? DEFAULT_MAX_KEYWORDS;
  if (keywordCount > maxKeywords) {
    return {
      ok: false,
      error: {
        code: 'keyword_limit_exceeded',
        message: `format_schema keyword count exceeded ${maxKeywords}`,
        retryable: false,
        details: { keywordCount, maxKeywords },
      },
    };
  }

  const unsafeRegex = findUnsafeRegexPattern(resolved.schema);
  if (unsafeRegex) {
    return {
      ok: false,
      error: {
        code: 'budget_exceeded',
        message: 'format_schema regex safety budget exceeded',
        retryable: false,
        details: unsafeRegexDetails(unsafeRegex),
      },
    };
  }

  const ajv = draft.draft === '2020-12' ? getDraft2020Ajv() : getDraft07Ajv();
  const started = process.cpuUsage();
  try {
    ajv.compile(resolved.schema);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_json_schema',
        message: 'format_schema is not a valid JSON Schema document',
        retryable: false,
        details: { reason: err instanceof Error ? err.message : String(err) },
      },
    };
  }
  // Ajv compilation is synchronous; CPU time avoids false budget failures when
  // the process is descheduled during highly parallel test or CI runs.
  const validationTimeMs = cpuUsageMs(started);
  const validationBudgetMs = options.validationBudgetMs ?? DEFAULT_VALIDATION_BUDGET_MS;
  if (validationTimeMs > validationBudgetMs) {
    return {
      ok: false,
      error: {
        code: 'invalid_json_schema',
        message: `format_schema compile exceeded ${validationBudgetMs} ms validation budget`,
        retryable: false,
        details: { validationTimeMs, validationBudgetMs },
      },
    };
  }

  return {
    ok: true,
    schema: resolved.schema,
    meta: {
      draft: draft.draft,
      refCount: resolved.refCount,
      maxRefDepthSeen: resolved.maxDepthSeen,
      keywordCount,
      validationTimeMs,
    },
  };
}

function cpuUsageMs(started: NodeJS.CpuUsage): number {
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1000;
}

function detectDraft(
  schema: Record<string, unknown>
): { ok: true; draft: 'draft-07' | '2020-12' } | { ok: false; error: CanonicalReferenceError } {
  const raw = schema.$schema;
  if (raw === undefined) {
    return {
      ok: false,
      error: {
        code: 'unsupported_schema_draft',
        message: 'format_schema must declare $schema',
        retryable: false,
      },
    };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: {
        code: 'unsupported_schema_draft',
        message: 'format_schema.$schema must be a JSON Schema draft URI string',
        retryable: false,
      },
    };
  }
  if (DRAFT_07_URIS.has(raw)) return { ok: true, draft: 'draft-07' };
  if (DRAFT_2020_12_URIS.has(raw)) return { ok: true, draft: '2020-12' };
  return {
    ok: false,
    error: {
      code: 'unsupported_schema_draft',
      message: 'format_schema must declare Draft-07 or Draft 2020-12',
      retryable: false,
      details: { schema: raw },
    },
  };
}

function getDraft07Ajv(): Ajv {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateSchema: true,
    validateFormats: true,
    addUsedSchema: false,
  });
  addFormats(ajv);
  return ajv;
}

function getDraft2020Ajv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateSchema: true,
    validateFormats: true,
    addUsedSchema: false,
  });
  addFormats(ajv);
  return ajv;
}

type MappedSchemaRefFailure = {
  status: Exclude<CanonicalReferenceStatus, 'resolved'>;
  error: CanonicalReferenceError;
};

function canonicalFailureFromSchemaRefError(err: SchemaRefSandboxError): MappedSchemaRefFailure | null {
  const details = err.details as
    | {
        canonicalStatus?: Exclude<CanonicalReferenceStatus, 'resolved'>;
        canonicalErrorCode?: CanonicalReferenceErrorCode;
        retryable?: boolean;
        securitySignal?: 'substitution_attack';
        details?: Record<string, unknown>;
      }
    | undefined;
  if (!details?.canonicalStatus || !details.canonicalErrorCode) return null;
  return {
    status: details.canonicalStatus,
    error: {
      code: details.canonicalErrorCode,
      message: err.message,
      retryable: details.retryable === true,
      securitySignal: details.securitySignal,
      details: { ref: err.ref, ...details.details },
    },
  };
}

function makeExternalSchemaFetcher(
  options: CanonicalReferenceResolveOptions
): (uri: string) => Promise<Record<string, unknown>> {
  const deadlineMs = Date.now() + (options.maxRefResolutionMs ?? DEFAULT_TIMEOUT_MS);
  const maxTotalRefBytes = options.maxTotalRefBytes ?? DEFAULT_MAX_TOTAL_REF_BYTES;
  let totalRefBytes = 0;

  return async uri => {
    const expectedDigest = lookupExternalRefDigest(options.externalRefDigests, uri);
    if (!expectedDigest) {
      throwExternalRefFailure(uri, 'invalid_schema', 'external_ref_unpinned', 'External $ref missing pinned digest');
    }
    const refValidation = validateRef({ uri, digest: expectedDigest }, 'format_schema', options);
    if (!refValidation.ok) {
      throwExternalRefFailure(
        uri,
        refValidation.result.status,
        refValidation.result.error.code,
        refValidation.result.error.message,
        {
          retryable: refValidation.result.error.retryable,
          securitySignal: refValidation.result.error.securitySignal,
          details: refValidation.result.error.details,
        }
      );
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throwExternalRefFailure(uri, 'unresolvable', 'network_error', 'External $ref resolution budget exceeded', {
        retryable: true,
      });
    }

    const fetched = await fetchJsonReferenceDocument({ uri, digest: expectedDigest }, 'format_schema', {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs),
    });
    if (!fetched.ok) {
      throwExternalRefFailure(
        uri,
        fetched.status,
        fetched.error.code,
        `External $ref fetch failed: ${fetched.error.message}`,
        {
          retryable: fetched.error.retryable,
          securitySignal: fetched.error.securitySignal,
          details: {
            ...fetched.error.details,
            ...(fetched.httpStatus === undefined ? {} : { httpStatus: fetched.httpStatus }),
          },
        }
      );
    }
    totalRefBytes += fetched.body.byteLength;
    if (totalRefBytes > maxTotalRefBytes) {
      throwExternalRefFailure(uri, 'unresolvable', 'body_too_large', 'External $ref total body budget exceeded', {
        details: { totalRefBytes, maxTotalRefBytes },
      });
    }
    if (!fetched.document || typeof fetched.document !== 'object' || Array.isArray(fetched.document)) {
      throwExternalRefFailure(uri, 'invalid_schema', 'invalid_json', 'External $ref body is not a JSON object');
    }
    return fetched.document as Record<string, unknown>;
  };
}

function lookupExternalRefDigest(digests: ExternalRefDigestMap | undefined, uri: string): string | undefined {
  if (!digests) return undefined;
  if (typeof (digests as ReadonlyMap<string, string>).get === 'function') {
    return (digests as ReadonlyMap<string, string>).get(uri);
  }
  return (digests as Readonly<Record<string, string>>)[uri];
}

function throwExternalRefFailure(
  uri: string,
  status: Exclude<CanonicalReferenceStatus, 'resolved'>,
  code: CanonicalReferenceErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    securitySignal?: 'substitution_attack';
    details?: Record<string, unknown>;
  } = {}
): never {
  throw new SchemaRefSandboxError('fetch_failed', message, {
    ref: uri,
    details: {
      canonicalStatus: status,
      canonicalErrorCode: code,
      retryable: options.retryable === true,
      securitySignal: options.securitySignal,
      details: options.details,
    },
  });
}

function countSchemaKeywords(root: unknown): number {
  const seen = new Set<unknown>();
  const walk = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    if (seen.has(node)) return 0;
    seen.add(node);
    if (Array.isArray(node)) return node.reduce((sum, item) => sum + walk(item), 0);
    const obj = node as Record<string, unknown>;
    return Object.entries(obj).reduce((sum, [, value]) => sum + 1 + walk(value), 0);
  };
  return walk(root);
}
