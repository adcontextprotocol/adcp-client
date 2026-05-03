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
context across turns: original `intent`, `offering_id`, `offering_token`,
`identity` (consent state), `negotiated_capabilities`, `session_status`,
`session_ttl_seconds`.

**Type-level helper for forward compat.**
`RequiredPlatformsForProtocols<P>` parallels the existing
`RequiredPlatformsFor<S>`. Currently the only entry is
`'sponsored_intelligence'` → `{ sponsoredIntelligence:
SponsoredIntelligencePlatform }`. Available for adopters who want
explicit compile-time enforcement; not yet wired into
`createAdcpServer<P>`'s constraint signature (would require
`supported_protocols` to be a declared field on `DecisioningCapabilities`
rather than auto-derived — that's a separate design decision deferred
to 3.1 alignment).

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

**Tracking.** Refs adcontextprotocol/adcp#3961 (spec — `sponsored-intelligence`
in `AdCPSpecialism` for 3.1).

**Follow-ups.** `examples/hello_si_adapter_brand.ts` driving the
`mock-server sponsored-intelligence` fixture through this v6 platform
lands separately. The known stale tool-name drift in
`protocol-for-tool.ts:30-33` (`si_end_session` / `si_get_session` vs.
canonical `si_terminate_session` / `si_get_offering`) is a pre-existing
bug worth addressing in a focused branch.
