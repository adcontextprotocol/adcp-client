/**
 * Format-schema fetcher for AdCP 3.1's
 * `ProductFormatDeclaration.format_schema` references — the URI+digest
 * pointer to an out-of-tree JSON Schema document describing a custom
 * format's `params` and `slots` shape.
 *
 * Use after `projectV1ProductToV2` or directly on V2 declarations whose
 * `format_kind: "custom"` carries a `format_schema` reference:
 *
 * ```ts
 * import { fetchFormatSchema } from '@adcp/sdk/v2/format-schema';
 *
 * const { format_schema } = decl;
 * if (format_schema) {
 *   const { schema, fromCache } = await fetchFormatSchema(format_schema);
 *   // Use `schema` to validate the placement manifest at runtime.
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
