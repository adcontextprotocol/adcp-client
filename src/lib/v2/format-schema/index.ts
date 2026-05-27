/**
 * Canonical reference resolver for AdCP 3.1 `format_schema` and
 * `platform_extensions` URI+digest references.
 *
 * Use the high-level resolver after `projectV1ProductToV2` or directly
 * on V2 declarations. It returns structured statuses instead of
 * throwing, keeps a caller-scoped immutable cache, resolves and compiles
 * custom format schemas, and uses the same hardened transport for
 * platform-extension definitions.
 *
 * ```ts
 * import { createCanonicalReferenceResolver } from '@adcp/sdk/v2/format-schema';
 *
 * const resolver = createCanonicalReferenceResolver();
 * const result = await resolver.resolveFormatSchema(decl.format_schema);
 * if (result.ok) {
 *   // Use `result.document` to validate the placement manifest.
 * }
 * ```
 *
 * Implements the spec's normative fetch contract (HTTPS-only, SSRF
 * guards, no redirects, 1 MiB body cap, 5 s timeout, SHA-256 digest
 * verification, immutable `uri@digest` cache).
 */

export {
  fetchFormatSchema,
  FormatSchemaFetchError,
  _resetFormatSchemaCache,
  type FormatSchemaRef,
  type FormatSchemaFetchResult,
  type FormatSchemaFetchErrorCode,
  type FetchFormatSchemaOptions,
  type FormatSchemaCache,
} from './fetch';

export {
  resolveSchemaRefs,
  SchemaRefSandboxError,
  DEFAULT_MAX_REF_DEPTH,
  DEFAULT_MAX_REF_COUNT,
  DEFAULT_MIRROR_HOST,
  DEFAULT_MIRROR_HOSTS,
  DEFAULT_MAX_KEYWORDS,
  DEFAULT_VALIDATION_BUDGET_MS,
  type SchemaRefSandboxErrorCode,
  type ResolveSchemaRefsOptions,
  type ResolveSchemaRefsResult,
} from './sandbox-refs';

export {
  createCanonicalRefResolver,
  createCanonicalReferenceResolver,
  createMemoryCanonicalReferenceCache,
  resolveFormatSchema,
  resolvePlatformExtension,
  type CanonicalReferenceCache,
  type CanonicalRef,
  type CanonicalReferenceFailureResult,
  type CanonicalReferenceKind,
  type CanonicalReferenceResolvedResult,
  type CanonicalReferenceResolutionCode,
  type CanonicalReferenceResolutionResult,
  type CanonicalReferenceResolutionStatus,
  type CanonicalReferenceResolver,
  type CanonicalReferenceResolverOptions,
  type ResolveCanonicalReferenceOptions,
} from './resolver';
