---
'@adcp/sdk': minor
---

feat(server): SponsoredIntelligencePlatform — v6 protocol-keyed dispatch shape for SI

Adds `SponsoredIntelligencePlatform<TCtxMeta>` to the v6
`DecisioningPlatform` config — adopters now wire SI through the v6
platform shape with auto-hydrated session state, parity with how every
other specialism (signals, sales, creative, governance, brand-rights)
already works. Replaces the v5 `SponsoredIntelligenceHandlers` handler-
bag as the recommended path, but keeps the v5 escape hatch working for
in-flight adopters.

**Why protocol-keyed and not specialism-keyed.** AdCP 3.0 declares SI as a
*protocol* (`supported_protocols: ['sponsored_intelligence']`), not a
*specialism* — `'sponsored-intelligence'` is absent from
`AdCPSpecialism`. Tracked upstream at adcontextprotocol/adcp#3961
(targeted at 3.1). Rather than wait or invent local-only behavior, this
release dispatches off the SDK's `platform.sponsoredIntelligence` field
itself: presence triggers SI tool registration, which the existing
`detectProtocols` derivation picks up to emit `'sponsored_intelligence'`
in the wire-side `supported_protocols`. When 3.1 promotes SI to a
specialism, dispatch becomes additive — adopters can claim either form
without code changes.

**The four method surface** (`src/lib/server/decisioning/specialisms/sponsored-intelligence.ts`):

```ts
interface SponsoredIntelligencePlatform<TCtxMeta = Record<string, unknown>> {
  getOffering(req: SIGetOfferingRequest, ctx): Promise<SIGetOfferingResponse>;
  initiateSession(req: SIInitiateSessionRequest, ctx): Promise<SIInitiateSessionResponse>;
  sendMessage(req: SISendMessageRequest, ctx): Promise<SISendMessageResponse>;
  terminateSession(req: SITerminateSessionRequest, ctx): Promise<SITerminateSessionResponse>;
}
```

**Auto-hydrated session state.** `initiateSession` returns trigger an
auto-store under `ResourceKind: 'si_session'` keyed on the response's
`session_id`. Subsequent `sendMessage` / `terminateSession` calls hit the
schema-driven hydrator (already declared in `entity-hydration.generated.ts`
for `si_send_message.session_id` and `si_terminate_session.session_id`)
which attaches the stored record at `req.session`. Platform implementations
read transcript context from `req.session` rather than threading manual
`ctx.store.get` calls — same ergonomics as `req.media_buy` /
`req.signal` / `req.rights_grant` on the other specialisms.

The stored payload preserves the bits a brand engine needs to resume
context across turns: request-side scoping (`intent`, `offering_id`,
`offering_token`, `placement`, `media_buy_id`, `identity` consent
state, `supported_capabilities`) and response-side state
(`negotiated_capabilities`, `session_status`, `session_ttl_seconds`).
On `terminateSession`, the framework also persists `acp_handoff`,
`session_status: 'terminated'`, `follow_up`, and `terminated` onto
the same record so the spec's "re-terminating a closed session
returns the same payload" idempotency contract is honored without
adopters having to write through manually.

**Important caveat on `req.session`.** The auto-store + hydration
covers the small fixture / mock case and the lookup-the-original-
context case (e.g., "what offering did this session resolve to?").
Production brand engines almost always own full transcript state in
their own backend (Postgres, Redis, vector store) — full transcripts,
RAG embeddings, tool-call logs are too rich for `ctx_metadata` and
easily exceed the 16KB blob cap. Treat `req.session` as a
convenience, not authoritative state — resolve full transcript state
from your own session store keyed by `req.session_id`. Documented
explicitly in the platform interface JSDoc.

**Type-level helper for forward compat.**
`RequiredPlatformsForProtocols<P>` parallels the existing
`RequiredPlatformsFor<S>`. Currently kept `@internal` (not exported) —
there is no constraint site consuming it today (no `supported_protocols`
field on `DecisioningCapabilities`, no wired
`createAdcpServer<P>` signature). Lands now so the type sits next to
the platform field for future wiring; promotion to public happens when
either AdCP 3.1 adds SI to `AdCPSpecialism` (at which point this folds
into `RequiredPlatformsFor`) or `DecisioningCapabilities` grows an
explicit `supported_protocols` declaration field. Adopters needing
compile-time gating today can constrain `platform: P & {
sponsoredIntelligence: SponsoredIntelligencePlatform }` directly at
the call site.

**Wire changes:**

- `ResourceKind` gains `'si_session'`. `'si_session'` removed from
  `INTENTIONALLY_UNHYDRATED_ENTITIES` since the framework now hydrates
  it. `ENTITY_TO_RESOURCE_KIND` gains `si_session: 'si_session'`.
- `'offering'` stays in `INTENTIONALLY_UNHYDRATED_ENTITIES` — the SI
  spec uses `offering_token` (a brand-side correlation primitive) for
  offering→session continuity, which doesn't map cleanly to the
  framework's resource-kind hydration.

**v5 path unchanged.** The existing v5 `SponsoredIntelligenceHandlers`
handler-bag (`src/lib/server/create-adcp-server.ts:855`) keeps working
exactly as before; adopters using `createAdcpServer({
sponsoredIntelligence: { getOffering, initiateSession, sendMessage,
terminateSession } })` see no behavior change. The v6 platform path
adapts onto the same dispatcher slot via `buildSponsoredIntelligenceHandlers`
in `from-platform.ts`, mirroring how `buildSignalsHandlers` adapts
`SignalsPlatform` onto `SignalsHandlers`.

**Tests.** New `test/server-si-platform.test.js` covers the v6 surface
end-to-end:

- All four SI tools register when `platform.sponsoredIntelligence` is
  present
- `'sponsored_intelligence'` appears in `get_adcp_capabilities.supported_protocols`
- `initiateSession` auto-stores session record; `sendMessage` receives
  hydrated `req.session` with original intent / offering_id /
  negotiated_capabilities / session_status / session_ttl_seconds
- `terminateSession` receives the same hydrated `req.session`
- No SI tools register when the platform field is absent

5 tests, all passing. Full `test/server-*.test.js` suite remains green
(1171 tests).

**Tool-name reconciliation.** Stale tool names in
`protocol-for-tool.ts:30-33` (`si_end_session` / `si_get_session` —
which never matched the spec) corrected to the canonical
`si_terminate_session` / `si_get_offering`, and `si_get_offering`
added (it was missing from the protocol-routing map). Cosmetic for
v6 dispatch (which keys off platform field, not this map) but
load-bearing for any telemetry / diagnostics that look up
protocol-by-tool-name.

**Tracking.** Refs adcontextprotocol/adcp#3961 (spec — `sponsored-intelligence`
in `AdCPSpecialism` for 3.1).

**Follow-up release blocker.** `examples/hello_si_adapter_brand.ts`
driving the `mock-server sponsored-intelligence` fixture through this
v6 platform lands separately and ships in the same release window —
not a slip-able item. SI is the most foreign specialism in the
catalog (host↔brand handoff, ACP checkout, surface/ui_elements,
identity consent gating), so the surface without a worked example
will get adopted incorrectly.
