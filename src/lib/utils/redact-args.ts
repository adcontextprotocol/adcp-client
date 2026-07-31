/**
 * Shared redaction for tool arguments that reach caller-visible debug logs.
 *
 * `debug_logs` are returned on `TaskResult` and handed to adopter-supplied log
 * sinks, so anything serialized into them can end up in ordinary application
 * logs, CI output, and log aggregators.
 *
 * The credential that actually travels in AdCP tool arguments is the webhook
 * registration: `push_notification_config.authentication.credentials` is the
 * HMAC shared secret, and `push_notification_config.token` is a validation token
 * the receiver must echo. Both are masked here, along with `idempotency_key`
 * (a retry-pattern oracle within the seller's TTL, opt-out via
 * `ADCP_LOG_IDEMPOTENCY_KEYS=1`).
 *
 * Deliberately NOT masked: nested `context` / `ext` values. Credentials must
 * never be placed there in the first place — see
 * `docs/guides/CTX-METADATA-SAFETY.md` — and masking them would legitimize the
 * channel as a credential carrier.
 */

import { redactIdempotencyKeyInArgs } from './idempotency';

const MASK = '***';

/**
 * Mask webhook credentials and the idempotency key in a tool-argument object.
 *
 * The whole `authentication` block is replaced rather than just its
 * `credentials` field: the scheme list carries no secret, but replacing the
 * object wholesale means a future field addition cannot silently start leaking.
 */
export function redactArgsForLog<T extends Record<string, unknown>>(args: T): T {
  let redacted: Record<string, unknown> = args;

  const config = redacted.push_notification_config;
  if (config && typeof config === 'object') {
    const c = config as Record<string, unknown>;
    redacted = {
      ...redacted,
      push_notification_config: {
        ...c,
        ...(c.authentication !== undefined && { authentication: MASK }),
        ...(c.token !== undefined && { token: MASK }),
      },
    };
  }

  return redactIdempotencyKeyInArgs(redacted) as T;
}
