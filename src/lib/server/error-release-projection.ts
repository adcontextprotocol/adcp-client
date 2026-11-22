/**
 * Project the AdCP errors in a framework-built payload from the server's
 * release down to the served release (DR-0024: a response conforms to the
 * release it serves).
 *
 * An error is not part of a tool's own payload schema: the tool-schema
 * projection leaves the envelope's `adcp_error` alone, and a tool without a
 * typed Error arm declares no `errors[]`. Both are therefore converted against
 * `core/error.json` instead, one release step at a time, with the same schema
 * diff as every other response: a field the newer release declares and the
 * older one does not (`mutation_outcome` below 3.3, `buyer_reason` below 3.2)
 * is removed and reported as `version_downgrade_fields_dropped` drift.
 */
import { convertErrorToRelease } from '../adapters/version/translate';
import type { VersionDrift } from '../adapters/version';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert `adcp_error` and every `errors[]` item of `body`. Returns the
 * original reference and no drift when nothing changes. The input is never
 * mutated.
 */
export function projectErrorsForRelease<T>(
  body: T,
  options: { toolName: string; fromVersion: string; toVersion: string }
): { data: T; drifts: VersionDrift[] } {
  if (!isPlainObject(body)) return { data: body, drifts: [] };
  const drifts: VersionDrift[] = [];
  const convert = (error: unknown): unknown => {
    if (!isPlainObject(error)) return error;
    const converted = convertErrorToRelease(options.toolName, error, options);
    drifts.push(...converted.drifts);
    return converted.data;
  };
  let next: Record<string, unknown> | undefined;
  const envelope = body.adcp_error;
  const convertedEnvelope = convert(envelope);
  if (convertedEnvelope !== envelope) next = { ...body, adcp_error: convertedEnvelope };
  const errors = body.errors;
  if (Array.isArray(errors)) {
    const convertedErrors = errors.map(convert);
    if (convertedErrors.some((error, index) => error !== errors[index])) {
      next = { ...(next ?? body), errors: convertedErrors };
    }
  }
  return { data: (next ?? body) as T, drifts };
}
