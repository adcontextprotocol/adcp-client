---
'@adcp/sdk': minor
---

feat(mock-server+examples): SI storyboard passes — Nova Motors fixture + standard three-gate runner

Wires `examples/hello_si_adapter_brand.ts` (#1464) into the canonical
`adcp storyboard run si_baseline` compliance harness. The
`si_baseline` storyboard at
`compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`
now reports **3/3 scenarios pass** end-to-end against the SI mock
server (#1441) wrapped by the v6 SI platform adapter (#1454).

**Three changes:**

1. **Nova Motors fixture in the SI mock** (`brand_nova_motors`,
   `novamotors.example`, offering `novamotors_conversational_v1`).
   Matches the canonical compliance test-kit at
   `compliance/cache/latest/test-kits/nova-motors.yaml`. The SI mock
   now seeds three brands (Acme Outdoor, Summit Books, Nova Motors)
   so it's the canonical fixture for SI compliance runs without
   requiring a separate test-only mock.

2. **Adapter default switched to Nova Motors.** SI tool requests
   don't carry `account` on the wire (the schema omits it — session
   continuity flows through `session_id`), so
   `accounts.resolve(undefined)` falls back to a default brand.
   Previously `brand_acme_outdoor`; now `brand_nova_motors` to match
   the compliance fixture. Production agents are typically
   single-brand per deployment, so a hardcoded default is the right
   shape; multi-brand deployments derive from `ctx.authInfo`
   per-API-key binding.

3. **Top-level `offering_id` mirror on `SIGetOfferingResponse`.**
   The `si_baseline` storyboard's `context_outputs` capture uses
   `path: 'offering_id'` at the top level, but the canonical AdCP
   schema puts the id at `offering.offering_id`. Schema allows
   `additionalProperties: true` at the response root, so the
   adapter emits a top-level mirror to satisfy the storyboard's
   capture pattern. Filed upstream — once the storyboard's path is
   corrected to `offering.offering_id`, this mirror can be dropped.

**Test refactor.** `test/examples/hello-si-adapter-brand.test.js`
now uses `runHelloAdapterGates` (the standard three-gate helper used
by every other `hello_*_adapter_*.ts`) instead of its previous
hand-rolled MCP smoke test:

1. Strict tsc (`--strict --noUncheckedIndexedAccess
   --exactOptionalPropertyTypes
   --noPropertyAccessFromIndexSignature`)
2. `adcp storyboard run si_baseline` reports zero failed steps
3. Façade gate — every expected upstream route shows ≥1 hit at
   `/_debug/traffic`

This brings SI to parity with the four other `hello_*_adapter_*.ts`
examples — same gating shape, same regression contract.

**Mock-server tests** stay green (23/23) — the seed-data tests
assert mapping shape, not specific brand counts. The full server
suite remains green at 1158 tests; SI v6 platform tests at 7/7.

Refs adcontextprotocol/adcp#3961, #1441, #1454, #1464.
