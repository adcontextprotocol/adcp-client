# Three-gate CI test contract for `hello_*_adapter_*.ts` examples

Every worked-reference adapter in `examples/hello_*_adapter_*.ts` ships with a three-gate CI test that locks in **distinct regression classes**. The contract is implemented by `test/examples/_helpers/runHelloAdapterGates.js` and exercised by `test/examples/hello-*-adapter-*.test.js`.

This guide documents what each gate catches, how to adversarially validate the contract on a new adapter, and when to add a fourth gate.

## Why three independent gates

A single integration test that runs an adapter against a mock and checks the storyboard passes catches some regressions but not others. The three gates exist because three distinct classes of bug have surfaced repeatedly when the SDK or spec evolves:

| Gate                  | Catches                                                                                                | Misses (other gates catch these)                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **1. Strict tsc**     | Type errors at authorship: missing required fields, wrong asset_type discriminator, undefined narrowing | Logic errors that compile but produce wrong runtime behavior; façade regressions                   |
| **2. Storyboard run** | AdCP wire-shape regressions: missing required response fields, wrong status enum value, schema drift   | Type errors a strict tsc pass would catch sooner; façade regressions where wire shape happens to be valid |
| **3. Façade gate**    | Adapter returned a shape-valid response WITHOUT calling its upstream — i.e. it became a façade           | Type errors and wire-shape regressions both caught by gates 1 + 2 |

Together they make the example self-policing: a contributor (human or LLM) who modifies the example or the SDK in a way that breaks any of the three fails CI rather than escaping to a "looks fine" review.

## The three gates in detail

### Gate 1 — Strict tsc

```bash
npx tsc --noEmit examples/hello_<role>_adapter_<specialism>.ts \
  --target ES2022 --module commonjs --moduleResolution node \
  --esModuleInterop --skipLibCheck \
  --strict \
  --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes \
  --noImplicitOverride \
  --noFallthroughCasesInSwitch \
  --noPropertyAccessFromIndexSignature
```

Why these flags: the strictest realistic adopter config. `--strict` alone is table stakes; `--noUncheckedIndexedAccess` catches array-and-record dereferences without optional narrowing (`array[i]` becomes `T | undefined`); `--exactOptionalPropertyTypes` distinguishes `{ field: undefined }` from `{}` (catches the conditional-spread mistakes that pass `--strict`); `--noPropertyAccessFromIndexSignature` forces explicit access on index signatures.

What this gate catches: missing discriminator quartet on `Format.assets[]` (the `item_type: 'individual' as const` + `asset_id` + `asset_type` + `required` shape), `MediaBuyStatus` enum drift, `BuildCreativeReturn` 4-arm dispatch errors, and roughly half of the SHAPE-GOTCHAS.md catalogue at compile time.

### Gate 2 — Storyboard runner

```bash
node bin/adcp.js storyboard run http://127.0.0.1:<port>/mcp <storyboard_id> \
  --json --allow-http --auth <token> --webhook-receiver
```

Asserts `summary.steps_failed === 0` (with optional filter for cascade scenarios that need `comply_test_controller` wiring) and `overall_status !== 'failing'`.

What this gate catches: response shape regressions the runner's schema validator surfaces (missing required fields, wrong discriminator value, malformed `oneOf` arm), context echo regressions, idempotency-key misuse, async task envelope drift, and any AdCP wire-shape change introduced by an SDK upgrade that the example doesn't track.

### Gate 3 — Façade gate

```bash
curl http://127.0.0.1:<upstream_port>/_debug/traffic
```

Asserts every entry in `expectedRoutes[]` shows ≥1 hit. The mock-server bumps a per-route counter on every authenticated request; an adapter that returns a shape-valid response without calling its upstream produces zero counters and fails the assertion.

What this gate catches: the adapter went through the motions of returning a valid AdCP response but didn't actually exercise the upstream — a failure mode that's invisible to gates 1 and 2. Most common cause: an SDK refactor that bypassed a method, OR an LLM-modified adapter that "fixed" a tsc error by replacing an upstream call with a static value. Critical for matrix-blind-fixture work and for catching silent regressions during refactors.

## Adversarial validation

When you add a new adapter (or change one), validate the gates fire correctly by sabotaging one upstream call and confirming the right gate fails:

### Sabotage scenario: replace an upstream call with a static value

```ts
// Before (correct)
const cohorts = await upstream.listCohorts(operatorId);

// After (sabotaged)
const cohorts: UpstreamCohort[] = [];
```

Expected gate behavior:
- **Gate 1 (tsc) passes** — the type checker is fine with an empty array.
- **Gate 2 (storyboard) fails** — buyer queries `get_signals`, gets an empty `signals[]`, downstream cascade-skips assertions.
- **Gate 3 (façade) fails** — `GET /v2/cohorts` shows zero hits.

If gate 2 alone fails but gate 3 passes, the façade gate isn't load-bearing for that route — re-check `expectedRoutes[]`. If gate 1 catches it (type error on the empty literal), the upstream method's return type is too narrow — widen it.

### Sabotage scenario: remove a required response field

```ts
// Before (correct)
return {
  signals: filtered.map(toAdcpSignal),
};

// After (sabotaged) — drop the required `signals` field
return {} as GetSignalsResponse;
```

Expected gate behavior:
- **Gate 1 (tsc) fails** — `as` cast covers the static check, but if you drop the cast it fails.
- **Gate 2 (storyboard) fails** — schema validator surfaces missing required field.
- **Gate 3 (façade) passes** — upstream was called normally before the projection went wrong.

This pair confirms gate 2 catches things gate 1 doesn't (with the cast in place) and gate 3 doesn't catch.

## When to add a fourth gate

The three gates cover most regression classes. Add a fourth gate when there's an **adapter-specific invariant** the standard three don't cover:

- **`hello_signals_adapter_marketplace.test.js`** has a fourth gate for `BuyerAgentRegistry` — confirms unknown api-key tokens are rejected at the auth layer BEFORE reaching the registry. Specific to the registry-wired adapter; not a generic invariant.
- **A creative-ad-server adapter** (when it lands per #1381) might need a fourth gate that asserts `build_creative` returns a real serving tag, not a placeholder — separable from "storyboard pass" because the storyboard might assert presence but not content.
- **An adapter wiring `comply_test_controller`** would add a gate asserting the controller scenarios resolve correctly; orthogonal to the normal storyboard.

For adapter-specific gates, write them inline in the test file after `runHelloAdapterGates({...})` — same `describe()` parent, additional `it()` blocks. Don't extend the helper to support every per-adapter gate; some duplication is correct.

## Acceptance criteria for any new adapter

Per [`CONTRIBUTING.md`](../../CONTRIBUTING.md) "Adding a new specialism" — when contributing a new `hello_*_adapter_*.ts`, the test file MUST:

1. Use `runHelloAdapterGates()` from `test/examples/_helpers/`.
2. Pass all three gates locally (`node --test test/examples/hello-<role>-adapter-<specialism>.test.js`).
3. Have been adversarially validated: sabotage at least one upstream call AND one response field; confirm the right gates fail.
4. Run in under 30s wall time. The four shipping adapters take 4–18s each.

## Refs

- `test/examples/_helpers/runHelloAdapterGates.js` — implementation
- `examples/hello_seller_adapter_signal_marketplace.ts` first added the contract (PR #1274); locked in for the family in PR #1373
- `skills/SHAPE-GOTCHAS.md` — the wire-shape mistakes gate 1 catches at compile time and gate 2 at runtime
