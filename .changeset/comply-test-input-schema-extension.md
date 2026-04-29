---
'@adcp/sdk': minor
---

`ComplyControllerConfig.inputSchema` extension point. Adopters who route comply-test wiring through `createAdcpServerFromPlatform({ complyTest })` can now extend the canonical `TOOL_INPUT_SHAPE` with vendor fields (e.g., a top-level `account` field used for sandbox gating or tenant scoping) — matching the documented `{ ...TOOL_INPUT_SHAPE, account: ... }` pattern that was previously only reachable when wiring `registerTestController` directly. Storyboard fixtures sending top-level `account` (rather than `context.account`) are the canonical case. Adopter-supplied keys win on collision with canonical fields. Surfaced by training-agent v6 spike round 5 (Issue 5 / F10).
