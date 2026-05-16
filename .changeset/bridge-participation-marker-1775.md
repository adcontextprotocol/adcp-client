---
'@adcp/sdk': minor
---

feat(testing): stamp `_bridge` marker on responses augmented by the test-controller bridge (#1775)

When the `TestControllerBridge` merges seeded fixtures into a handler response, the framework now stamps a non-normative `_bridge: { callback, tool, merged_count }` field on `structuredContent` (mirrored to `content[0].text` when that body is JSON). This is the runner-visible signal that distinguishes _"this pass exercised the adopter's adapter against upstream"_ from _"this pass exercised wire conformance against fixture data merged by the SDK"_. Storyboard runners and compliance leaderboards read the marker to attribute bridge participation in run records — without it, a green storyboard step through fixture-merge reads identically to one that ran through a real adapter (the gap that widens fastest for walled-garden proxies, where it matters most).

Coverage: every bridge dispatch site emits the marker per-tool with the originating callback name, so runners can attribute participation at the `getSeededCreatives` / `getSeededMediaBuys` / etc. granularity — 19 sites across 16 callbacks (list + get pairs for `property_lists`, `collection_lists`, `content_standards` count twice). Append-merge tools stamp when the callback returned ≥ 1 valid entry; singleton-replace tools (`get_account_financials`, `get_brand_identity`, `si_get_offering`, `get_property_list`, `get_collection_list`, `get_content_standards`) stamp only when a seeded fixture actually matched the request id and replaced the handler payload. Marker absent on non-sandbox traffic and when the callback is omitted.

Schema safety: AdCP 3.0 response envelopes all set `additionalProperties: true` on the top level (verified across the 13 bridge-touching response schemas), and the underscore prefix advertises "internal / out-of-spec" to validators that round-trip unknown fields. The marker mirrors the established `stampReplayed` pattern (envelope + opportunistic text-body JSON mirror) so adopters who consume the L2 text body see the same envelope MCP does.

The new `BridgeMarker` type is exported from `src/lib/server/create-adcp-server.ts` for adopters who want to type-check marker reads. Public docs in [`docs/guides/VALIDATE-YOUR-AGENT.md`](./docs/guides/VALIDATE-YOUR-AGENT.md) explain how to interpret a bridge-augmented pass: wire conformance against fixture data, _not_ adapter-against-upstream health. Pair the conformance suite with a separate live-OAuth run before promoting an adapter to production.

Also drops three unreachable duplicate dispatch blocks (`get_brand_identity`, `get_rights`, `si_get_offering`) that were appended below the canonical chain — dead code in a continuous `else if` chain. No behavior change; only the first block ever fired.

Cross-repo coordination: the storyboard runner surfacing of this marker lives in [`adcontextprotocol/adcp`](https://github.com/adcontextprotocol/adcp); the leaderboard policy that consumes it is tracked in [`adcp-client#1782`](https://github.com/adcontextprotocol/adcp-client/issues/1782). The SDK side ships the signal; the consumer side is half of the contract and must follow.
