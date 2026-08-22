/**
 * Publisher-side webhook emitter — the symmetric counterpart to PR #629's
 * receiver-side dedup. A seller / governance agent / rights agent building
 * with `@adcp/sdk` gets a one-call API that handles:
 *
 *   - RFC 9421 webhook signing on every attempt (adcp#2423).
 *   - A stable `idempotency_key` per logical event, reused across retries
 *     (adcp#2417) — regenerating on retry is the #1 at-least-once-delivery
 *     bug the runner-side conformance suite catches.
 *   - Compact-separator JSON serialization once, signed once, posted once
 *     (adcp#2478) — prevents the serialization-mismatch trap where a
 *     signer's byte view differs from what the HTTP client writes.
 *   - Retry/backoff on 5xx and 429. Terminal on 4xx and on 401 responses
 *     carrying `WWW-Authenticate: Signature error="webhook_signature_*"`
 *     (spec says retrying a signature failure just fails identically).
 *   - HMAC-SHA256 fallback for legacy buyers that registered
 *     `push_notification_config.authentication.credentials` — still pinned
 *     to compact separators per adcp#2478.
 *
 * Handler authors using `createAdcpServer` call `ctx.emitWebhook(...)` with
 * a `url`, complete payload, and SDK-local `delivery_id` — everything else
 * is wired in. The payload's AdCP `operation_id` remains a separate task
 * correlation identifier and MUST NOT be substituted for `delivery_id` when
 * one operation can emit more than one status observation.
 */

import { signWebhook, type SignerKey } from '../signing/signer';
import { signWebhookAsync } from '../signing/signer-async';
import type { SigningProvider } from '../signing/provider';
import type { RequestLike } from '../signing/canonicalize';
import { canonicalJsonSha256 } from '../utils/jcs';
import { createPinAndBindFetch } from './pin-and-bind-fetch';
import { createHmac, randomUUID } from 'node:crypto';

/**
 * Minimum pattern per adcp#2417 / core/mcp-webhook-payload.json.
 * Publisher-side check — catches `generateIdempotencyKey` overrides that
 * produce keys too short for a conformant receiver to accept.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

/** WWW-Authenticate header pattern signaling a signature-layer reject. */
const TERMINAL_SIGNATURE_WWW_AUTH_RE = /Signature\s+error="webhook_signature_/i;

/**
 * Immutable binding for one webhook delivery. `delivery_id` is SDK-local;
 * it is deliberately distinct from the AdCP `operation_id` correlation value
 * carried inside task webhook payloads.
 */
export interface WebhookDeliveryBinding {
  status: 'bound';
  idempotencyKey: string;
  /**
   * Lowercase hex SHA-256 of RFC 8785 JCS({ ...payload, idempotency_key }).
   * This is collision-resistant equality evidence, not a password hash or
   * authenticity mechanism; RFC 9421 provides sender authentication.
   */
  payloadFingerprint: string;
  /** Unix epoch milliseconds of the first delivery attempt. */
  firstAttemptAtMs: number;
  /**
   * Store-authoritative physical retention boundary. The store MUST keep the
   * full binding through this instant, then MAY replace it with a permanent
   * retired tombstone. It MUST never make a claimed delivery ID look unused.
   */
  retainUntilMs: number;
}

/** Minimal permanent marker that prevents an expired delivery ID being rebound. */
export interface WebhookDeliveryRetired {
  status: 'retired';
}

export type WebhookDeliveryRecord = WebhookDeliveryBinding | WebhookDeliveryRetired;

/** Store namespace. All members are trusted publisher-side values. */
export interface WebhookDeliveryKey {
  publisherScope: string;
  tenantScope: string;
  deliveryId: string;
}

export interface WebhookDeliveryProposal {
  idempotencyKey: string;
  payloadFingerprint: string;
}

/** Exact caller-owned state required to reconstruct a delivery after restart. */
export interface WebhookDeliverySnapshot {
  url: string;
  payload: Record<string, unknown>;
  authentication: WebhookAuthentication;
  retries: Required<WebhookRetryOptions>;
}

/**
 * Durable outbox seam for process-crash recovery. `checkpoint` runs before
 * the delivery binding is claimed or any POST occurs. It MUST atomically keep
 * the first exact snapshot for `key`, reject a conflicting snapshot, encrypt
 * authentication material at rest, and arrange replay of unsettled snapshots
 * after restart. `settle` removes/terminalizes that snapshot only after a 2xx
 * delivery or a non-retryable outcome. A retryable exhausted result remains
 * pending for the outbox worker.
 */
export interface WebhookDeliveryRecovery {
  readonly durability: 'durable';
  checkpoint(key: Readonly<WebhookDeliveryKey>, snapshot: Readonly<WebhookDeliverySnapshot>): Promise<void> | void;
  settle(key: Readonly<WebhookDeliveryKey>, disposition: 'delivered' | 'terminal'): Promise<void> | void;
}

/**
 * Per-delivery immutable binding store. `claim` MUST be atomic and use the
 * backend's authoritative clock when it creates `firstAttemptAtMs` and
 * `retainUntilMs`. It returns the winning record whether this caller inserted
 * `proposed`, another replica won, or the ID has been retired. The full
 * binding MUST remain available through `retentionMs`. On the first claim
 * after that boundary, the backend MUST atomically replace it with and return
 * `{ status: 'retired' }`. A claimed key MUST never become absent/rebindable:
 * retain the tombstone for the lifetime of the publisher/tenant delivery-ID
 * namespace.
 *
 * Defaults to an in-memory Map in test/development only. Every production
 * publisher MUST inject a durable backend (the same way
 * `AsyncHandlerConfig.webhookDedup` accepts a pluggable store on the
 * receiver side).
 */
export interface WebhookDeliveryStore {
  readonly durability: 'process-local' | 'durable';
  claim(
    key: Readonly<WebhookDeliveryKey>,
    proposed: Readonly<WebhookDeliveryProposal>,
    retentionMs: number
  ): Promise<WebhookDeliveryRecord> | WebhookDeliveryRecord;
}

/** @deprecated Use {@link WebhookDeliveryStore}. */
export type WebhookIdempotencyKeyStore = WebhookDeliveryStore;

export function memoryWebhookDeliveryStore(options: { now?: () => number } = {}): WebhookDeliveryStore {
  const m = new Map<string, WebhookDeliveryRecord>();
  const now = options.now ?? Date.now;
  const storageKey = (key: Readonly<WebhookDeliveryKey>): string =>
    JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
  return {
    durability: 'process-local',
    claim: (key, proposed, retentionMs) => {
      const id = storageKey(key);
      const existing = m.get(id);
      if (existing?.status === 'bound' && now() > existing.retainUntilMs) {
        const retired: WebhookDeliveryRetired = { status: 'retired' };
        m.set(id, retired);
        return retired;
      }
      if (existing !== undefined) return { ...existing };
      const firstAttemptAtMs = now();
      const stored: WebhookDeliveryBinding = {
        status: 'bound',
        ...proposed,
        firstAttemptAtMs,
        retainUntilMs: firstAttemptAtMs + retentionMs,
      };
      m.set(id, stored);
      return { ...stored };
    },
  };
}

/** @deprecated Use {@link memoryWebhookDeliveryStore}. */
export const memoryWebhookKeyStore = memoryWebhookDeliveryStore;

/**
 * Authentication mode for a single delivery. Omit / pass `null` to use the
 * 9421 baseline. `bearer` / `hmac_sha256` drop back to legacy flows for
 * buyers who populated `push_notification_config.authentication.credentials`.
 *
 * @deprecated The `hmac_sha256` variant is deprecated. HMAC remains in the
 * AdCP spec as a legacy fallback for buyers that registered
 * `push_notification_config.authentication.credentials`, so the SDK keeps
 * supporting it — but the spec-current path is RFC 9421 webhook signatures.
 * See docs/migration-4.x-to-5.x.md#webhook-hmac-legacy-deprecation.
 */
export type WebhookAuthentication = { type: 'bearer'; token: string } | { type: 'hmac_sha256'; secret: string } | null;

let hmacWarningFired = false;

function maybeWarnHmacDeprecation(suppressLegacyWarnings?: boolean): void {
  if (hmacWarningFired) return;
  if (suppressLegacyWarnings) return;
  if (process.env.ADCP_SUPPRESS_HMAC_WARNING === '1') return;
  hmacWarningFired = true;
  console.warn(
    '[adcp] Warning: webhook HMAC-SHA256 authentication is deprecated. ' +
      'HMAC remains supported in the AdCP spec as a legacy fallback but RFC ' +
      '9421 is the spec-current path; migrate when your counterparties are ' +
      'ready. See docs/migration-4.x-to-5.x.md#webhook-hmac-legacy-deprecation. ' +
      'Suppress with ADCP_SUPPRESS_HMAC_WARNING=1 (env) or ' +
      'createWebhookEmitter({ suppressLegacyWarnings: true }) (programmatic).'
  );
}

export interface WebhookRetryOptions {
  /** Max delivery attempts (≥1). Default 5. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 1000. */
  initialDelayMs?: number;
  /** Cap per-attempt backoff. Default 60000. */
  maxDelayMs?: number;
  /** Jitter factor ∈ [0,1]: 0 = none, 0.5 = ±50%. Default 0.25. */
  jitter?: number;
}

export interface WebhookEmitterOptions {
  /**
   * In-process JWK signing key. Its JWKS entry SHOULD carry
   * `adcp_use: "request-signing"` — webhooks are signed with the agent's
   * request-signing key (the deprecated `"webhook-signing"` value is still
   * accepted by verifiers for backward compatibility). Mutually exclusive
   * with `signerProvider` — exactly one must be provided.
   */
  signerKey?: SignerKey;
  /**
   * Async KMS-backed signing provider (GCP KMS, AWS KMS, Azure Key Vault, etc.).
   * Routes webhook signing through `signWebhookAsync` so the private key never
   * enters process memory. Mutually exclusive with `signerKey` — exactly one
   * must be provided.
   *
   * **Key purpose.** Webhooks are signed with a `request-signing` key; domain
   * separation between requests and webhooks is carried by the signature
   * `tag`, not the `adcp_use` discriminator. The same `SigningProvider` used
   * for `request_signing.provider` MAY be reused here. To isolate webhook key
   * material (so a webhook-key compromise does not extend to request signing,
   * or to rotate independently), wrap a second `request-signing`
   * `cryptoKeyVersion` published under a distinct `kid` — isolation comes from
   * the `kid`, not a distinct `adcp_use`. (The deprecated `"webhook-signing"`
   * purpose is still accepted by verifiers for backward compatibility.)
   */
  signerProvider?: SigningProvider;
  retries?: WebhookRetryOptions;
  /**
   * Durable immutable delivery-binding store. Multi-replica publishers MUST
   * provide a shared implementation whose `claim` is atomic.
   */
  deliveryStore?: WebhookDeliveryStore;
  /** @deprecated Use `deliveryStore`. */
  idempotencyKeyStore?: WebhookDeliveryStore;
  /**
   * Maximum interval after the first attempt during which this emitter may
   * retry a delivery. Defaults to the AdCP 3.2 minimum of 86400 seconds (24h).
   * Must be an integer from 86400 through 604800 (7d).
   */
  deliveryRetryHorizonSeconds?: number;
  /**
   * Durable delivery snapshot/outbox. Required in production so the
   * advertised retry horizon remains recoverable across process crashes.
   */
  deliveryRecovery?: WebhookDeliveryRecovery;
  /**
   * Stable publisher namespace for shared delivery stores. Production direct
   * emitter callers MUST set this. `createAdcpServer` defaults it from the
   * trusted server name.
   */
  publisherScope?: string;
  /**
   * Stable tenant namespace for direct emitter callers. Production direct
   * callers MUST set it. `createAdcpServer` derives it from resolved trusted
   * request context and never from webhook payload fields.
   */
  tenantScope?: string;
  /**
   * Override the default idempotency-key generator. Must return a value
   * matching `/^[A-Za-z0-9_.:-]{16,255}$/` — the emitter rejects anything
   * else (a malformed key would fail the receiver's schema check, which
   * would report as a conformance violation of the publisher).
   */
  generateIdempotencyKey?: () => string;
  /**
   * Override the HTTP client. Defaults to `createPinAndBindFetch()`, which
   * defeats DNS-rebinding / SSRF attacks against the buyer-supplied
   * `push_notification_config.url` (https-only; loopback, private, and cloud
   * metadata ranges denied). See `docs/guides/SIGNING-GUIDE.md` § Webhook
   * SSRF defense.
   *
   * In-process storyboard / test harnesses that deliver to a loopback
   * `http://127.0.0.1:port` receiver must opt into the relaxed policy
   * explicitly: `fetch: createPinAndBindFetch({ policy:
   * LOOPBACK_OK_WEBHOOK_SSRF_POLICY })`. Passing `globalThis.fetch` here
   * restores the unguarded pre-9.8 behavior — only do so behind your own
   * URL validation.
   */
  fetch?: typeof fetch;
  /** Default `User-Agent` header. */
  userAgent?: string;
  /** Signing tag override. Defaults to `adcp/webhook-signing/v1`. */
  tag?: string;
  /** Observability hook called BEFORE each attempt. */
  onAttempt?: (info: WebhookEmitAttempt) => void;
  /** Observability hook called AFTER each attempt completes. */
  onAttemptResult?: (info: WebhookEmitAttemptResult) => void;
  /**
   * Sleeper override. Production uses `setTimeout`; tests inject a stub to
   * skip real backoff. Takes (ms, abortSignal) and resolves when slept.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Suppress the one-time `console.warn` emitted on first HMAC-SHA256
   * webhook delivery. Programmatic equivalent of
   * `ADCP_SUPPRESS_HMAC_WARNING=1`, for libraries embedded in agents where
   * setting an env var is awkward. Does not affect the `@deprecated` JSDoc
   * flag on `WebhookAuthentication` — the type-level deprecation signal
   * always shows up in IDEs.
   */
  suppressLegacyWarnings?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface WebhookEmitParams {
  /** Full destination URL. Typically from `push_notification_config.url`. */
  url: string;
  /** Object body. Serialized with compact separators (adcp#2478). */
  payload: Record<string, unknown>;
  /**
   * SDK-local identity for this exact webhook delivery. Retries MUST reuse
   * the same value; a changed payload or distinct lifecycle observation MUST
   * use a fresh value. This is intentionally not the AdCP `operation_id`,
   * which remains a stable task correlation value inside the payload.
   */
  delivery_id: string;
  /**
   * Per-emit override of the delivery's authentication mode. Omit for the
   * 9421 default.
   */
  authentication?: WebhookAuthentication;
  /** Per-emit retries override. */
  retries?: WebhookRetryOptions;
}

export interface WebhookEmitAttempt {
  delivery_id: string;
  idempotency_key: string;
  attempt: number;
  url: string;
}

export interface WebhookEmitAttemptResult extends WebhookEmitAttempt {
  status?: number;
  durationMs: number;
  error?: string;
  willRetry: boolean;
}

export interface WebhookEmitResult {
  delivery_id: string;
  idempotency_key: string;
  attempts: number;
  delivered: boolean;
  final_status?: number;
  /**
   * Per-attempt error messages (transport / signer / network failures).
   *
   * **Logging caution:** when a `signerProvider` rejection bubbles into
   * this array, the message text comes from the adapter and may include
   * infra-flavored detail (KMS resource names, IAM principals, project
   * IDs). Mirrors the same caution flagged on `SigningProvider.fingerprint`.
   * If you pipe `errors[]` into shared logs / observability pipelines,
   * sanitize or redact at your boundary — adapter messages aren't
   * guaranteed to be operator-safe.
   */
  errors: string[];
}

export interface WebhookEmitter {
  emit(params: WebhookEmitParams): Promise<WebhookEmitResult>;
  /** Bind an emitter to a trusted tenant namespace without exposing scope in emit params. */
  forTenantScope(tenantScope: string): WebhookEmitter;
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

export function createWebhookEmitter(options: WebhookEmitterOptions): WebhookEmitter {
  if (options.signerKey && options.signerProvider) {
    throw new TypeError('createWebhookEmitter: provide exactly one of signerKey or signerProvider, not both');
  }
  if (!options.signerKey && !options.signerProvider) {
    throw new TypeError('createWebhookEmitter: one of signerKey or signerProvider is required');
  }
  if (options.deliveryStore && options.idempotencyKeyStore) {
    throw new TypeError('createWebhookEmitter: provide deliveryStore, not both deliveryStore and idempotencyKeyStore');
  }
  const retryHorizonSeconds = resolveRetryHorizonSeconds(options.deliveryRetryHorizonSeconds);
  const explicitStore = options.deliveryStore ?? options.idempotencyKeyStore;
  const store = explicitStore ?? memoryWebhookDeliveryStore({ now: options.now });
  const production = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
  if (production && store.durability !== 'durable') {
    throw new TypeError(
      'createWebhookEmitter: production webhook emission requires a durable WebhookDeliveryStore; ' +
        'memoryWebhookDeliveryStore() is for development and tests only'
    );
  }
  if (production && options.deliveryRecovery?.durability !== 'durable') {
    throw new TypeError(
      'createWebhookEmitter: production webhook emission requires durable deliveryRecovery ' +
        'to checkpoint exact retry state before the first attempt'
    );
  }
  if (production && (!options.publisherScope || !options.tenantScope)) {
    throw new TypeError(
      'createWebhookEmitter: production direct emitters require non-empty publisherScope and tenantScope'
    );
  }
  const publisherScope = requireScope(options.publisherScope ?? 'development-publisher', 'publisherScope');
  const tenantScope = requireScope(options.tenantScope ?? 'development-tenant', 'tenantScope');
  const generateKey = options.generateIdempotencyKey ?? defaultGenerateIdempotencyKey;
  const fetchImpl = options.fetch ?? createPinAndBindFetch();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const makeEmitter = (boundTenantScope: string): WebhookEmitter => ({
    forTenantScope(nextTenantScope: string): WebhookEmitter {
      return makeEmitter(requireScope(nextTenantScope, 'tenantScope'));
    },
    async emit(params: WebhookEmitParams): Promise<WebhookEmitResult> {
      // Snapshot every caller-owned value before the first await. A slow
      // durable claim must not let post-invocation mutation change identity,
      // destination, authentication, or retry policy.
      const deliveryId = params.delivery_id;
      if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
        throw new TypeError('delivery_id must be a non-empty string');
      }
      const url = params.url;
      const payloadSnapshot = structuredClone(params.payload);
      const authentication = params.authentication == null ? null : structuredClone(params.authentication);
      const retries = resolveRetries(params.retries === undefined ? options.retries : structuredClone(params.retries));
      assertIJson(payloadSnapshot);
      const deliveryKey = { publisherScope, tenantScope: boundTenantScope, deliveryId };
      await options.deliveryRecovery?.checkpoint(deliveryKey, {
        url,
        payload: structuredClone(payloadSnapshot),
        authentication: authentication === null ? null : structuredClone(authentication),
        retries: { ...retries },
      });
      let binding = await resolveDeliveryBinding({
        store,
        key: deliveryKey,
        payload: payloadSnapshot,
        generateKey,
        nowMs: now(),
        retryHorizonSeconds,
      });
      const idempotency_key = binding.idempotencyKey;

      // Serialize ONCE with compact separators — the same bytes feed both
      // the content-digest input and the HTTP body on every attempt. This
      // is the load-bearing rule from adcp#2478.
      const bodyPayload = { ...payloadSnapshot, idempotency_key };
      const bodyBytes = JSON.stringify(bodyPayload);

      const errors: string[] = [];
      let lastStatus: number | undefined;
      let finalTerminal = false;

      for (let attempt = 1; attempt <= retries.maxAttempts; attempt++) {
        if (attempt > 1) {
          binding = await refreshDeliveryBinding(store, deliveryKey, binding, retryHorizonSeconds);
        }
        assertWithinRetryHorizon(binding, deliveryId, now(), retryHorizonSeconds);
        const attemptInfo: WebhookEmitAttempt = {
          delivery_id: deliveryId,
          idempotency_key,
          attempt,
          url,
        };
        options.onAttempt?.(attemptInfo);

        const started = Date.now();
        let status: number | undefined;
        let error: string | undefined;
        let terminal = false;

        try {
          const response = await deliverOnce({
            url,
            bodyBytes,
            signerKey: options.signerKey,
            signerProvider: options.signerProvider,
            authentication,
            tag: options.tag,
            userAgent: options.userAgent,
            fetch: fetchImpl,
            suppressLegacyWarnings: options.suppressLegacyWarnings,
          });
          status = response.status;
          lastStatus = status;

          if (status >= 200 && status < 300) {
            const durationMs = Date.now() - started;
            options.onAttemptResult?.({ ...attemptInfo, status, durationMs, willRetry: false });
            await options.deliveryRecovery?.settle(deliveryKey, 'delivered');
            return {
              delivery_id: deliveryId,
              idempotency_key,
              attempts: attempt,
              delivered: true,
              final_status: status,
              errors,
            };
          }

          terminal = isTerminalStatus(status, response.wwwAuthenticate);
          error =
            status >= 300 && status < 400
              ? `HTTP ${status} redirect${response.location ? ` to ${response.location}` : ''} — redirects are ` +
                `never followed for signed webhook delivery, because the signature covers @target-uri and ` +
                `would not verify at the redirect target. Re-register the webhook with the final URL.`
              : `HTTP ${status}${response.wwwAuthenticate ? ` (${response.wwwAuthenticate})` : ''}`;
        } catch (err) {
          error = formatTransportError(err);
          // Network / transport errors are retryable — the delivery didn't
          // reach the receiver, so no risk of double-processing.
          // Pin-and-bind SSRF blocks are themselves terminal: the URL
          // (or its DNS resolution) violates policy and won't change on retry.
          if (errorContainsCode(err, 'EADCP_SSRF_BLOCKED')) {
            terminal = true;
          }
        }

        if (error) errors.push(`attempt ${attempt}: ${error}`);

        const willRetry = !terminal && attempt < retries.maxAttempts;
        finalTerminal = terminal;
        options.onAttemptResult?.({
          ...attemptInfo,
          ...(status !== undefined && { status }),
          durationMs: Date.now() - started,
          ...(error !== undefined && { error }),
          willRetry,
        });

        if (!willRetry) break;

        await sleep(backoffDelay(attempt, retries));
      }

      if (finalTerminal) await options.deliveryRecovery?.settle(deliveryKey, 'terminal');

      return {
        delivery_id: deliveryId,
        idempotency_key,
        attempts: errors.length,
        delivered: false,
        ...(lastStatus !== undefined && { final_status: lastStatus }),
        errors,
      };
    },
  });
  return makeEmitter(tenantScope);
}

async function refreshDeliveryBinding(
  store: WebhookDeliveryStore,
  key: WebhookDeliveryKey,
  expected: WebhookDeliveryBinding,
  retryHorizonSeconds: number
): Promise<WebhookDeliveryBinding> {
  const record = await store.claim(
    key,
    { idempotencyKey: expected.idempotencyKey, payloadFingerprint: expected.payloadFingerprint },
    retryHorizonSeconds * 1000
  );
  if (record?.status === 'retired') throw retiredDeliveryError(key.deliveryId);
  const binding = record as WebhookDeliveryBinding;
  assertValidDeliveryBinding(binding, key.deliveryId, retryHorizonSeconds);
  if (
    binding.idempotencyKey !== expected.idempotencyKey ||
    binding.payloadFingerprint !== expected.payloadFingerprint ||
    binding.firstAttemptAtMs !== expected.firstAttemptAtMs ||
    binding.retainUntilMs !== expected.retainUntilMs
  ) {
    throw new Error(`Webhook delivery store changed the immutable binding for delivery_id "${key.deliveryId}".`);
  }
  return binding;
}

// ────────────────────────────────────────────────────────────
// Delivery primitives
// ────────────────────────────────────────────────────────────

interface DeliveryResponse {
  status: number;
  wwwAuthenticate?: string;
  /** `Location` on a 3xx, so the diagnostic can name the redirect target. */
  location?: string;
}

async function deliverOnce(args: {
  url: string;
  bodyBytes: string;
  signerKey?: SignerKey;
  signerProvider?: SigningProvider;
  authentication: WebhookAuthentication;
  tag?: string;
  userAgent?: string;
  fetch: typeof fetch;
  suppressLegacyWarnings?: boolean;
}): Promise<DeliveryResponse> {
  const headers = await buildHeaders(args);
  const response = await args.fetch(args.url, {
    method: 'POST',
    headers,
    body: args.bodyBytes,
  });
  return {
    status: response.status,
    ...(response.headers.get('www-authenticate') && { wwwAuthenticate: response.headers.get('www-authenticate')! }),
    ...(response.headers.get('location') && { location: response.headers.get('location')! }),
  };
}

async function buildHeaders(args: {
  url: string;
  bodyBytes: string;
  signerKey?: SignerKey;
  signerProvider?: SigningProvider;
  authentication: WebhookAuthentication;
  tag?: string;
  userAgent?: string;
  suppressLegacyWarnings?: boolean;
}): Promise<Record<string, string>> {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (args.userAgent) baseHeaders['user-agent'] = args.userAgent;

  // Legacy HMAC-SHA256 path. Matches docs/building/implementation/webhooks.mdx
  // §3.0 legacy section: X-ADCP-Signature + X-ADCP-Timestamp over
  // `${ts}.${raw_body_bytes}`.
  if (args.authentication?.type === 'hmac_sha256') {
    maybeWarnHmacDeprecation(args.suppressLegacyWarnings);
    const ts = Math.floor(Date.now() / 1000).toString();
    const hmac = createHmac('sha256', args.authentication.secret);
    hmac.update(`${ts}.${args.bodyBytes}`, 'utf8');
    return {
      ...baseHeaders,
      'x-adcp-timestamp': ts,
      'x-adcp-signature': `sha256=${hmac.digest('hex')}`,
    };
  }

  // Bearer fallback — the legacy path for buyers that registered an API
  // key in push_notification_config.authentication. No body signing —
  // just a header. Not recommended; strictly for interop with 2.x buyers.
  if (args.authentication?.type === 'bearer') {
    return { ...baseHeaders, authorization: `Bearer ${args.authentication.token}` };
  }

  // Default: 9421 webhook signing. Fresh nonce + fresh created/expires per
  // attempt, but the `idempotency_key` inside the body stays stable — the
  // signature covers the body bytes, which include the key; multiple
  // retries of the same logical event produce different signatures over
  // the same body, which is exactly what the receiver expects.
  const request: RequestLike = {
    method: 'POST',
    url: args.url,
    headers: baseHeaders,
    body: args.bodyBytes,
  };
  const signOpts = args.tag !== undefined ? { tag: args.tag } : {};
  const signed = args.signerProvider
    ? await signWebhookAsync(request, args.signerProvider, signOpts)
    : signWebhook(request, args.signerKey!, signOpts);
  return { ...baseHeaders, ...signed.headers };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

async function resolveDeliveryBinding(args: {
  store: WebhookDeliveryStore;
  key: WebhookDeliveryKey;
  payload: Record<string, unknown>;
  generateKey: () => string;
  nowMs: number;
  retryHorizonSeconds: number;
}): Promise<WebhookDeliveryBinding> {
  const deliveryId = args.key.deliveryId;
  if (typeof deliveryId !== 'string' || !deliveryId) throw new TypeError('delivery_id must be a non-empty string');

  const candidateKey = args.generateKey();
  assertValidIdempotencyKey(candidateKey, 'generateIdempotencyKey', deliveryId);

  const proposed: WebhookDeliveryProposal = {
    idempotencyKey: candidateKey,
    payloadFingerprint: canonicalJsonSha256({ ...args.payload, idempotency_key: candidateKey }),
  };
  const record = await args.store.claim(args.key, proposed, args.retryHorizonSeconds * 1000);
  if (record?.status === 'retired') {
    throw retiredDeliveryError(deliveryId);
  }
  const binding = record as WebhookDeliveryBinding;
  assertValidDeliveryBinding(binding, deliveryId, args.retryHorizonSeconds);

  const suppliedFingerprint = canonicalJsonSha256({
    ...args.payload,
    idempotency_key: binding.idempotencyKey,
  });
  if (binding.payloadFingerprint !== suppliedFingerprint) {
    throw new Error(
      `Webhook delivery_id "${deliveryId}" is already bound to a different canonical payload. ` +
        'Use a fresh delivery_id for each changed payload or lifecycle observation.'
    );
  }

  assertWithinRetryHorizon(binding, deliveryId, args.nowMs, args.retryHorizonSeconds);
  return binding;
}

function retiredDeliveryError(deliveryId: string): Error {
  return new Error(
    `Webhook delivery_id "${deliveryId}" is retired after its retry horizon and MUST NOT be rebound. ` +
      'Create a new logical notification and delivery_id only when protocol re-emission is allowed.'
  );
}

function assertWithinRetryHorizon(
  binding: WebhookDeliveryBinding,
  deliveryId: string,
  nowMs: number,
  retryHorizonSeconds: number
): void {
  // Clamp ordinary replica clock skew. The store's authoritative
  // retainUntilMs remains the actual hard boundary.
  const effectiveNowMs = Math.max(binding.firstAttemptAtMs, nowMs);
  if (effectiveNowMs > binding.firstAttemptAtMs + retryHorizonSeconds * 1000) {
    throw new Error(
      `Webhook delivery_id "${deliveryId}" is outside its ${retryHorizonSeconds}-second retry horizon. ` +
        'Do not retry the retained idempotency key; create a new logical notification and delivery_id if re-emission is allowed.'
    );
  }
}

function assertValidDeliveryBinding(
  binding: WebhookDeliveryBinding,
  deliveryId: string,
  retryHorizonSeconds: number
): void {
  if (binding === null || typeof binding !== 'object' || binding.status !== 'bound') {
    throw new Error(`Webhook delivery store returned an invalid binding for delivery_id "${deliveryId}".`);
  }
  assertValidIdempotencyKey(binding.idempotencyKey, 'delivery store', deliveryId);
  if (!/^[a-f0-9]{64}$/.test(binding.payloadFingerprint)) {
    throw new Error(`Webhook delivery store returned an invalid payload fingerprint for delivery_id "${deliveryId}".`);
  }
  if (!Number.isSafeInteger(binding.firstAttemptAtMs) || binding.firstAttemptAtMs < 0) {
    throw new Error(`Webhook delivery store returned an invalid firstAttemptAtMs for delivery_id "${deliveryId}".`);
  }
  const requiredRetainUntilMs = binding.firstAttemptAtMs + retryHorizonSeconds * 1000;
  if (!Number.isSafeInteger(binding.retainUntilMs) || binding.retainUntilMs < requiredRetainUntilMs) {
    throw new Error(
      `Webhook delivery store returned a retainUntilMs shorter than the advertised retry horizon for delivery_id "${deliveryId}".`
    );
  }
}

function requireScope(value: string, name: 'publisherScope' | 'tenantScope'): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL characters`);
  }
  return value;
}

function assertIJson(value: unknown): void {
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (frame.exit) {
      ancestors.delete(current as object);
      continue;
    }
    if (typeof current === 'string') {
      assertIJsonString(current);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      if (ancestors.has(current)) {
        throw new TypeError('Webhook payload contains a circular reference and is not valid JSON');
      }
      ancestors.add(current);
      stack.push({ value: current, exit: true });
      const entries = Array.isArray(current)
        ? current.map((member, index) => [String(index), member] as const)
        : Object.entries(current as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, member] = entries[index]!;
        assertIJsonString(key);
        stack.push({ value: member });
      }
    }
  }
}

function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        index++;
        continue;
      }
      throw new TypeError('Webhook payload contains a lone Unicode surrogate, which is not valid I-JSON');
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Webhook payload contains a lone Unicode surrogate, which is not valid I-JSON');
    }
  }
}

function assertValidIdempotencyKey(key: string, source: string, deliveryId: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error(
      `${source} returned "${key}" for delivery_id "${deliveryId}"; ` +
        `does not match required pattern ${IDEMPOTENCY_KEY_PATTERN.source}`
    );
  }
}

/**
 * Default key generator — `evt_` prefix + a base64url 18-byte random.
 * Length 27 (comfortably within 16–255), only base64url-safe characters,
 * obviously-webhook-scoped prefix for log grepping.
 */
function defaultGenerateIdempotencyKey(): string {
  const uuid = randomUUID().replace(/-/g, '');
  return `evt_${uuid.slice(0, 24)}`;
}

function isTerminalStatus(status: number, wwwAuthenticate?: string): boolean {
  if (status === 429) return false;
  if (status >= 500) return false;
  // A redirect is a configuration error, not a transient one — retrying it
  // produces the same redirect. `createPinAndBindFetch` deliberately does not
  // follow redirects (the signature covers `@target-uri`, so a replayed hop
  // would not verify at the target anyway), so a 3xx means the registered URL
  // is not the final one.
  if (status >= 300 && status < 400) return true;
  // 401 with a signature-layer reject is terminal per adcp#2423 —
  // retrying a signature failure produces identical bytes and identical
  // rejection. Non-signature 401s (opaque auth failures) are also
  // terminal; there's nothing the publisher can do by retrying.
  if (status === 401 && wwwAuthenticate && TERMINAL_SIGNATURE_WWW_AUTH_RE.test(wwwAuthenticate)) return true;
  if (status >= 400 && status < 500) return true;
  return false;
}

function backoffDelay(attempt: number, retries: Required<WebhookRetryOptions>): number {
  const base = Math.min(retries.initialDelayMs * Math.pow(2, attempt - 1), retries.maxDelayMs);
  if (retries.jitter <= 0) return base;
  const jitterWindow = base * retries.jitter;
  const offset = Math.random() * jitterWindow * 2 - jitterWindow;
  return Math.max(0, Math.floor(base + offset));
}

function resolveRetries(opts?: WebhookRetryOptions): Required<WebhookRetryOptions> {
  return {
    maxAttempts: Math.max(1, opts?.maxAttempts ?? 5),
    initialDelayMs: Math.max(0, opts?.initialDelayMs ?? 1000),
    maxDelayMs: Math.max(0, opts?.maxDelayMs ?? 60_000),
    jitter: Math.max(0, Math.min(1, opts?.jitter ?? 0.25)),
  };
}

function resolveRetryHorizonSeconds(value?: number): number {
  const resolved = value ?? 86_400;
  if (!Number.isInteger(resolved) || resolved < 86_400 || resolved > 604_800) {
    throw new TypeError('deliveryRetryHorizonSeconds must be an integer from 86400 through 604800');
  }
  return resolved;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(r => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/**
 * Format a transport-layer error for `result.errors[]`. Walks `cause` chains
 * (undici wraps the connector failure under a generic "fetch failed") so
 * operators see the actual rule that fired (e.g. SSRF policy block) instead
 * of an opaque outer message.
 */
function formatTransportError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let cur: Error | undefined = err;
  let depth = 0;
  while (cur && depth < 5) {
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code ? `${code}: ${cur.message}` : cur.message);
    cur = cur.cause instanceof Error ? cur.cause : undefined;
    depth++;
  }
  return parts.join(' — ');
}

function errorContainsCode(err: unknown, code: string): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur instanceof Error && depth < 5) {
    if ((cur as NodeJS.ErrnoException).code === code) return true;
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  return false;
}
