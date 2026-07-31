/**
 * Shared redaction for tool arguments that reach caller-visible debug logs.
 *
 * `debug_logs` are returned on `TaskResult` and handed to adopter-supplied log
 * sinks, so anything serialized into them can end up in ordinary application
 * logs, CI output, and log aggregators.
 *
 * The credentials that actually travel in AdCP tool arguments are the webhook
 * registrations, and there are TWO of them:
 *
 * - `push_notification_config` (async task-status notifications) — on most
 *   mutating tools.
 * - `reporting_webhook` (automated delivery reports) — on `create_media_buy`.
 *
 * Both carry an `authentication.credentials` HMAC shared secret and a `token`
 * the receiver must echo, and `reporting-webhook.json` makes `authentication`
 * REQUIRED for all of AdCP 3.x — so the reporting registration is the one most
 * certain to be populated on the call most likely to be logged. Masking only
 * the push config would leave that secret in plaintext.
 *
 * `idempotency_key` is masked too (a retry-pattern oracle within the seller's
 * TTL; opt out with `ADCP_LOG_IDEMPOTENCY_KEYS=1`).
 *
 * Deliberately NOT masked: nested `context` / `ext` values. Credentials must
 * never be placed there in the first place — see
 * `docs/guides/CTX-METADATA-SAFETY.md` — and masking them would legitimize the
 * channel as a credential carrier.
 */

import { redactIdempotencyKeyInArgs } from './idempotency';

const MASK = '***';

/**
 * Argument fields that hold a webhook registration. Kept as a list so adding a
 * third registration shape is one line rather than a new code path.
 */
const WEBHOOK_CONFIG_FIELDS = ['push_notification_config', 'reporting_webhook'] as const;

/** Credential-bearing fields within a webhook registration. */
const CREDENTIAL_FIELDS = ['authentication', 'token'] as const;

/**
 * Mask webhook credentials and the idempotency key in a tool-argument object.
 *
 * The whole `authentication` block is replaced rather than just its
 * `credentials` field: the scheme list carries no secret, but replacing the
 * object wholesale means a future field addition cannot silently start leaking.
 */
export function redactArgsForLog<T extends Record<string, unknown>>(args: T): T {
  let redacted: Record<string, unknown> = args;

  for (const field of WEBHOOK_CONFIG_FIELDS) {
    const config = redacted[field];
    if (!config || typeof config !== 'object') continue;
    const c = config as Record<string, unknown>;
    const masked: Record<string, unknown> = { ...c };
    for (const credential of CREDENTIAL_FIELDS) {
      if (c[credential] !== undefined) masked[credential] = MASK;
    }
    redacted = { ...redacted, [field]: masked };
  }

  return redactIdempotencyKeyInArgs(redacted) as T;
}
