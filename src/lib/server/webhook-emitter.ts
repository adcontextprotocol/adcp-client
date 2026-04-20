/**
 * Publisher-side webhook emitter — the symmetric counterpart to PR #629's
 * receiver-side dedup. A seller / governance agent / rights agent building
 * with `@adcp/client` gets a one-call API that handles:
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
 * a `url`, `payload`, and `operation_id` — everything else is wired in.
 */

import { signWebhook, type SignerKey } from '../signing/signer';
import type { RequestLike } from '../signing/canonicalize';
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
 * Per-(operation_id) idempotency-key store. The key MUST be stable across
 * every retry of the same logical event — that's the load-bearing invariant
 * the receiver-side dedup depends on.
 *
 * Defaults to an in-memory Map. Production publishers with multi-replica
 * emitters SHOULD inject a durable backend (the same way
 * `AsyncHandlerConfig.webhookDedup` accepts a pluggable store on the
 * receiver side).
 */
export interface WebhookIdempotencyKeyStore {
  get(operation_id: string): Promise<string | undefined> | string | undefined;
  /** Called only on first-seen operation_id. Subsequent emits read via get(). */
  set(operation_id: string, key: string): Promise<void> | void;
}

export function memoryWebhookKeyStore(): WebhookIdempotencyKeyStore {
  const m = new Map<string, string>();
  return {
    get: id => m.get(id),
    set: (id, key) => {
      m.set(id, key);
    },
  };
}

/**
 * Authentication mode for a single delivery. Omit / pass `null` to use the
 * 9421 baseline. `bearer` / `hmac_sha256` drop back to legacy flows for
 * buyers who populated `push_notification_config.authentication.credentials`.
 */
export type WebhookAuthentication = { type: 'bearer'; token: string } | { type: 'hmac_sha256'; secret: string } | null;

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
  /** Ed25519 / ECDSA-P256 signing key. `adcp_use` MUST be `"webhook-signing"`. */
  signerKey: SignerKey;
  retries?: WebhookRetryOptions;
  idempotencyKeyStore?: WebhookIdempotencyKeyStore;
  /**
   * Override the default idempotency-key generator. Must return a value
   * matching `/^[A-Za-z0-9_.:-]{16,255}$/` — the emitter rejects anything
   * else (a malformed key would fail the receiver's schema check, which
   * would report as a conformance violation of the publisher).
   */
  generateIdempotencyKey?: () => string;
  /** Override the HTTP client (tests, proxies, SSRF-wrappers). */
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
}

export interface WebhookEmitParams {
  /** Full destination URL. Typically from `push_notification_config.url`. */
  url: string;
  /** Object body. Serialized with compact separators (adcp#2478). */
  payload: Record<string, unknown>;
  /**
   * Stable logical event id. Two emits with the same operation_id reuse
   * the same `idempotency_key` — this is the cross-attempt AND
   * cross-process invariant the receiver dedups on.
   */
  operation_id: string;
  /**
   * Per-emit override of the delivery's authentication mode. Omit for the
   * 9421 default.
   */
  authentication?: WebhookAuthentication;
  /** Per-emit retries override. */
  retries?: WebhookRetryOptions;
}

export interface WebhookEmitAttempt {
  operation_id: string;
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
  operation_id: string;
  idempotency_key: string;
  attempts: number;
  delivered: boolean;
  final_status?: number;
  errors: string[];
}

export interface WebhookEmitter {
  emit(params: WebhookEmitParams): Promise<WebhookEmitResult>;
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

export function createWebhookEmitter(options: WebhookEmitterOptions): WebhookEmitter {
  const store = options.idempotencyKeyStore ?? memoryWebhookKeyStore();
  const generateKey = options.generateIdempotencyKey ?? defaultGenerateIdempotencyKey;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async emit(params: WebhookEmitParams): Promise<WebhookEmitResult> {
      const retries = resolveRetries(params.retries ?? options.retries);
      const idempotency_key = await resolveIdempotencyKey(store, params.operation_id, generateKey);

      // Serialize ONCE with compact separators — the same bytes feed both
      // the content-digest input and the HTTP body on every attempt. This
      // is the load-bearing rule from adcp#2478.
      const bodyPayload = { ...params.payload, idempotency_key };
      const bodyBytes = JSON.stringify(bodyPayload);

      const errors: string[] = [];
      let lastStatus: number | undefined;

      for (let attempt = 1; attempt <= retries.maxAttempts; attempt++) {
        const attemptInfo: WebhookEmitAttempt = {
          operation_id: params.operation_id,
          idempotency_key,
          attempt,
          url: params.url,
        };
        options.onAttempt?.(attemptInfo);

        const started = Date.now();
        let status: number | undefined;
        let error: string | undefined;
        let terminal = false;

        try {
          const response = await deliverOnce({
            url: params.url,
            bodyBytes,
            signerKey: options.signerKey,
            authentication: params.authentication ?? null,
            tag: options.tag,
            userAgent: options.userAgent,
            fetch: fetchImpl,
          });
          status = response.status;
          lastStatus = status;

          if (status >= 200 && status < 300) {
            const durationMs = Date.now() - started;
            options.onAttemptResult?.({ ...attemptInfo, status, durationMs, willRetry: false });
            return {
              operation_id: params.operation_id,
              idempotency_key,
              attempts: attempt,
              delivered: true,
              final_status: status,
              errors,
            };
          }

          terminal = isTerminalStatus(status, response.wwwAuthenticate);
          error = `HTTP ${status}${response.wwwAuthenticate ? ` (${response.wwwAuthenticate})` : ''}`;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          // Network / transport errors are retryable — the delivery didn't
          // reach the receiver, so no risk of double-processing.
        }

        if (error) errors.push(`attempt ${attempt}: ${error}`);

        const willRetry = !terminal && attempt < retries.maxAttempts;
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

      return {
        operation_id: params.operation_id,
        idempotency_key,
        attempts: errors.length,
        delivered: false,
        ...(lastStatus !== undefined && { final_status: lastStatus }),
        errors,
      };
    },
  };
}

// ────────────────────────────────────────────────────────────
// Delivery primitives
// ────────────────────────────────────────────────────────────

interface DeliveryResponse {
  status: number;
  wwwAuthenticate?: string;
}

async function deliverOnce(args: {
  url: string;
  bodyBytes: string;
  signerKey: SignerKey;
  authentication: WebhookAuthentication;
  tag?: string;
  userAgent?: string;
  fetch: typeof fetch;
}): Promise<DeliveryResponse> {
  const headers = buildHeaders(args);
  const response = await args.fetch(args.url, {
    method: 'POST',
    headers,
    body: args.bodyBytes,
  });
  return {
    status: response.status,
    ...(response.headers.get('www-authenticate') && { wwwAuthenticate: response.headers.get('www-authenticate')! }),
  };
}

function buildHeaders(args: {
  url: string;
  bodyBytes: string;
  signerKey: SignerKey;
  authentication: WebhookAuthentication;
  tag?: string;
  userAgent?: string;
}): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (args.userAgent) baseHeaders['user-agent'] = args.userAgent;

  // Legacy HMAC-SHA256 path. Matches docs/building/implementation/webhooks.mdx
  // §3.0 legacy section: X-ADCP-Signature + X-ADCP-Timestamp over
  // `${ts}.${raw_body_bytes}`.
  if (args.authentication?.type === 'hmac_sha256') {
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
  const signed = signWebhook(request, args.signerKey, args.tag !== undefined ? { tag: args.tag } : {});
  return { ...baseHeaders, ...signed.headers };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

async function resolveIdempotencyKey(
  store: WebhookIdempotencyKeyStore,
  operation_id: string,
  generate: () => string
): Promise<string> {
  const existing = await store.get(operation_id);
  if (existing) {
    if (!IDEMPOTENCY_KEY_PATTERN.test(existing)) {
      throw new Error(
        `idempotency-key store returned "${existing}" for operation_id "${operation_id}"; ` +
          `does not match required pattern ${IDEMPOTENCY_KEY_PATTERN.source}`
      );
    }
    return existing;
  }
  const fresh = generate();
  if (!IDEMPOTENCY_KEY_PATTERN.test(fresh)) {
    throw new Error(
      `generateIdempotencyKey produced "${fresh}" for operation_id "${operation_id}"; ` +
        `must match ${IDEMPOTENCY_KEY_PATTERN.source}`
    );
  }
  await store.set(operation_id, fresh);
  return fresh;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise(r => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
