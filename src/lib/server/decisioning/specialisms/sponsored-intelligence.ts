/**
 * SponsoredIntelligencePlatform — brand-agent specialism interface (v6.0,
 * protocol-keyed).
 *
 * AdCP 3.0 declares Sponsored Intelligence as a *protocol*
 * (`supported_protocols: ['sponsored_intelligence']`), not a specialism.
 * The platform field is therefore required IFF the agent declares the
 * protocol — see `RequiredPlatformsForProtocols` in `../platform.ts` and
 * the protocol-keyed branch of the dispatch validator. When AdCP 3.1 adds
 * `'sponsored-intelligence'` to `AdCPSpecialism` (tracked at
 * adcontextprotocol/adcp#3961), specialism-keyed dispatch becomes additive
 * — this interface keeps working unchanged.
 *
 * Surface: four wire tools — `si_get_offering`, `si_initiate_session`,
 * `si_send_message`, `si_terminate_session`. Maps directly onto the v5
 * `SponsoredIntelligenceHandlers` handler-bag in
 * `../../create-adcp-server.ts`; the v6 platform shape adds auto-hydrated
 * session state via `ctx.store` (resource kind `'si_session'`) so
 * `sendMessage` / `terminateSession` see the brand's stored session
 * record without manual store calls.
 *
 * Async story: all four operations are sync at the wire level —
 * `SISendMessageResponse` has no `Submitted` arm. Long-running brand-side
 * generation (LLM inference, voice synthesis, A2UI surface assembly) is
 * absorbed within the request. Status changes between turns flow via the
 * conversational transcript itself, not via `publishStatusChange`.
 *
 * Idempotency: `initiateSession` and `sendMessage` carry
 * `idempotency_key`; the framework dispatches replays through your
 * implementation, so handle replay-safety per the spec
 * (`SISendMessageRequest.idempotency_key` documents at-most-once
 * execution semantics). `terminateSession` is naturally idempotent on
 * `session_id` and intentionally lacks an `idempotency_key`.
 *
 * Status: Preview / 6.x. Behavior frozen on AdCP 3.0 SI surface.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
} from '../../../types/tools.generated';

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export interface SponsoredIntelligencePlatform<TCtxMeta = Record<string, unknown>> {
  /**
   * Offering lookup. Sync — return offering metadata, availability, and
   * (when `include_products` is true) up to `product_limit` matching
   * products. Mint an `offering_token` so the brand can recall the
   * products-shown record on a subsequent `initiateSession` for natural
   * back-references like "the second one."
   *
   * Throw `AdcpError` for buyer-fixable rejection:
   *   - `'NOT_FOUND'` — unknown `offering_id`
   *   - `'EXPIRED'` — offering past its `expires_at`
   *   - `'REGION_RESTRICTED'` — offering not available in caller's region
   */
  getOffering(req: SIGetOfferingRequest, ctx: Ctx<TCtxMeta>): Promise<SIGetOfferingResponse>;

  /**
   * Start a session. Returns `session_id` plus the brand's first response
   * turn. The framework auto-stores the resulting session record under
   * `ctx.store` keyed on `session_id` (resource kind `'si_session'`) so
   * subsequent `sendMessage` / `terminateSession` calls receive a
   * hydrated `req.session` without a manual `ctx.store.get`.
   *
   * Carries `idempotency_key` — replays must return the same response.
   * The framework's idempotency middleware handles wire-level replay; your
   * implementation is responsible for preserving session-creation
   * semantics on internal retries.
   *
   * Throw `AdcpError` for buyer-fixable rejection:
   *   - `'OFFERING_TOKEN_EXPIRED'` — token from `getOffering` past its TTL
   *   - `'CONSENT_REQUIRED'` — brand requires `identity.consent_granted`
   *   - `'CAPABILITY_UNSUPPORTED'` — host advertised capabilities the
   *     brand cannot fulfill (rare; usually downgrades silently)
   */
  initiateSession(req: SIInitiateSessionRequest, ctx: Ctx<TCtxMeta>): Promise<SIInitiateSessionResponse>;

  /**
   * Send a turn. The session record is auto-hydrated onto `ctx` from
   * `ctx.store` keyed on `req.session_id` before this method runs;
   * implementations read transcript context from there rather than
   * replaying from the wire. Returns the brand's response turn including
   * any `ui_elements` / `surface` and an optional `handoff` block when
   * the conversation reaches a natural close.
   *
   * Carries `idempotency_key` — each turn is a transcript mutation, so
   * replays MUST return the same assistant response rather than emitting
   * a fresh model call.
   *
   * Throw `AdcpError` for buyer-fixable rejection:
   *   - `'SESSION_NOT_FOUND'` — unknown `session_id`
   *   - `'SESSION_CLOSED'` — session already terminated
   *   - `'SESSION_TIMEOUT'` — exceeded `session_ttl_seconds` since last
   *     turn (brand may also auto-terminate via `host_terminated`)
   */
  sendMessage(req: SISendMessageRequest, ctx: Ctx<TCtxMeta>): Promise<SISendMessageResponse>;

  /**
   * Terminate a session. Naturally idempotent — `session_id` is the
   * dedup boundary; AdCP intentionally omits `idempotency_key` on this
   * request. Re-terminating a closed session MUST return the same
   * payload, including any `acp_handoff` block from the original close.
   *
   * When `req.reason` is `handoff_transaction`, the response carries
   * `acp_handoff` with `checkout_url`, `checkout_token`, and
   * `expires_at` for the host to launch ACP checkout.
   *
   * Throw `AdcpError` for buyer-fixable rejection:
   *   - `'SESSION_NOT_FOUND'` — unknown `session_id`
   */
  terminateSession(req: SITerminateSessionRequest, ctx: Ctx<TCtxMeta>): Promise<SITerminateSessionResponse>;
}
