/**
 * `@adcp/sdk/upstream-recorder` — producer-side reference middleware.
 *
 * Adopters who want to opt into the AdCP `upstream_traffic` storyboard
 * check (spec PR adcontextprotocol/adcp#3816) need to record their
 * outbound HTTP calls in a session-scoped buffer and surface them to
 * storyboard runners via their `comply_test_controller`'s
 * `query_upstream_traffic` scenario. This module is the recording
 * primitive: a small, sandbox-only-by-default helper that wraps the
 * adapter's HTTP layer, applies redaction at recording time (so
 * plaintext secrets never sit in the buffer in memory), enforces
 * per-principal isolation (the spec's security HIGH requirement), and
 * exposes a `query()` method that maps directly onto the controller's
 * `UpstreamTrafficSuccess` response shape.
 *
 * Minimal adopter wire-up:
 *
 * ```ts
 * import { createUpstreamRecorder } from '@adcp/sdk/upstream-recorder';
 *
 * const recorder = createUpstreamRecorder({
 *   enabled: process.env.NODE_ENV !== 'production',
 * });
 *
 * // 1. Wrap whatever HTTP client your adapter uses
 * const fetch = recorder.wrapFetch(globalThis.fetch);
 *
 * // 2. At your AdCP request handler boundary, scope every outbound call
 * //    inside the handler to the resolving principal:
 * await recorder.runWithPrincipal(account.id, async () => {
 *   await syncAudienceUpstream(...);  // every fetch() inside is recorded
 * });
 *
 * // 3. In your `comply_test_controller` handler for scenario:
 * //    `query_upstream_traffic`, return the recorder's query result
 * //    verbatim:
 * function handleQueryUpstreamTraffic(req, principal) {
 *   const { items, total, truncated, since_timestamp } = recorder.query({
 *     principal,
 *     sinceTimestamp: req.params.since_timestamp,
 *     endpointPattern: req.params.endpoint_pattern,
 *     limit: req.params.limit,
 *   });
 *   return { success: true, recorded_calls: items, total_count: total, truncated, since_timestamp };
 * }
 * ```
 *
 * Production builds with `enabled: false` get a no-op recorder — every
 * method is a pass-through / empty-result, zero per-call overhead.
 *
 * Companion to issue adcp-client#1290; runner-side consumer is
 * `@adcp/sdk`'s storyboard runner (PR adcp-client#1289).
 */

export { createUpstreamRecorder, toQueryUpstreamTrafficResponse } from './recorder';
export { UpstreamRecorderScopeError } from './types';
export type {
  PurposeClassifier,
  QueryUpstreamTrafficResponse,
  RecordInput,
  RecordedCall,
  UpstreamRecorder,
  UpstreamRecorderDebugInfo,
  UpstreamRecorderErrorEvent,
  UpstreamRecorderOptions,
  UpstreamRecorderQueryParams,
  UpstreamRecorderQueryResult,
} from './types';
