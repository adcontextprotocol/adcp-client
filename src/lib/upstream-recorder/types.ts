/**
 * Public types for `@adcp/sdk/upstream-recorder`.
 *
 * Producer-side companion to the runner-output-contract v2.0.0
 * `upstream_traffic` storyboard check (spec PR adcontextprotocol/adcp#3816).
 * The recorder captures outbound HTTP calls an adapter makes during a
 * sandbox session and surfaces them to the adopter's
 * `comply_test_controller` `query_upstream_traffic` handler so storyboard
 * runners can verify side-effects against the adopter's real upstream
 * platform (the load-bearing anti-façade contract).
 *
 * Adopter-facing API. The recorder itself is sandbox-only — `enabled: false`
 * short-circuits every wrapping adapter to a pass-through.
 */

/**
 * Single recorded outbound HTTP call. Mirrors
 * `comply-test-controller-response.json > UpstreamTrafficSuccess.recorded_calls[]`
 * so adopter handlers can return query results verbatim.
 *
 * Redaction is applied at recording time, not query time, so the in-memory
 * buffer never holds plaintext secrets even briefly.
 */
export interface RecordedCall {
  method: string;
  /** Composed `<METHOD> <URL>` for `endpoint_pattern` matching. */
  endpoint: string;
  url: string;
  host: string;
  path: string;
  /**
   * Media type of the recorded `payload`, mirroring the adapter's outbound
   * `Content-Type` header. Required by the contract — runners use this to
   * pick the right matcher (JSONPath for JSON-shaped, substring fallback
   * for other types).
   */
  content_type: string;
  /** Decoded JSON object when content_type is JSON-shaped; raw string otherwise. */
  payload: unknown;
  timestamp: string;
  status_code?: number;
  /**
   * Optional classifier — set when the `purpose` callback was supplied.
   * Mirrors adcp#3830 item 3 (purpose tagging) so storyboards can scope
   * `endpoint_pattern` matching to platform-primary calls vs. measurement
   * vendors when the spec adopts that field.
   */
  purpose?: string;
}

/**
 * Optional classifier callback. Invoked at recording time on each call so
 * the recorder can stamp a `purpose` tag without the adopter wiring it
 * through their HTTP layer manually. Returning `undefined` leaves the
 * `purpose` field unset on the resulting `RecordedCall`.
 */
export type PurposeClassifier = (input: {
  method: string;
  url: string;
  host: string;
  path: string;
  /** Outbound headers (lowercased keys), with secrets already redacted. */
  headers: Record<string, string>;
}) => string | undefined;

/**
 * Configuration for `createUpstreamRecorder`. Every field is optional;
 * the defaults match the spec's recommended conformance posture.
 */
export interface UpstreamRecorderOptions {
  /**
   * Master switch. Defaults to `true`. Adopters MUST gate this against
   * their sandbox / non-production environment (e.g.
   * `enabled: process.env.NODE_ENV !== 'production'`). When `false`, the
   * factory returns a no-op recorder — `wrapFetch` returns the input fetch
   * unchanged, `record` is a no-op, `query` always returns empty results.
   * Zero overhead in production.
   */
  enabled?: boolean;
  /**
   * Override the canonical secret-key redaction pattern. Adopters MAY
   * extend the contract floor with internal vendor-specific keys. Adopters
   * MUST NOT narrow it — passing a pattern that omits a contract-required
   * key is a security regression.
   */
  redactPattern?: RegExp;
  /**
   * Maximum recorded calls retained in the buffer (across all principals).
   * Defaults to 1000. When the buffer is full, the oldest entry is evicted
   * before recording the new call. Storyboards generally exercise tens of
   * calls per assertion window — 1000 is a safe upper bound for a single
   * sandbox session.
   */
  bufferSize?: number;
  /**
   * Time-to-live for recorded calls, in milliseconds. Defaults to 1 hour.
   * Calls older than `ttlMs` at query time are excluded from results AND
   * pruned eagerly on the next record. Bounds the buffer's exposure
   * window — a stale recorder shouldn't surface yesterday's traffic on
   * today's compliance run.
   */
  ttlMs?: number;
  /**
   * Optional classifier — see `PurposeClassifier`. Invoked on every record
   * with the redacted-headers view of the outbound call.
   */
  purpose?: PurposeClassifier;
}

/**
 * Parameters accepted by `recorder.query`. Mirrors the
 * `query_upstream_traffic` controller scenario shape so the adopter can
 * pass-through their controller request directly.
 */
export interface UpstreamRecorderQueryParams {
  /**
   * Caller principal — REQUIRED. Cross-principal isolation is the spec's
   * security HIGH requirement: a controller call from principal A MUST NOT
   * surface principal B's traffic. Adopters resolve this from their auth
   * context (e.g., the `account` block on the controller request, or the
   * adopter's session principal).
   */
  principal: string;
  /**
   * ISO 8601 timestamp lower bound. Only calls recorded at or after this
   * time are returned. The runner subtracts a 250 ms clock-skew tolerance
   * before sending the bound — adopter MAY also widen the window if it
   * knows its own clock drifts.
   */
  sinceTimestamp?: string;
  /**
   * Glob pattern matched against `<METHOD> <URL>` (i.e. `endpoint`). `*`
   * matches zero-or-more characters of any kind including `/`; all other
   * characters are literal. Adopter-side filter — equivalent to filtering
   * on the runner side after the response, but reduces response size.
   */
  endpointPattern?: string;
  /**
   * Maximum recorded calls to return. Defaults to 100, capped at the
   * buffer size. When the un-capped result would have exceeded `limit`,
   * `truncated: true` is set on the response so the runner can detect
   * overflow.
   */
  limit?: number;
}

/**
 * Result of `recorder.query`. Maps directly onto the
 * `UpstreamTrafficSuccess` controller-response branch — adopters can
 * return this verbatim from their `query_upstream_traffic` handler.
 */
export interface UpstreamRecorderQueryResult {
  /** Calls matching all filters, ordered by `timestamp` ascending. */
  items: RecordedCall[];
  /**
   * Total count BEFORE `limit` truncation. `items.length` may be smaller
   * when limit clipped the result.
   */
  total: number;
  /** True when `total > items.length`. */
  truncated: boolean;
  /**
   * Echo of the requested `sinceTimestamp` (or the recorder-substituted
   * default — the earliest record retained in the buffer when no
   * `sinceTimestamp` was passed). Lets the runner verify the controller
   * honored the bound.
   */
  since_timestamp: string;
}

/**
 * Public recorder surface. Adopters get one of these from
 * `createUpstreamRecorder(options)`.
 */
export interface UpstreamRecorder {
  /**
   * Run `fn` with `principal` bound as the active recording principal.
   * Every wrapped HTTP call inside `fn` (including async tasks awaited
   * inside) records under that principal. Implemented via
   * AsyncLocalStorage — context propagates across `await` boundaries the
   * same way Node's stack trace does, so most adopters won't need to
   * thread the principal through their HTTP call sites manually.
   *
   * Re-entrant — nested `runWithPrincipal` calls override the parent's
   * principal for their inner scope only.
   */
  runWithPrincipal<T>(principal: string, fn: () => T | Promise<T>): Promise<T>;
  /**
   * Wrap a fetch implementation so calls inside `runWithPrincipal` flow
   * through this recorder. Returns a fetch with the same signature; the
   * wrapper is a pass-through when the recorder is `enabled: false` or
   * when no principal is active. Drop the wrapped fetch into your HTTP
   * layer (e.g. `globalThis.fetch = recorder.wrapFetch(globalThis.fetch)`)
   * or pass it explicitly to your HTTP client constructor.
   */
  wrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch;
  /**
   * Manually record a call. Escape hatch for adopters with custom
   * transports the recorder doesn't ship a wrapper for. The principal
   * is read from the active `runWithPrincipal` scope unless explicitly
   * passed. Redaction + timestamp + purpose tagging still apply.
   */
  record(call: RecordInput, principal?: string): void;
  /**
   * Return recorded calls scoped to the requesting principal, filtered by
   * `sinceTimestamp` and `endpointPattern`, and truncated to `limit`.
   * Adopters typically pass the result verbatim into their
   * `comply_test_controller`'s `query_upstream_traffic` response.
   */
  query(params: UpstreamRecorderQueryParams): UpstreamRecorderQueryResult;
  /**
   * Drop every recorded call. Test cleanup helper — production code
   * should rely on TTL eviction instead.
   */
  clear(): void;
  /** Reflect the configured `enabled` flag — useful for adopter assertions. */
  readonly enabled: boolean;
}

/**
 * Input shape for `recorder.record` / the wrapped fetch's internal call.
 * The recorder fills in `timestamp` and (optionally) `purpose` itself; the
 * caller supplies the wire-shape facts.
 */
export interface RecordInput {
  method: string;
  url: string;
  /**
   * Outbound `Content-Type` header value, mirrored verbatim onto
   * `RecordedCall.content_type`. Required because the runner's matcher
   * choice depends on it.
   */
  content_type: string;
  /**
   * Outbound headers — used by the redactor and the purpose classifier.
   * Keys are normalized to lowercase before redaction; values pass
   * through if not on a secret-shaped key.
   */
  headers?: Record<string, string>;
  /**
   * Outbound request body. Object when JSON-decodable (recorder will
   * apply per-key redaction); string for non-JSON (recorder applies
   * length-cap only). Pass `undefined` for GET / HEAD / DELETE without
   * a body.
   */
  payload?: unknown;
  /**
   * HTTP status code of the upstream response, when known. Adapters
   * MAY omit this for fire-and-forget calls instrumented before the
   * response arrives.
   */
  status_code?: number;
}
