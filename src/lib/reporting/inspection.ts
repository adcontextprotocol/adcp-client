import { createHash, timingSafeEqual } from 'crypto';
import { gunzipSync } from 'zlib';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { createCanonicalReferenceResolver, type CanonicalReferenceResolver } from '../canonical-references';
import { SSRF_TRANSIENT_CODES, SsrfRefusedError, ssrfSafeFetch, type SsrfFetchOptions } from '../net/ssrf-fetch';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';
import type { ReportingControlTotal } from '../types/tools.generated';
import { canonicalize } from '../utils/jcs';
import { findUnsafeRegexPattern } from '../v2/format-schema/regex-safety';
import type {
  ReportingCanonicalDigestEvidence,
  ReportingInspectionContext,
  ReportingObservation,
} from './reconciliation';

// See the canonical-reference resolver for why this is loaded through require.
const Ajv2020 = require('ajv/dist/2020') as typeof import('ajv/dist/2020').default;

export type ReportingInspectionErrorCode =
  | 'UNSUPPORTED_RESOURCE'
  | 'RESOURCE_READ_FAILED'
  | 'RESOURCE_NOT_READY'
  | 'RESOURCE_TOO_LARGE'
  | 'INSPECTION_TIMEOUT'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_INCOMPLETE'
  | 'MANIFEST_IDENTITY_MISMATCH'
  | 'MANIFEST_TOTAL_MISMATCH'
  | 'OBJECT_DUPLICATE'
  | 'OBJECT_SIZE_MISMATCH'
  | 'OBJECT_DIGEST_MISMATCH'
  | 'OBJECT_ROW_COUNT_MISMATCH'
  | 'FORMAT_UNSUPPORTED'
  | 'COMPRESSION_UNSUPPORTED'
  | 'ROW_SCHEMA_FETCH_FAILED'
  | 'ROW_SCHEMA_INVALID'
  | 'ROW_SCHEMA_VIOLATION'
  | 'REPORT_DEFINITION_FETCH_FAILED'
  | 'REPORT_DEFINITION_INVALID'
  | 'CANONICALIZATION_FETCH_FAILED'
  | 'CANONICALIZATION_INVALID'
  | 'ROW_COUNT_MISMATCH'
  | 'CONTROL_TOTAL_UNSUPPORTED'
  | 'CONTROL_TOTAL_MISMATCH'
  | 'CANONICAL_DIGEST_MISMATCH';

export class ReportingInspectionError extends Error {
  constructor(
    readonly code: ReportingInspectionErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
    readonly observation?: ReportingObservation
  ) {
    super(message, options);
    this.name = 'ReportingInspectionError';
  }
}

export type ReportingResourceReadRole = 'manifest' | 'object';

export interface ReportingResourceReadRequest<TCredential = unknown> {
  role: ReportingResourceReadRole;
  location: string;
  objectRef?: string;
  expectedSizeBytes?: number;
  maxBytes: number;
  credential?: TCredential;
  context: ReportingInspectionContext;
  signal?: AbortSignal;
}

export interface ReportingResourceReadResult {
  body: Uint8Array;
  contentType?: string;
}

export interface ReportingResourceReader<TCredential = unknown> {
  read(request: ReportingResourceReadRequest<TCredential>): Promise<ReportingResourceReadResult>;
}

export interface ReportingCredentialProvider<TCredential = unknown> {
  getCredentials(context: ReportingInspectionContext): Promise<TCredential | undefined>;
}

export interface ReportingHttpCredentials {
  /** Request headers such as Authorization. Values are never copied into errors or receipts. */
  headers: Readonly<Record<string, string>>;
  /** Exact HTTPS origins authorized to receive these headers. */
  allowedOrigins: readonly string[];
}

export interface HttpsReportingResourceReaderOptions extends Pick<
  SsrfFetchOptions,
  'allowPrivateIp' | 'timeoutMs' | 'trustedFetchFn' | 'tls'
> {
  maxBodyBytes?: number;
  /** Exact HTTPS origins authorized to receive configured mTLS material. */
  tlsAllowedOrigins?: readonly string[];
}

const FORBIDDEN_HTTP_CREDENTIAL_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);

/**
 * Reader for HTTPS manifests and same-origin objects. DNS pinning, private-IP
 * refusal, redirect blocking, deadlines, and body caps come from ssrfSafeFetch.
 */
export function createHttpsReportingResourceReader(
  options: HttpsReportingResourceReaderOptions = {}
): ReportingResourceReader<ReportingHttpCredentials> {
  return {
    async read(request) {
      let target: URL;
      try {
        const base = new URL(request.location);
        target = request.role === 'manifest' ? base : new URL(request.objectRef!, base);
        if (base.username || base.password || target.username || target.password) {
          throw inspectionError('RESOURCE_READ_FAILED', 'Reporting resource URLs may not contain userinfo');
        }
        if (request.role === 'object' && target.origin !== base.origin) {
          throw inspectionError(
            'RESOURCE_READ_FAILED',
            'Manifest object_ref must resolve on the configured destination origin'
          );
        }
      } catch (error) {
        if (error instanceof ReportingInspectionError) throw error;
        throw inspectionError('RESOURCE_READ_FAILED', 'Reporting resource location is not a valid URL');
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.credential?.headers ?? {})) {
        const normalized = name.toLowerCase();
        if (FORBIDDEN_HTTP_CREDENTIAL_HEADERS.has(normalized)) {
          throw inspectionError('RESOURCE_READ_FAILED', `Credential provider may not set the ${normalized} header`);
        }
        headers[normalized] = value;
      }
      if (Object.keys(headers).length > 0 && !request.credential?.allowedOrigins.includes(target.origin)) {
        throw inspectionError('RESOURCE_READ_FAILED', 'Reporting credential is not authorized for the resource origin');
      }
      if (options.tls && !options.tlsAllowedOrigins?.includes(target.origin)) {
        throw inspectionError(
          'RESOURCE_READ_FAILED',
          'Reporting mTLS credential is not authorized for the resource origin'
        );
      }
      headers.accept =
        request.role === 'manifest' ? 'application/json' : 'application/octet-stream, text/csv, application/json';

      try {
        const response = await ssrfSafeFetch(target.href, {
          method: 'GET',
          headers,
          allowPrivateIp: options.allowPrivateIp,
          timeoutMs: options.timeoutMs,
          trustedFetchFn: options.trustedFetchFn,
          tls: options.tls,
          signal: request.signal,
          maxBodyBytes: Math.min(request.maxBytes, options.maxBodyBytes ?? request.maxBytes),
        });
        if (response.status < 200 || response.status >= 300) {
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500 ||
            (request.role === 'manifest' && response.status === 404);
          throw inspectionError(
            retryable ? 'RESOURCE_NOT_READY' : 'RESOURCE_READ_FAILED',
            `Reporting ${request.role} read returned HTTP ${response.status}`,
            retryable
          );
        }
        return { body: response.body, contentType: response.headers['content-type'] };
      } catch (error) {
        if (error instanceof ReportingInspectionError) throw error;
        if (error instanceof SsrfRefusedError) {
          const retryable = SSRF_TRANSIENT_CODES.has(error.code) && error.code !== 'body_exceeds_limit';
          throw inspectionError(
            error.code === 'body_exceeds_limit' ? 'RESOURCE_TOO_LARGE' : 'RESOURCE_READ_FAILED',
            'Reporting resource read was refused by the safe fetch policy',
            retryable
          );
        }
        throw inspectionError('RESOURCE_READ_FAILED', 'Reporting resource read failed', true);
      }
    },
  };
}

type ReportingFileFormat = 'jsonl' | 'csv' | 'parquet' | 'avro' | 'orc';
type ReportingFileCompression = 'none' | 'gzip' | 'zstd' | 'snappy';

interface ReportingFileEntry {
  object_ref: string;
  size_bytes: number;
  sha256: string;
  row_count: number;
  partition?: Record<string, string>;
}

interface ReportingFileManifest {
  manifest_version: '1.0';
  complete: true;
  reporting_revision_id: string;
  reporting_obligation_id: string;
  reporting_materialization_id: string;
  period: { start: string; end: string; source_timezone: string };
  format: ReportingFileFormat;
  compression: ReportingFileCompression;
  files: ReportingFileEntry[];
  total_size_bytes: number;
  row_count: number;
  control_totals: ReportingControlTotal[];
  created_at: string;
}

interface ReportingCanonicalizationContract {
  contract_version: '1.0';
  media_type: 'application/vnd.adcp.reporting-canonicalization+json';
  algorithm: 'adcp_jcs_rows_v1';
  schema_sha256: string;
  primary_keys: string[];
  golden_vectors: Array<{
    name: string;
    input_rows: Record<string, unknown>[];
    canonical_utf8_base64: string;
    sha256: string;
  }>;
}

export interface ReportingDecodedFileContext {
  format: ReportingFileFormat;
  objectRef: string;
  rowSchema: Record<string, unknown>;
  inspection: ReportingInspectionContext;
  /** Maximum rows this object may return without exceeding the inspection budget. */
  maxRows: number;
}

export type ReportingFormatDecoder = (
  body: Uint8Array,
  context: ReportingDecodedFileContext
) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

export type ReportingCompressionDecoder = (
  body: Uint8Array,
  maxOutputBytes: number
) => Promise<Uint8Array> | Uint8Array;

export type ReportingControlTotalCalculator = (
  rows: readonly Record<string, unknown>[],
  expected: readonly ReportingControlTotal[],
  context: ReportingInspectionContext
) => Promise<ReportingControlTotal[]> | ReportingControlTotal[];

export interface ReportingManifestInspectorOptions<TCredential = unknown> {
  reader: ReportingResourceReader<TCredential>;
  credentialProvider?: ReportingCredentialProvider<TCredential>;
  referenceResolver?: CanonicalReferenceResolver;
  /** Consumer-approved origins for schemas and pinned semantic contracts. */
  referenceAllowedOrigins: readonly string[];
  formatDecoders?: Partial<Record<ReportingFileFormat, ReportingFormatDecoder>>;
  compressionDecoders?: Partial<Record<ReportingFileCompression, ReportingCompressionDecoder>>;
  controlTotalCalculator?: ReportingControlTotalCalculator;
  consumerCommitRef?: string | ((context: ReportingInspectionContext) => string | undefined);
  maxManifestBytes?: number;
  maxObjectBytes?: number;
  maxDecodedObjectBytes?: number;
  maxTotalBytes?: number;
  maxDecodedTotalBytes?: number;
  maxFiles?: number;
  maxRows?: number;
  maxRowBytes?: number;
  /** Hard wall-clock budget for one inspection attempt, including custom adapters. */
  maxInspectionMs?: number;
  /** Maximum wall-clock time permitted for synchronous row-schema compilation. */
  maxSchemaCompileMs?: number;
}

const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_ROWS = 1_000_000;
const DEFAULT_MAX_ROW_BYTES = 1024 * 1024;
const DEFAULT_MAX_INSPECTION_MS = 60_000;
const DEFAULT_MAX_SCHEMA_COMPILE_MS = 1_000;
const REPORTING_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;
const CONTROL_TOTAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CANONICAL_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const ISO_DURATION_PATTERN = /^P(?=\d|T)(?=.*\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Build the SDK-managed manifest/file inspector used by reconcileReporting. */
export function createReportingManifestInspector<TCredential = unknown>(
  options: ReportingManifestInspectorOptions<TCredential>
): (context: ReportingInspectionContext) => Promise<ReportingObservation> {
  const maxInspectionMs = boundedPositiveInteger(
    options.maxInspectionMs ?? DEFAULT_MAX_INSPECTION_MS,
    'maxInspectionMs',
    3_600_000
  );
  const maxSchemaCompileMs = boundedPositiveInteger(
    options.maxSchemaCompileMs ?? DEFAULT_MAX_SCHEMA_COMPILE_MS,
    'maxSchemaCompileMs',
    60_000
  );
  const resolver = options.referenceResolver ?? createCanonicalReferenceResolver();
  const formatDecoders: Partial<Record<ReportingFileFormat, ReportingFormatDecoder>> = {
    jsonl: decodeJsonLines,
    csv: decodeCsv,
    ...options.formatDecoders,
  };
  const compressionDecoders: Partial<Record<ReportingFileCompression, ReportingCompressionDecoder>> = {
    none: body => body,
    gzip: (body, maxOutputBytes) => Uint8Array.from(gunzipSync(body, { maxOutputLength: maxOutputBytes })),
    ...options.compressionDecoders,
  };

  return async context => {
    const deadline = Date.now() + maxInspectionMs;
    const resource = context.materialization.resource;
    if (!resource || resource.kind !== 'manifest' || !resource.manifest_sha256 || resource.manifest_version !== '1.0') {
      throw inspectionError('UNSUPPORTED_RESOURCE', 'Built-in inspection requires a v1 manifest resource');
    }

    const credential = options.credentialProvider
      ? await withinInspectionDeadline(options.credentialProvider.getCredentials(context), deadline)
      : undefined;
    const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    const manifestRead = await withinInspectionDeadline(
      options.reader.read({
        role: 'manifest',
        location: resource.location,
        maxBytes: maxManifestBytes,
        credential,
        context,
        signal: deadlineSignal(deadline),
      }),
      deadline
    );
    if (manifestRead.body.byteLength > maxManifestBytes) {
      throw inspectionError('RESOURCE_TOO_LARGE', 'Reporting manifest exceeds the configured byte budget');
    }
    const manifestDigest = sha256(manifestRead.body);
    if (!constantTimeHexEqual(manifestDigest, resource.manifest_sha256)) {
      throw inspectionError(
        'MANIFEST_DIGEST_MISMATCH',
        'Manifest bytes do not match reporting_resource.manifest_sha256'
      );
    }
    const manifest = parseManifest(manifestRead.body);
    validateManifestBinding(manifest, context);

    const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    if (
      manifest.total_size_bytes > maxTotalBytes ||
      manifest.files.some(file => file.size_bytes > maxObjectBytes) ||
      manifest.files.length > (options.maxFiles ?? DEFAULT_MAX_FILES) ||
      manifest.row_count > maxRows
    ) {
      throw inspectionError(
        'RESOURCE_TOO_LARGE',
        'Manifest declares data beyond the configured inspection byte budget'
      );
    }

    const schema = await resolveRowSchema(context, resolver, options.referenceAllowedOrigins, deadline);
    const validateRow = compileRowSchema(schema, maxSchemaCompileMs, deadline);
    const reportDefinition = await validateReportDefinition(
      context,
      resolver,
      options.referenceAllowedOrigins,
      deadline
    );
    const decoder = formatDecoders[manifest.format];
    if (!decoder) throw inspectionError('FORMAT_UNSUPPORTED', `No decoder is configured for ${manifest.format}`);
    const decompress = compressionDecoders[manifest.compression];
    if (!decompress) {
      throw inspectionError('COMPRESSION_UNSUPPORTED', `No decoder is configured for ${manifest.compression}`);
    }

    const seen = new Set<string>();
    const manifestObjectRefs = new Set(manifest.files.map(file => file.object_ref));
    const evidenceKeys = new Set<string>();
    for (const checksum of context.materialization.verification?.physical_checksums ?? []) {
      const key = `${checksum.object_ref}\0${checksum.algorithm}`;
      if (!manifestObjectRefs.has(checksum.object_ref) || evidenceKeys.has(key)) {
        throw inspectionError(
          'OBJECT_DIGEST_MISMATCH',
          'Producer checksum evidence is not uniquely bound to a manifest object'
        );
      }
      evidenceKeys.add(key);
    }
    const rows: Record<string, unknown>[] = [];
    let totalBytes = 0;
    let totalDecodedBytes = 0;
    for (const file of manifest.files) {
      if (seen.has(file.object_ref))
        throw inspectionError('OBJECT_DUPLICATE', 'Manifest object_ref values must be unique');
      seen.add(file.object_ref);
      totalBytes += file.size_bytes;
      if (totalBytes > maxTotalBytes) throw inspectionError('RESOURCE_TOO_LARGE', 'Manifest exceeds total byte budget');
      assertInspectionDeadline(deadline);
      const read = await withinInspectionDeadline(
        options.reader.read({
          role: 'object',
          location: resource.location,
          objectRef: file.object_ref,
          expectedSizeBytes: file.size_bytes,
          maxBytes: Math.min(maxObjectBytes, file.size_bytes + 1),
          credential,
          context,
          signal: deadlineSignal(deadline),
        }),
        deadline
      );
      if (read.body.byteLength !== file.size_bytes) {
        throw inspectionError('OBJECT_SIZE_MISMATCH', `Object ${file.object_ref} size does not match the manifest`);
      }
      if (!constantTimeHexEqual(sha256(read.body), file.sha256)) {
        throw inspectionError(
          'OBJECT_DIGEST_MISMATCH',
          `Object ${file.object_ref} checksum does not match the manifest`
        );
      }
      for (const producerChecksum of context.materialization.verification?.physical_checksums?.filter(
        checksum => checksum.object_ref === file.object_ref
      ) ?? []) {
        const observed = digestHex(read.body, producerChecksum.algorithm);
        if (
          !constantTimeHexEqual(producerChecksum.value, observed) ||
          (producerChecksum.algorithm === 'sha256' && !constantTimeHexEqual(producerChecksum.value, file.sha256))
        ) {
          throw inspectionError(
            'OBJECT_DIGEST_MISMATCH',
            `Producer checksum evidence for ${file.object_ref} does not match the delivered object`
          );
        }
      }
      let decoded: Uint8Array;
      try {
        decoded = await withinInspectionDeadline(
          Promise.resolve(decompress(read.body, options.maxDecodedObjectBytes ?? maxObjectBytes)),
          deadline
        );
      } catch (error) {
        if (error instanceof ReportingInspectionError) throw error;
        throw inspectionError(
          'MANIFEST_INVALID',
          `Could not decode ${manifest.compression} object ${file.object_ref}`,
          false,
          error
        );
      }
      if (decoded.byteLength > (options.maxDecodedObjectBytes ?? maxObjectBytes)) {
        throw inspectionError('RESOURCE_TOO_LARGE', `Decoded object ${file.object_ref} exceeds the byte budget`);
      }
      totalDecodedBytes += decoded.byteLength;
      if (totalDecodedBytes > (options.maxDecodedTotalBytes ?? maxTotalBytes)) {
        throw inspectionError('RESOURCE_TOO_LARGE', 'Decoded reporting data exceeds the aggregate byte budget');
      }
      let fileRows: Record<string, unknown>[];
      try {
        fileRows = await withinInspectionDeadline(
          Promise.resolve(
            decoder(decoded, {
              format: manifest.format,
              objectRef: file.object_ref,
              rowSchema: schema,
              inspection: context,
              maxRows: maxRows - rows.length,
            })
          ),
          deadline
        );
      } catch (error) {
        if (error instanceof ReportingInspectionError) throw error;
        throw inspectionError('MANIFEST_INVALID', `Could not parse ${manifest.format} object ${file.object_ref}`);
      }
      if (fileRows.length !== file.row_count) {
        throw inspectionError(
          'OBJECT_ROW_COUNT_MISMATCH',
          `Object ${file.object_ref} row count does not match the manifest`
        );
      }
      if (fileRows.length > maxRows - rows.length) {
        throw inspectionError('RESOURCE_TOO_LARGE', 'Reporting row count exceeds the configured inspection budget');
      }
      for (const row of fileRows) rows.push(row);
    }

    for (let index = 0; index < rows.length; index += 1) {
      if (index % 256 === 0) assertInspectionDeadline(deadline);
      assertBoundedJsonData(rows[index], 'ROW_SCHEMA_VIOLATION');
      assertIJson(rows[index]);
      if (Buffer.byteLength(canonicalize(rows[index])) > (options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES)) {
        throw inspectionError('RESOURCE_TOO_LARGE', `Row ${index} exceeds the configured byte budget`);
      }
      if (!validateRow(rows[index])) {
        throw new ReportingInspectionError(
          'ROW_SCHEMA_VIOLATION',
          `Row ${index} does not satisfy the pinned schema`,
          false,
          {
            row: index,
            errors: sanitizeAjvErrors(validateRow.errors),
          }
        );
      }
    }
    const observedTotals = options.controlTotalCalculator
      ? await withinInspectionDeadline(
          Promise.resolve(options.controlTotalCalculator(rows, context.revision.control_totals, context)),
          deadline
        )
      : calculateNamedControlTotals(rows, context.revision.control_totals, reportDefinition, deadline);
    const expectedCanonicalDigest = context.revision.canonical_content_digest;
    let canonicalContentDigest: ReportingCanonicalDigestEvidence | undefined;
    if (expectedCanonicalDigest && context.expected.verificationProfile === 'canonical_digest') {
      canonicalContentDigest = await recomputeCanonicalDigest(
        rows,
        context,
        resolver,
        options.referenceAllowedOrigins,
        deadline
      );
    }
    const observation: ReportingObservation = {
      rowCount: rows.length,
      controlTotals: observedTotals,
      manifestSha256: manifestDigest,
      canonicalContentDigest,
    };
    if (rows.length !== manifest.row_count || rows.length !== context.revision.row_count) {
      throw inspectionMismatch(
        'ROW_COUNT_MISMATCH',
        'Observed row count does not match manifest and revision',
        observation
      );
    }
    if (
      !sameControlTotals(observedTotals, manifest.control_totals) ||
      !sameControlTotals(observedTotals, context.revision.control_totals)
    ) {
      throw inspectionMismatch(
        'CONTROL_TOTAL_MISMATCH',
        'Observed control totals do not match manifest and revision',
        observation
      );
    }

    if (canonicalContentDigest && expectedCanonicalDigest) {
      if (!constantTimeHexEqual(canonicalContentDigest.value, expectedCanonicalDigest.value)) {
        throw inspectionMismatch(
          'CANONICAL_DIGEST_MISMATCH',
          'Observed logical rows do not match the canonical content digest',
          { ...observation, canonicalContentDigest }
        );
      }
    }

    const commitRef =
      typeof options.consumerCommitRef === 'function' ? options.consumerCommitRef(context) : options.consumerCommitRef;
    return {
      rowCount: rows.length,
      controlTotals: observedTotals,
      canonicalContentDigest,
      manifestSha256: manifestDigest,
      ...(commitRef ? { consumerCommitRef: commitRef } : {}),
    };
  };
}

async function resolveRowSchema(
  context: ReportingInspectionContext,
  resolver: CanonicalReferenceResolver,
  allowedOrigins: readonly string[],
  deadline: number
): Promise<Record<string, unknown>> {
  assertAllowedReferenceOrigin(context.revision.schema_uri, allowedOrigins, 'ROW_SCHEMA_FETCH_FAILED');
  const result = await withinInspectionDeadline(
    resolver.resolve({
      uri: context.revision.schema_uri,
      digest: `sha256:${context.revision.schema_sha256.toLowerCase()}`,
    }),
    deadline
  );
  if (!result.ok) {
    throw new ReportingInspectionError('ROW_SCHEMA_FETCH_FAILED', result.error.message, result.error.retryable, {
      referenceCode: result.error.code,
    });
  }
  requireContentType(result.contentType, ['application/schema+json', 'application/json'], 'ROW_SCHEMA_INVALID');
  const document = parsePinnedJson(result.body, 'ROW_SCHEMA_INVALID');
  if (!isRecord(document)) throw inspectionError('ROW_SCHEMA_INVALID', 'Pinned row schema must be a JSON object');
  validateLocalSchema(document);
  return document;
}

function compileRowSchema(schema: Record<string, unknown>, maxCompileMs: number, deadline: number): ValidateFunction {
  assertInspectionDeadline(deadline);
  const startedAt = Date.now();
  const ajv = new Ajv2020({
    strictSchema: true,
    strictTypes: false,
    allErrors: true,
    validateSchema: true,
    addUsedSchema: false,
  });
  addFormats(ajv);
  try {
    const validate = ajv.compile(schema);
    if (Date.now() - startedAt > maxCompileMs) {
      throw inspectionError('INSPECTION_TIMEOUT', 'Pinned row schema exceeded the compilation budget', true);
    }
    assertInspectionDeadline(deadline);
    return validate;
  } catch (error) {
    if (error instanceof ReportingInspectionError) throw error;
    throw inspectionError('ROW_SCHEMA_INVALID', 'Pinned row schema could not be compiled', false, error);
  }
}

function validateLocalSchema(schema: Record<string, unknown>): void {
  if (schema.$schema !== REPORTING_SCHEMA_DIALECT) {
    throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema must declare the pinned Draft 2020-12 dialect');
  }
  let nodes = 0;
  const refs = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > 10_000) throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema exceeds safety bounds');
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if ('$dynamicRef' in value || '$dynamicAnchor' in value || '$recursiveRef' in value || '$vocabulary' in value) {
      throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema uses an unsupported reference or vocabulary keyword');
    }
    if (typeof value.pattern === 'string' && value.pattern.length > 1024) {
      throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema regex exceeds the safety bound');
    }
    if ('$ref' in value) {
      if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#')) {
        throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema references must be local fragments');
      }
      refs.add(value.$ref);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(schema, 0);
  if (findUnsafeRegexPattern(schema))
    throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema contains an unsafe regex');
  rejectReferenceCycles(schema, refs);
}

function rejectReferenceCycles(schema: Record<string, unknown>, refs: ReadonlySet<string>): void {
  const anchors = collectAnchors(schema);
  const edges = new Map<string, Set<string>>();
  for (const ref of refs) {
    const target =
      ref === '#'
        ? schema
        : ref.startsWith('#/')
          ? resolveJsonPointer(schema, ref.slice(1))
          : anchors.get(ref.slice(1));
    if (target === undefined) throw inspectionError('ROW_SCHEMA_INVALID', `Row schema reference ${ref} is unresolved`);
    const childRefs = new Set<string>();
    collectRefs(target, childRefs);
    edges.set(ref, childRefs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ref: string): void => {
    if (visiting.has(ref)) throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema contains a reference cycle');
    if (visited.has(ref)) return;
    visiting.add(ref);
    for (const child of edges.get(ref) ?? []) if (edges.has(child)) visit(child);
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const ref of refs) visit(ref);
}

function collectAnchors(schema: Record<string, unknown>): Map<string, unknown> {
  const anchors = new Map<string, unknown>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(walk);
    if (!isRecord(value)) return;
    if ('$anchor' in value) {
      if (typeof value.$anchor !== 'string' || !/^[A-Za-z_][-._A-Za-z0-9]*$/.test(value.$anchor)) {
        throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema contains an invalid local anchor');
      }
      if (anchors.has(value.$anchor))
        throw inspectionError('ROW_SCHEMA_INVALID', 'Row schema contains duplicate anchors');
      anchors.set(value.$anchor, value);
    }
    Object.values(value).forEach(walk);
  };
  walk(schema);
  return anchors;
}

function collectRefs(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) return void value.forEach(child => collectRefs(child, output));
  if (!isRecord(value)) return;
  if (typeof value.$ref === 'string') output.add(value.$ref);
  for (const child of Object.values(value)) collectRefs(child, output);
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let cursor: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= cursor.length) return undefined;
      cursor = cursor[Number(key)];
      continue;
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !isRecord(cursor) || !(key in cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

async function validateReportDefinition(
  context: ReportingInspectionContext,
  resolver: CanonicalReferenceResolver,
  allowedOrigins: readonly string[],
  deadline: number
): Promise<Record<string, any>> {
  assertAllowedReferenceOrigin(
    context.revision.report_definition_uri!,
    allowedOrigins,
    'REPORT_DEFINITION_FETCH_FAILED'
  );
  const result = await withinInspectionDeadline(
    resolver.resolve({
      uri: context.revision.report_definition_uri!,
      digest: `sha256:${context.revision.report_definition_sha256!.toLowerCase()}`,
    }),
    deadline
  );
  if (!result.ok) {
    throw new ReportingInspectionError('REPORT_DEFINITION_FETCH_FAILED', result.error.message, result.error.retryable, {
      referenceCode: result.error.code,
    });
  }
  requireContentType(
    result.contentType,
    ['application/vnd.adcp.reporting-definition+json'],
    'REPORT_DEFINITION_INVALID'
  );
  const definition = parsePinnedJson(result.body, 'REPORT_DEFINITION_INVALID');
  if (!isValidReportDefinition(definition)) {
    throw inspectionError(
      'REPORT_DEFINITION_INVALID',
      'Pinned report definition does not satisfy its bundled contract'
    );
  }
  if (
    definition.report_definition_id !== context.revision.report_definition_id ||
    definition.reporting_profile !== context.revision.reporting_profile
  ) {
    throw inspectionError('REPORT_DEFINITION_INVALID', 'Pinned report definition does not match the revision');
  }
  if (context.revision.finality === 'official') {
    const policy = definition.finality_policies.find(
      (item: unknown) => isRecord(item) && item.finality_policy_id === context.revision.finality_policy_id
    );
    if (!isRecord(policy) || policy.basis !== context.revision.finality_basis) {
      throw inspectionError(
        'REPORT_DEFINITION_INVALID',
        'Revision finality is not bound by the pinned report definition'
      );
    }
  }
  return definition;
}

async function recomputeCanonicalDigest(
  rows: readonly Record<string, unknown>[],
  context: ReportingInspectionContext,
  resolver: CanonicalReferenceResolver,
  allowedOrigins: readonly string[],
  deadline: number
): Promise<ReportingCanonicalDigestEvidence> {
  const expected = context.revision.canonical_content_digest!;
  assertAllowedReferenceOrigin(expected.canonicalization_uri, allowedOrigins, 'CANONICALIZATION_FETCH_FAILED');
  const result = await withinInspectionDeadline(
    resolver.resolve({
      uri: expected.canonicalization_uri,
      digest: `sha256:${expected.canonicalization_sha256.toLowerCase()}`,
    }),
    deadline
  );
  if (!result.ok) {
    throw new ReportingInspectionError('CANONICALIZATION_FETCH_FAILED', result.error.message, result.error.retryable, {
      referenceCode: result.error.code,
    });
  }
  requireContentType(
    result.contentType,
    ['application/vnd.adcp.reporting-canonicalization+json'],
    'CANONICALIZATION_INVALID'
  );
  const contract = parseCanonicalizationContract(
    parsePinnedJson(result.body, 'CANONICALIZATION_INVALID'),
    context.revision.schema_sha256
  );
  if (
    context.expected.verificationProfile !== 'canonical_digest' ||
    !sameStringArray(contract.primary_keys, context.expected.canonicalization.primaryKeys)
  ) {
    throw inspectionError(
      'CANONICALIZATION_INVALID',
      'Canonicalization primary keys do not match consumer expectations'
    );
  }
  for (const vector of contract.golden_vectors) {
    assertInspectionDeadline(deadline);
    const body = canonicalRows(vector.input_rows, contract.primary_keys, deadline);
    if (
      Buffer.from(body).toString('base64') !== vector.canonical_utf8_base64 ||
      !constantTimeHexEqual(sha256(body), vector.sha256)
    ) {
      throw inspectionError('CANONICALIZATION_INVALID', `Canonicalization golden vector ${vector.name} failed`);
    }
  }
  return { ...expected, value: sha256(canonicalRows(rows, contract.primary_keys, deadline)) };
}

function parseCanonicalizationContract(document: unknown, schemaSha256: string): ReportingCanonicalizationContract {
  const allowed = ['contract_version', 'media_type', 'algorithm', 'schema_sha256', 'primary_keys', 'golden_vectors'];
  if (
    !isRecord(document) ||
    !hasOnlyKeys(document, allowed) ||
    document.contract_version !== '1.0' ||
    document.media_type !== 'application/vnd.adcp.reporting-canonicalization+json' ||
    document.algorithm !== 'adcp_jcs_rows_v1' ||
    typeof document.schema_sha256 !== 'string' ||
    !constantTimeHexEqual(document.schema_sha256, schemaSha256) ||
    !Array.isArray(document.primary_keys) ||
    document.primary_keys.length === 0 ||
    !document.primary_keys.every(item => typeof item === 'string' && item.length > 0 && item.length <= 128) ||
    new Set(document.primary_keys).size !== document.primary_keys.length ||
    !Array.isArray(document.golden_vectors) ||
    document.golden_vectors.length < 2
  ) {
    throw inspectionError(
      'CANONICALIZATION_INVALID',
      'Pinned canonicalization contract is invalid or not bound to the row schema'
    );
  }
  for (const vector of document.golden_vectors) {
    if (
      !isRecord(vector) ||
      !hasOnlyKeys(vector, ['name', 'input_rows', 'canonical_utf8_base64', 'sha256']) ||
      typeof vector.name !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(vector.name) ||
      !Array.isArray(vector.input_rows) ||
      !vector.input_rows.every(isRecord) ||
      typeof vector.canonical_utf8_base64 !== 'string' ||
      !isCanonicalBase64(vector.canonical_utf8_base64) ||
      typeof vector.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(vector.sha256)
    ) {
      throw inspectionError('CANONICALIZATION_INVALID', 'Canonicalization contract contains an invalid golden vector');
    }
    assertBoundedJsonData(vector.input_rows, 'CANONICALIZATION_INVALID');
  }
  if (
    !document.golden_vectors.some(vector => vector.input_rows.length === 0) ||
    !document.golden_vectors.some(vector => vector.input_rows.length >= 2)
  ) {
    throw inspectionError(
      'CANONICALIZATION_INVALID',
      'Canonicalization vectors must include empty-report and ordering/encoding cases'
    );
  }
  return document as unknown as ReportingCanonicalizationContract;
}

function canonicalRows(
  rows: readonly Record<string, unknown>[],
  primaryKeys: readonly string[],
  deadline?: number
): Uint8Array {
  const encoded = rows.map((row, index) => {
    if (deadline !== undefined && index % 256 === 0) assertInspectionDeadline(deadline);
    assertIJson(row);
    const keyValues = primaryKeys.map(key => {
      const value = row[key];
      if (
        value === undefined ||
        value === null ||
        (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      ) {
        throw inspectionError('CANONICALIZATION_INVALID', `Row primary key ${key} must be a present scalar`);
      }
      return value;
    });
    return { key: Buffer.from(canonicalize(keyValues)), row: canonicalize(row) };
  });
  encoded.sort((left, right) => Buffer.compare(left.key, right.key));
  for (let index = 1; index < encoded.length; index += 1) {
    if (Buffer.compare(encoded[index - 1]!.key, encoded[index]!.key) === 0) {
      throw inspectionError('CANONICALIZATION_INVALID', 'Reporting rows contain duplicate primary-key tuples');
    }
  }
  return Buffer.from(`[${encoded.map(item => item.row).join(',')}]`, 'utf8');
}

function parsePinnedJson(body: Uint8Array, code: ReportingInspectionErrorCode): unknown {
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (error) {
    throw inspectionError(code, 'Pinned document is not strict UTF-8 JSON', false, error);
  }
}

function parseManifest(body: Uint8Array): ReportingFileManifest {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (error) {
    throw inspectionError('MANIFEST_INVALID', 'Manifest is not strict UTF-8 JSON', false, error);
  }
  if (!isRecord(parsed)) throw inspectionError('MANIFEST_INVALID', 'Manifest must be a JSON object');
  const allowed = new Set([
    'manifest_version',
    'complete',
    'reporting_revision_id',
    'reporting_obligation_id',
    'reporting_materialization_id',
    'period',
    'format',
    'compression',
    'files',
    'total_size_bytes',
    'row_count',
    'control_totals',
    'created_at',
  ]);
  if (Object.keys(parsed).some(key => !allowed.has(key)))
    throw inspectionError('MANIFEST_INVALID', 'Manifest has unknown fields');
  if (parsed.manifest_version !== '1.0' || parsed.complete !== true) {
    throw inspectionError('MANIFEST_INCOMPLETE', 'Manifest must be a complete v1 manifest-last commit');
  }
  if (
    typeof parsed.reporting_revision_id !== 'string' ||
    !ENTITY_ID_PATTERN.test(parsed.reporting_revision_id) ||
    typeof parsed.reporting_obligation_id !== 'string' ||
    !ENTITY_ID_PATTERN.test(parsed.reporting_obligation_id) ||
    typeof parsed.reporting_materialization_id !== 'string' ||
    !ENTITY_ID_PATTERN.test(parsed.reporting_materialization_id) ||
    !isPeriod(parsed.period) ||
    !['jsonl', 'csv', 'parquet', 'avro', 'orc'].includes(String(parsed.format)) ||
    !['none', 'gzip', 'zstd', 'snappy'].includes(String(parsed.compression)) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 ||
    !parsed.files.every(isFileEntry) ||
    !isNonNegativeInteger(parsed.total_size_bytes) ||
    !isNonNegativeInteger(parsed.row_count) ||
    !Array.isArray(parsed.control_totals) ||
    !parsed.control_totals.every(isControlTotal) ||
    new Set(parsed.control_totals.map(total => total.name)).size !== parsed.control_totals.length ||
    typeof parsed.created_at !== 'string' ||
    !isRfc3339(parsed.created_at)
  ) {
    throw inspectionError('MANIFEST_INVALID', 'Manifest does not satisfy the reporting file manifest contract');
  }
  return parsed as unknown as ReportingFileManifest;
}

function validateManifestBinding(manifest: ReportingFileManifest, context: ReportingInspectionContext): void {
  if (
    manifest.reporting_revision_id !== context.revision.reporting_revision_id ||
    manifest.reporting_obligation_id !== context.obligation.reporting_obligation_id ||
    manifest.reporting_materialization_id !== context.materialization.reporting_materialization_id ||
    canonicalize(manifest.period) !== canonicalize(context.revision.period)
  ) {
    throw inspectionError(
      'MANIFEST_IDENTITY_MISMATCH',
      'Manifest identity or period does not match the reporting ledger'
    );
  }
  const size = manifest.files.reduce((sum, file) => sum + file.size_bytes, 0);
  const rows = manifest.files.reduce((sum, file) => sum + file.row_count, 0);
  if (size !== manifest.total_size_bytes || rows !== manifest.row_count) {
    throw inspectionError('MANIFEST_TOTAL_MISMATCH', 'Manifest file totals do not match its declared totals');
  }
}

function decodeJsonLines(body: Uint8Array, context: ReportingDecodedFileContext): Record<string, unknown>[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw inspectionError('MANIFEST_INVALID', 'JSONL object is not valid UTF-8', false, error);
  }
  const rows: Record<string, unknown>[] = [];
  let start = 0;
  const append = (line: string): void => {
    const index = rows.length;
    if (index >= context.maxRows) {
      throw inspectionError('RESOURCE_TOO_LARGE', 'JSONL object exceeds the configured row budget');
    }
    if (!line.trim()) throw inspectionError('MANIFEST_INVALID', `JSONL row ${index} is empty`);
    try {
      const value = parseStrictJson(line);
      if (!isRecord(value)) throw new Error('row is not an object');
      rows.push(value);
    } catch (error) {
      throw inspectionError('MANIFEST_INVALID', `JSONL row ${index} is invalid`, false, error);
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    const end = index > start && text[index - 1] === '\r' ? index - 1 : index;
    append(text.slice(start, end));
    start = index + 1;
  }
  if (start < text.length) append(text.slice(start));
  return rows;
}

function decodeCsv(body: Uint8Array, context: ReportingDecodedFileContext): Record<string, unknown>[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw inspectionError('MANIFEST_INVALID', 'CSV object is not valid UTF-8', false, error);
  }
  const records = parseCsvRecords(text, context.maxRows + 1);
  if (records.length === 0) throw inspectionError('MANIFEST_INVALID', 'CSV object has no header row');
  const headers = records[0]!;
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw inspectionError('MANIFEST_INVALID', 'CSV header names must be non-empty and unique');
  }
  return records.slice(1).map((record, index) => {
    if (record.length !== headers.length)
      throw inspectionError('MANIFEST_INVALID', `CSV row ${index} has the wrong column count`);
    return Object.fromEntries(headers.map((header, column) => [header, record[column]!])) as Record<string, unknown>;
  });
}

function parseCsvRecords(text: string, maxRecords: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      if (rows.length > maxRecords) {
        throw inspectionError('RESOURCE_TOO_LARGE', 'CSV object exceeds the configured row budget');
      }
      row = [];
      field = '';
    } else if (char === '\r' && text[index + 1] === '\n') continue;
    else field += char;
  }
  if (quoted) throw inspectionError('MANIFEST_INVALID', 'CSV has an unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
    if (rows.length > maxRecords) {
      throw inspectionError('RESOURCE_TOO_LARGE', 'CSV object exceeds the configured row budget');
    }
  }
  return rows;
}

function calculateNamedControlTotals(
  rows: readonly Record<string, unknown>[],
  expected: readonly ReportingControlTotal[],
  reportDefinition: Record<string, any>,
  deadline: number
): ReportingControlTotal[] {
  return expected.map(total => {
    const metric = reportDefinition.metrics.find(
      (candidate: unknown) => isRecord(candidate) && candidate.name === total.name
    );
    if (!isRecord(metric) || metric.aggregation !== 'sum' || typeof metric.source_expression !== 'string') {
      throw inspectionError(
        'CONTROL_TOTAL_UNSUPPORTED',
        `Control total ${total.name} needs a custom calculator for its declared aggregation`
      );
    }
    let sum: Decimal = { coefficient: 0n, scale: 0 };
    for (let index = 0; index < rows.length; index += 1) {
      if (index % 256 === 0) assertInspectionDeadline(deadline);
      const row = rows[index]!;
      const raw = getNamedValue(row, metric.source_expression);
      if (raw === undefined || (typeof raw !== 'string' && typeof raw !== 'number')) {
        throw inspectionError(
          'CONTROL_TOTAL_UNSUPPORTED',
          `Control total ${total.name} needs a custom calculator because it is not a numeric row field`
        );
      }
      sum = addDecimal(sum, parseDecimal(raw));
    }
    const minimumScale = total.value_type === 'decimal' ? (total.value.split('.')[1]?.length ?? 0) : 0;
    return { ...total, value: formatDecimal(sum, minimumScale) };
  });
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function assertInspectionDeadline(deadline: number): void {
  if (Date.now() >= deadline) {
    throw inspectionError('INSPECTION_TIMEOUT', 'Reporting inspection exceeded its time budget', true);
  }
}

function deadlineSignal(deadline: number): AbortSignal {
  assertInspectionDeadline(deadline);
  return AbortSignal.timeout(Math.max(1, deadline - Date.now()));
}

async function withinInspectionDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  assertInspectionDeadline(deadline);
  const remaining = deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(inspectionError('INSPECTION_TIMEOUT', 'Reporting inspection exceeded its time budget', true)),
          remaining
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

function parseDecimal(value: string | number): Decimal {
  const text = String(value);
  if (text.length > 1024) {
    throw inspectionError('CONTROL_TOTAL_UNSUPPORTED', 'Control-total decimal exceeds the precision bound');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw inspectionError('CONTROL_TOTAL_UNSUPPORTED', `Non-decimal control value ${text}`);
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024 || match[2]!.length + fraction.length > 1024) {
    throw inspectionError('CONTROL_TOTAL_UNSUPPORTED', 'Control-total decimal exceeds the exponent or precision bound');
  }
  let scale = fraction.length - exponent;
  if (Math.abs(scale) > 1024) {
    throw inspectionError('CONTROL_TOTAL_UNSUPPORTED', 'Control-total decimal exceeds the scale bound');
  }
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizeDecimal({ coefficient, scale });
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function normalizeDecimal(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function formatDecimal(value: Decimal, minimumScale: number): string {
  const normalized = normalizeDecimal(value);
  const scale = Math.max(normalized.scale, minimumScale);
  const negative = normalized.coefficient < 0n;
  const magnitude =
    (negative ? -normalized.coefficient : normalized.coefficient) * 10n ** BigInt(scale - normalized.scale);
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const unsigned = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${unsigned}` : unsigned;
}

function getNamedValue(row: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  return name.split('.').reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), row);
}

function sameControlTotals(left: readonly ReportingControlTotal[], right: readonly ReportingControlTotal[]): boolean {
  const normalize = (totals: readonly ReportingControlTotal[]) =>
    [...totals].sort((a, b) => a.name.localeCompare(b.name)).map(total => canonicalize(total));
  return canonicalize(normalize(left)) === canonicalize(normalize(right));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertIJson(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff)
          throw inspectionError('CANONICALIZATION_INVALID', 'Lone Unicode surrogate is not I-JSON');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw inspectionError('CANONICALIZATION_INVALID', 'Lone Unicode surrogate is not I-JSON');
      }
    }
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw inspectionError('CANONICALIZATION_INVALID', 'Non-finite number is not I-JSON');
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw inspectionError('CANONICALIZATION_INVALID', 'Cyclic row is not JSON');
  seen.add(value);
  if (Array.isArray(value)) value.forEach(child => assertIJson(child, seen));
  else
    for (const [key, child] of Object.entries(value)) {
      assertIJson(key);
      assertIJson(child, seen);
    }
  seen.delete(value);
}

function isValidReportDefinition(value: unknown): value is Record<string, any> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'contract_version',
      'media_type',
      'report_definition_id',
      'reporting_profile',
      'grain',
      'source',
      'calendar',
      'metrics',
      'dimensions',
      'restatement_policy',
      'finality_policies',
    ]) ||
    value.contract_version !== '1.0' ||
    value.media_type !== 'application/vnd.adcp.reporting-definition+json' ||
    typeof value.report_definition_id !== 'string' ||
    !ENTITY_ID_PATTERN.test(value.report_definition_id) ||
    typeof value.reporting_profile !== 'string' ||
    value.reporting_profile.length === 0 ||
    value.reporting_profile.length > 128 ||
    typeof value.grain !== 'string' ||
    value.grain.length === 0 ||
    value.grain.length > 128
  ) {
    return false;
  }
  assertBoundedJsonData(value, 'REPORT_DEFINITION_INVALID');
  if (containsReferenceKeyword(value)) return false;

  const source = value.source;
  if (
    !isRecord(source) ||
    !hasOnlyKeys(source, ['provider', 'system', 'api_version', 'query_semantics']) ||
    !isRecord(source.provider) ||
    !hasOnlyKeys(source.provider, ['domain']) ||
    typeof source.provider.domain !== 'string' ||
    !DOMAIN_PATTERN.test(source.provider.domain) ||
    typeof source.system !== 'string' ||
    source.system.length === 0 ||
    source.system.length > 128 ||
    typeof source.api_version !== 'string' ||
    source.api_version.length === 0 ||
    source.api_version.length > 128 ||
    !isRecord(source.query_semantics)
  ) {
    return false;
  }

  const calendar = value.calendar;
  if (
    !isRecord(calendar) ||
    !hasOnlyKeys(calendar, ['timezone_basis', 'timezone']) ||
    !['utc', 'account_timezone', 'configured_timezone'].includes(String(calendar.timezone_basis)) ||
    (calendar.timezone_basis === 'configured_timezone'
      ? typeof calendar.timezone !== 'string' || calendar.timezone.length === 0 || calendar.timezone.length > 255
      : calendar.timezone !== undefined)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.metrics) ||
    value.metrics.length === 0 ||
    !value.metrics.every(
      metric =>
        isRecord(metric) &&
        hasOnlyKeys(metric, ['name', 'source_expression', 'aggregation', 'unit']) &&
        typeof metric.name === 'string' &&
        metric.name.length > 0 &&
        metric.name.length <= 128 &&
        typeof metric.source_expression === 'string' &&
        metric.source_expression.length > 0 &&
        metric.source_expression.length <= 2048 &&
        ['sum', 'count', 'min', 'max', 'average', 'ratio', 'last', 'custom'].includes(String(metric.aggregation)) &&
        (metric.unit === undefined ||
          (typeof metric.unit === 'string' && metric.unit.length > 0 && metric.unit.length <= 64))
    ) ||
    !Array.isArray(value.dimensions) ||
    !value.dimensions.every(
      dimension => typeof dimension === 'string' && dimension.length > 0 && dimension.length <= 128
    ) ||
    new Set(value.dimensions).size !== value.dimensions.length
  ) {
    return false;
  }

  const restatement = value.restatement_policy;
  if (
    !isRecord(restatement) ||
    !hasOnlyKeys(restatement, ['source_requery_duration', 'emit_only_on_content_change']) ||
    typeof restatement.source_requery_duration !== 'string' ||
    !ISO_DURATION_PATTERN.test(restatement.source_requery_duration) ||
    restatement.emit_only_on_content_change !== true
  ) {
    return false;
  }

  if (
    !Array.isArray(value.finality_policies) ||
    value.finality_policies.length === 0 ||
    !value.finality_policies.every(isValidFinalityPolicy)
  ) {
    return false;
  }
  const policyIds = value.finality_policies.map(policy => policy.finality_policy_id);
  return new Set(policyIds).size === policyIds.length;
}

function isValidFinalityPolicy(value: unknown): value is Record<string, any> {
  if (
    !isRecord(value) ||
    typeof value.finality_policy_id !== 'string' ||
    !ENTITY_ID_PATTERN.test(value.finality_policy_id)
  ) {
    return false;
  }
  if (value.basis === 'source_final') {
    return (
      hasOnlyKeys(value, ['finality_policy_id', 'basis', 'source_signal']) &&
      typeof value.source_signal === 'string' &&
      value.source_signal.length > 0 &&
      value.source_signal.length <= 512
    );
  }
  if (value.basis === 'contractual_cutoff') {
    return (
      hasOnlyKeys(value, ['finality_policy_id', 'basis', 'duration_after_period_end']) &&
      typeof value.duration_after_period_end === 'string' &&
      ISO_DURATION_PATTERN.test(value.duration_after_period_end)
    );
  }
  if (value.basis === 'stabilized') {
    return (
      hasOnlyKeys(value, ['finality_policy_id', 'basis', 'minimum_age', 'unchanged_for']) &&
      typeof value.minimum_age === 'string' &&
      ISO_DURATION_PATTERN.test(value.minimum_age) &&
      typeof value.unchanged_for === 'string' &&
      ISO_DURATION_PATTERN.test(value.unchanged_for)
    );
  }
  return false;
}

function assertBoundedJsonData(value: unknown, code: ReportingInspectionErrorCode): void {
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > 10_000) throw inspectionError(code, 'Pinned document exceeds safety bounds');
    if (typeof item === 'string' && item.length > 1_000_000) {
      throw inspectionError(code, 'Pinned document contains an oversized string');
    }
    if (Array.isArray(item)) item.forEach(child => walk(child, depth + 1));
    else if (isRecord(item))
      Object.entries(item).forEach(([key, child]) => {
        walk(key, depth + 1);
        walk(child, depth + 1);
      });
  };
  walk(value, 0);
}

function containsReferenceKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReferenceKeyword);
  if (!isRecord(value)) return false;
  if ('$ref' in value || '$dynamicRef' in value || '$recursiveRef' in value) return true;
  return Object.values(value).some(containsReferenceKeyword);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isCanonicalBase64(value: string): boolean {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isPeriod(value: unknown): value is ReportingFileManifest['period'] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['start', 'end', 'source_timezone']) &&
    typeof value.start === 'string' &&
    typeof value.end === 'string' &&
    typeof value.source_timezone === 'string' &&
    value.source_timezone.length > 0 &&
    isRfc3339(value.start) &&
    isRfc3339(value.end)
  );
}

function isFileEntry(value: unknown): value is ReportingFileEntry {
  return (
    isRecord(value) &&
    Object.keys(value).every(key => ['object_ref', 'size_bytes', 'sha256', 'row_count', 'partition'].includes(key)) &&
    typeof value.object_ref === 'string' &&
    value.object_ref.length > 0 &&
    value.object_ref.length <= 1024 &&
    isNonNegativeInteger(value.size_bytes) &&
    typeof value.sha256 === 'string' &&
    /^[a-fA-F0-9]{64}$/.test(value.sha256) &&
    isNonNegativeInteger(value.row_count) &&
    (value.partition === undefined ||
      (isStringRecord(value.partition) &&
        Object.keys(value.partition).length <= 32 &&
        Object.values(value.partition).every(item => item.length <= 512)))
  );
}

function isControlTotal(value: unknown): value is ReportingControlTotal {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'value', 'value_type', 'unit']) &&
    typeof value.name === 'string' &&
    CONTROL_TOTAL_NAME_PATTERN.test(value.name) &&
    typeof value.value === 'string' &&
    CANONICAL_DECIMAL_PATTERN.test(value.value) &&
    (value.value_type === 'integer' || value.value_type === 'decimal') &&
    (value.unit === undefined || (typeof value.unit === 'string' && value.unit.length > 0 && value.unit.length <= 32))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(child => typeof child === 'string');
}

function isRecord(value: unknown): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRfc3339(value: string): boolean {
  return RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function sha256(body: Uint8Array): string {
  return digestHex(body, 'sha256');
}

function digestHex(body: Uint8Array, algorithm: 'sha256' | 'sha512'): string {
  return createHash(algorithm).update(body).digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (
    left.length !== right.length ||
    !/^(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(left) ||
    !/^(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(right)
  )
    return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requireContentType(
  raw: string | undefined,
  allowed: readonly string[],
  code: ReportingInspectionErrorCode
): void {
  const mediaType = raw?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mediaType || !allowed.includes(mediaType)) {
    throw inspectionError(code, `Pinned document returned unsupported content type ${mediaType ?? '<missing>'}`);
  }
}

function assertAllowedReferenceOrigin(
  raw: string,
  allowedOrigins: readonly string[],
  code: ReportingInspectionErrorCode
): void {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw inspectionError(code, 'Pinned document URI is invalid');
  }
  if (target.protocol !== 'https:' || target.username || target.password || !allowedOrigins.includes(target.origin)) {
    throw inspectionError(code, 'Pinned document URI is not on a consumer-approved origin');
  }
}

function sanitizeAjvErrors(errors: ErrorObject[] | null | undefined): Array<Record<string, unknown>> {
  return (errors ?? []).slice(0, 20).map(error => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
  }));
}

function inspectionError(
  code: ReportingInspectionErrorCode,
  message: string,
  retryable = false,
  cause?: unknown
): ReportingInspectionError {
  return new ReportingInspectionError(code, message, retryable, undefined, cause === undefined ? undefined : { cause });
}

function inspectionMismatch(
  code: 'ROW_COUNT_MISMATCH' | 'CONTROL_TOTAL_MISMATCH' | 'CANONICAL_DIGEST_MISMATCH',
  message: string,
  observation: ReportingObservation
): ReportingInspectionError {
  return new ReportingInspectionError(code, message, false, undefined, undefined, observation);
}
