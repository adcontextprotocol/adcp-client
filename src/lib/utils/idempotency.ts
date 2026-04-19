/**
 * Idempotency key ergonomics for AdCP mutating requests.
 *
 * AdCP v3 requires an `idempotency_key` on every mutating request. This
 * module handles two things the SDK owns:
 *
 * 1. Knowing which tools are mutating (so we auto-generate for them and not
 *    for read-only tools).
 * 2. Generating UUID v4 keys that satisfy the spec's
 *    `^[A-Za-z0-9_.:-]{16,255}$` pattern.
 */

import { randomUUID } from 'crypto';
import { TOOL_REQUEST_SCHEMAS } from './tool-request-schemas';

/**
 * Tools whose request schema requires `idempotency_key`.
 *
 * Derived from the Zod schemas at module load so this stays in sync with
 * the upstream AdCP schema — no hand-maintained list to drift.
 *
 * `si_terminate_session` is intentionally excluded even though it's a
 * mutating operation: the spec documents it as naturally idempotent via
 * `session_id` (terminate twice = no-op).
 */
export const MUTATING_TASKS: ReadonlySet<string> = deriveMutatingTasks();

function deriveMutatingTasks(): Set<string> {
  const result = new Set<string>();
  for (const [toolName, schema] of Object.entries(TOOL_REQUEST_SCHEMAS)) {
    if (!schema) continue;
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (!shape) continue;
    const field = shape.idempotency_key;
    if (!field) continue;
    if (isRequiredZodField(field)) {
      result.add(toolName);
    }
  }
  return result;
}

function isRequiredZodField(field: unknown): boolean {
  const def = (field as { _def?: { typeName?: string } })?._def;
  if (!def) return false;
  // Zod wraps optional fields in ZodOptional or ZodDefault. Required = neither.
  return def.typeName !== 'ZodOptional' && def.typeName !== 'ZodDefault';
}

/**
 * Whether a tool's request schema requires `idempotency_key`.
 *
 * Callers use this to decide whether to auto-generate a key when one isn't
 * provided. Unknown tool names return `false` — we don't guess.
 */
export function isMutatingTask(toolName: string): boolean {
  return MUTATING_TASKS.has(toolName);
}

/**
 * Generate a fresh idempotency key for a mutating request.
 *
 * Returns a UUID v4, which satisfies the spec's
 * `^[A-Za-z0-9_.:-]{16,255}$` pattern and provides ≥122 bits of entropy
 * (the spec minimum to prevent cache enumeration).
 */
export function generateIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Pattern the spec requires `idempotency_key` to match. Exported so callers
 * doing BYOK can validate their keys before sending.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

/**
 * Validate that a key matches the spec pattern. Useful for callers that
 * persist keys (e.g., bring-your-own-key from a database) and want to
 * catch drift early.
 */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Utility type: take a generated request interface that requires
 * `idempotency_key` and make that field optional for callers.
 *
 * The SDK auto-generates a UUID v4 when callers don't provide one, so
 * public client signatures use this loosened input type. Callers who
 * want byte-identical retries across process restarts still pass their
 * own key — it's just no longer required at compile time.
 */
export type MutatingRequestInput<T extends { idempotency_key: string }> = Omit<T, 'idempotency_key'> & {
  idempotency_key?: string;
};

/**
 * Validate a bring-your-own-key `idempotency_key` up front and return a
 * `{ idempotency_key }` fragment to spread into a mutating request.
 *
 * Useful when the caller persists keys across process restarts (e.g., key
 * stored in a DB alongside a campaign row) and wants to catch drift before
 * the round-trip — the server would reject a malformed key with
 * `INVALID_REQUEST`, but failing locally produces a faster, cleaner error.
 *
 * Throws when the key doesn't match `IDEMPOTENCY_KEY_PATTERN`
 * (`^[A-Za-z0-9_.:-]{16,255}$`).
 *
 * @example
 * ```ts
 * const key = await db.getOrCreateIdempotencyKey(campaign.id);
 * const result = await client.createMediaBuy({ ...params, ...useIdempotencyKey(key) });
 * ```
 */
export function useIdempotencyKey(key: string): { idempotency_key: string } {
  if (typeof key !== 'string' || !isValidIdempotencyKey(key)) {
    // Preview only 8 chars so near-valid keys (16+ chars, minor drift) don't
    // flow verbatim into exception messages and stack traces. Matches the
    // redactIdempotencyKey() policy for debug logs.
    const preview =
      typeof key === 'string' ? `${JSON.stringify(key.slice(0, 8))}${key.length > 8 ? '…' : ''}` : typeof key;
    throw new Error(`Invalid idempotency_key: must match ${IDEMPOTENCY_KEY_PATTERN}. Received: ${preview}`);
  }
  return { idempotency_key: key };
}

/**
 * True when the caller has opted into logging full idempotency keys via the
 * `ADCP_LOG_IDEMPOTENCY_KEYS` environment variable. Keys are a retry-pattern
 * oracle within their TTL, so the default is to truncate.
 */
function fullIdempotencyKeyLoggingEnabled(): boolean {
  const value = process.env.ADCP_LOG_IDEMPOTENCY_KEYS;
  if (!value) return false;
  const v = value.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Truncate an idempotency key for logging — first 8 chars followed by `…`.
 * Callers who need the full key for debugging can opt in via
 * `ADCP_LOG_IDEMPOTENCY_KEYS=1`.
 */
export function redactIdempotencyKey(key: string): string {
  if (fullIdempotencyKeyLoggingEnabled()) return key;
  if (typeof key !== 'string' || key.length === 0) return key;
  return `${key.slice(0, 8)}…`;
}

/**
 * Return a shallow copy of `args` with any `idempotency_key` field replaced by
 * its truncated form for safe debug logging. Leaves non-key fields untouched.
 * No-op when `ADCP_LOG_IDEMPOTENCY_KEYS` is set.
 */
export function redactIdempotencyKeyInArgs<T extends Record<string, unknown>>(args: T): T {
  if (!args || typeof args !== 'object') return args;
  if (!('idempotency_key' in args) || typeof args.idempotency_key !== 'string') return args;
  if (fullIdempotencyKeyLoggingEnabled()) return args;
  return { ...args, idempotency_key: redactIdempotencyKey(args.idempotency_key) } as T;
}
