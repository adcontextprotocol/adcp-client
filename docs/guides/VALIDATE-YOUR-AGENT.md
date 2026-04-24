# Validate Your Agent

Your checklist to get from "agent boots" to "agent ships." Every tool below is already in `@adcp/client`; this page tells you which one runs when, what it catches, and how to read the output.

## TL;DR — five commands, roughly in order

```bash
# 1. Does it answer at all? (60s)
npx @adcp/client@latest http://localhost:3001/mcp get_adcp_capabilities '{}'

# 2. Does it walk the golden path? (2–5 min)
npx @adcp/client@latest storyboard run http://localhost:3001/mcp --auth $TOKEN

# 3. Does it crash on weird inputs? (1–3 min)
npx @adcp/client@latest fuzz http://localhost:3001/mcp --auth-token $TOKEN

# 4. Does webhook/async conformance pass? (2–5 min)
npx @adcp/client@latest storyboard run http://localhost:3001/mcp \
  --webhook-receiver --auth $TOKEN

# 5. Does it survive horizontal scaling? (same as 2, two URLs)
npx @adcp/client@latest storyboard run \
  --url https://a.agent.example/mcp --url https://b.agent.example/mcp \
  sales-guaranteed --auth $TOKEN
```

If all five pass and your skill's specialism-specific checks below pass, you're conformant. The rest of this page explains why each check exists and how to debug failures.

**Working on the agent locally?** Before you reach for the remote-agent commands above, see [`VALIDATE-LOCALLY.md`](./VALIDATE-LOCALLY.md) — the same storyboards, zero tunnel setup, ten lines of code. Point `--local-agent <module>` at your handlers or call `runAgainstLocalAgent` directly from a test file.

**Why `@latest` in every `npx` command?** Without the pin, `npx` reuses whatever version happens to be cached in `~/.npm/_npx/` — and it never re-checks. If you ran `npx @adcp/client` six months ago, you're still on that version today. `npx @adcp/client@latest` forces npx to resolve the `latest` dist-tag against the registry on every run. If an old cache is causing confusing behavior, `rm -rf ~/.npm/_npx` clears all cached CLI versions.

---

## What catches what

| Command | What it catches | Run when |
|---|---|---|
| `adcp storyboard run` | Missing tools, broken happy-path flows, state leaks, validation drift, capability-vs-behavior mismatch | Every commit |
| `adcp fuzz` | Crashes on edge-case inputs, 500s instead of typed errors, schema drift, shape bugs your storyboards don't exercise | Before PR merge |
| `--webhook-receiver` | Unsigned webhooks, unstable `idempotency_key` across retries, missing HMAC/RFC 9421 headers | When you add webhook emission |
| `--url --url ...` (multi-instance) | `(brand, account)`-scoped state stored per-process instead of in a shared backing store | Before production deploy |
| `adcp grade request-signing` | RFC 9421 signature verification bugs if you claim `signed-requests` | If you claim `signed-requests` |
| `runConformance({ autoSeed: true })` | Tier-3 update-tool bugs with real IDs (not just random-rejection paths) | Against a sandbox tenant |
| Schema validation hooks | Field-name drift, enum drift, missing required fields — caught at dev time, not runtime | In your dev/test harness |

Each row is a different failure mode. Passing storyboard and failing fuzz is common — storyboards walk happy paths, fuzz walks rejection paths.

---

## Command reference

### `adcp storyboard run` — capability-driven assessment

The main compliance entry point. Runs every storyboard that applies to your agent based on its declared `get_adcp_capabilities` output.

```bash
# Full capability-driven run — resolves bundles from your capabilities
npx @adcp/client@latest storyboard run http://localhost:3001/mcp --auth $TOKEN

# Single bundle or storyboard by id
npx @adcp/client@latest storyboard run http://localhost:3001/mcp sales-guaranteed --auth $TOKEN

# Specific tracks only (faster feedback when iterating)
npx @adcp/client@latest storyboard run http://localhost:3001/mcp --tracks core,products --auth $TOKEN

# Ad-hoc YAML (new storyboards under development)
npx @adcp/client@latest storyboard run http://localhost:3001/mcp --file ./my-wip.yaml --auth $TOKEN

# JSON report for CI / tooling
npx @adcp/client@latest storyboard run http://localhost:3001/mcp --json > report.json
```

**Flags you'll actually use:**

- `--tracks <a,b,c>` — limit to named tracks (e.g., `core,products,security_baseline`)
- `--storyboards <id1,id2>` — limit to specific storyboard IDs
- `--webhook-receiver [loopback|proxy]` — host a webhook sink so async steps grade instead of skip
- `--webhook-receiver-auto-tunnel` — autodetect `ngrok`/`cloudflared` on `PATH`, spawn and plug into proxy mode
- `--invariants <mod1,mod2>` — load custom cross-step assertion modules
- `--multi-instance-strategy round-robin|multi-pass` — when paired with two or more `--url`s
- `--brief <text>` — custom product-discovery brief (default varies by storyboard)
- `--auth <token>` — bearer token (also accepts `$ADCP_AUTH_TOKEN`)
- `--oauth` — run the browser OAuth flow inline when the saved alias has no valid tokens (MCP only; equivalent to `adcp --save-auth <alias> <url> --oauth` then re-running)

**OAuth-protected agents.** Storyboard runs reuse tokens saved under an alias. Two supported flows:

```bash
# (a) pre-save tokens
npx @adcp/client@latest --save-auth my-agent https://agent.example.com/mcp --oauth
npx @adcp/client@latest storyboard run my-agent

# (b) inline on first run
npx @adcp/client@latest --save-auth my-agent https://agent.example.com/mcp --no-auth
npx @adcp/client@latest storyboard run my-agent --oauth
```

Either way, subsequent runs reuse the cached tokens (auto-refresh on expiry via the stored `refresh_token`). Raw URLs don't support `--oauth` — save an alias first.

**CI.** `--oauth` needs a browser. In CI, save tokens once locally, ship `~/.adcp/agents.json` to the runner, and drop the `--oauth` flag from the CI command — the stored `refresh_token` auto-renews on 401.

**Output:** JSON with `tracks[].status` (`passed`/`failed`/`skipped`), `steps[]` with diagnostics, and validations per step.

### `adcp fuzz` — property-based schema fuzzing

Generates schema-valid requests, calls your agent, checks every response under the two-path oracle (schema-valid success *or* well-formed AdCP error envelope with uppercase reason code). Anything else — 500, stack traces, lowercase error codes, token leaks — fails.

```bash
# Tier 1 + Tier 2 stateless + referential (safe, no mutation)
npx @adcp/client@latest fuzz http://localhost:3001/mcp --auth-token $TOKEN

# Reproducible (rerun with same seed to repro a failure)
npx @adcp/client@latest fuzz http://localhost:3001/mcp --seed 42 --auth-token $TOKEN

# Pre-seeded ID pools for referential tools (Tier 2)
npx @adcp/client@latest fuzz http://localhost:3001/mcp \
  --fixture creative_ids=cre_a,cre_b \
  --fixture media_buy_ids=mb_1

# Auto-seed + Tier 3 update-tool fuzzing (mutates agent state — SANDBOX ONLY)
npx @adcp/client@latest fuzz http://localhost:3001/mcp --auto-seed --auth-token $TOKEN

# Uniform-error-response invariant in full cross-tenant mode
npx @adcp/client@latest fuzz http://localhost:3001/mcp \
  --auto-seed \
  --auth-token            $TENANT_A_TOKEN \
  --auth-token-cross-tenant $TENANT_B_TOKEN

# Inspect the tool list + tier classification
npx @adcp/client@latest fuzz --list-tools
```

See [`docs/guides/CONFORMANCE.md`](./CONFORMANCE.md) for the fixture map, tier-by-tier tool list, and failure interpretation.

#### Uniform-error-response invariant (paired probe)

`adcp fuzz` also runs a paired-probe invariant per AdCP spec § error-handling — the MUST that "the id exists but the caller lacks access" and "the id does not exist" produce byte-equivalent responses across every observable channel. Distinguishing the two leaks cross-tenant existence information.

Two modes, picked automatically:

- **Baseline** (default — single token): two fresh UUIDs probed at the same tool. Catches id-echo in error bodies, header divergence outside the narrow allowlist, MCP `isError` / A2A `task.status.state` divergence, and gross latency delta. Runs with zero extra config.
- **Cross-tenant** (two tokens): seeds a resource as tenant A (via `--auto-seed` or explicit `--fixture`), then probes as tenant B against tenant A's seeded id plus a fresh UUID. Catches everything baseline catches plus the cross-tenant existence leak itself. Triggered by `--auth-token-cross-tenant`.

What the comparator enforces:

- `error.code`, `error.message`, `error.field`, `error.details` identical
- HTTP status identical
- A2A `task.status.state` / MCP `isError` identical
- Response headers identical — **closed allowlist** of headers that MAY differ: `Date`, `Server`, `X-Request-Id`, `X-Correlation-Id`, `X-Trace-Id`, `Traceparent`, `Tracestate`. Everything else (`ETag`, `Cache-Control`, any `X-RateLimit-*`, CDN-tag headers, etc.) MUST match.

What to fix when it fails:

- **`error.code diverges`** — you're returning `PERMISSION_DENIED` (or similar) when the caller lacks access but `REFERENCE_NOT_FOUND` when the id doesn't exist. Collapse to one code — return `REFERENCE_NOT_FOUND` on both paths regardless of whether the id resolved before the access check.
- **`error.details diverges`** — you're echoing the probed id back in `details` (e.g., `details.looked_up = <uuid>`). Drop it or set it to a fixed token like `details.id_class = 'unresolvable'`.
- **`header "etag" diverges` / `header "cache-control" diverges`** — your cache layer is keyed on resolution success. Disable caching on the error path, or ensure the response envelope is constructed identically regardless of resolution state.
- **`MCP isError diverges`** — one path returns `isError: true`, the other doesn't. Both paths are errors; both MUST set `isError`.

**Tool coverage today**: `get_property_list`, `get_content_standards`, `get_media_buy_delivery`. The invariant runs whenever one of these appears in the fuzz tool set (the default). Extending to more referential tools is additive — see `src/lib/conformance/invariants/uniformError.ts` `TOOL_ID_CONFIG`.

##### Preparing for cross-tenant testing

To exercise the full invariant, stand up two test accounts against your agent before running fuzz:

1. Provision two isolated tenants (call them A and B). They MUST NOT share any resources beyond what the seller platform itself makes globally visible.
2. Obtain bearer tokens for each. Export as `ADCP_AUTH_TOKEN` (tenant A) and `ADCP_AUTH_TOKEN_CROSS_TENANT` (tenant B), or pass via `--auth-token` / `--auth-token-cross-tenant`.
3. Grant tenant A the minimum permissions needed to create the resources the seeder creates: property lists, content standards, media buys, creatives. Tenant B does not need create permissions — it only reads.
4. Confirm tenant B can authenticate against the agent (e.g., run `adcp --auth-token $TENANT_B_TOKEN https://your-agent/mcp get_adcp_capabilities '{}'`).

A single-tenant run still produces useful signal — baseline catches a significant subset of leaks, and the CLI flags cross-tenant mode as not exercised. Configure two tenants in your compliance CI so this check runs at full strength.

### Request signing — `adcp grade request-signing`

If you claim the `signed-requests` specialism, run the RFC 9421 grader. The grader signs its own requests with test keypairs from `compliance/cache/<version>/test-kits/signed-requests-runner.yaml` — no `--auth` flag; your agent's verifier must accept the runner's JWKS ahead of time.

```bash
# All 38 vectors
npx @adcp/client@latest grade request-signing https://sandbox.agent.example/mcp

# Skip rate-abuse (vector 020 fires cap+1 requests; skip in dev loops)
npx @adcp/client@latest grade request-signing https://sandbox.agent.example/mcp --skip-rate-abuse

# MCP transport (wraps vectors in JSON-RPC envelopes)
npx @adcp/client@latest grade request-signing https://sandbox.agent.example/mcp --transport mcp

# Isolate a single vector
npx @adcp/client@latest grade request-signing https://sandbox.agent.example/mcp --only 016-replayed-nonce
```

### Multi-instance testing

Exposes `(brand, account)`-scoped state that lives per-process instead of in a shared store — a class of bug that single-URL runs never catch. See [`docs/guides/MULTI-INSTANCE-TESTING.md`](./MULTI-INSTANCE-TESTING.md).

```bash
npx @adcp/client@latest storyboard run \
  --url https://a.agent.example/mcp \
  --url https://b.agent.example/mcp \
  sales-guaranteed --auth $TOKEN
```

---

## Deterministic testing (force state transitions the happy path can't reach)

The `deterministic_testing` universal storyboard — plus rejection-branch and delivery-reporting sub-scenarios across several specialisms — requires your agent to expose `comply_test_controller`. Without it, the grader records `controller_detected: false` and skips or fails every step that needs a forced state transition, simulated delivery, or seeded error condition.

**Use `createComplyController`** — adapter-based scaffold that handles dispatch, param validation, typed error envelopes, and re-seed idempotency for you:

```typescript
import { createComplyController } from '@adcp/client/testing';

const controller = createComplyController({
  sandboxGate: input => input.auth?.sandbox === true,   // fail closed
  seed: {
    product:  (params) => productRepo.upsert(params.product_id, params.fixture),
    creative: (params) => creativeRepo.upsert(params.creative_id, params.fixture),
    media_buy: (params) => mediaBuyRepo.upsert(params.media_buy_id, params.fixture),
  },
  force: {
    creative_status:  (params) => creativeRepo.transition(params.creative_id, params.status),
    media_buy_status: (params) => mediaBuyRepo.transition(params.media_buy_id, params.status),
  },
  simulate: {
    delivery: (params) => deliveryRepo.simulate(params),   // needed for delivery_reporting
  },
});

controller.register(server);
```

Omit adapters you don't support — they auto-return `UNKNOWN_SCENARIO`. Throw `TestControllerError('INVALID_TRANSITION', msg, currentState)` when the state machine disallows a transition; the helper emits the typed envelope. `controller.register(server)` auto-emits `capabilities.compliance_testing.scenarios` per AdCP 3.0 — don't declare `compliance_testing` in `supported_protocols`.

For domain state that carries internal structure (packages, revision, history) read by production tools, use `registerTestController(server, store)` — flat store surface, session-scoped factory. See `examples/seller-test-controller.ts`. Pick by state shape, not by helper tier — both sit on the same primitives and both auto-emit the capability block.

---

## Schema-driven validation (catch field drift at dev time)

Wire AJV-based validation into your client or server so payload drift surfaces in tests, not production:

```typescript
// Client side — strict response validation in dev
import { SingleAgentClient } from '@adcp/client';

const client = new SingleAgentClient(url, {
  validation: {
    requests: 'warn',        // log shape issues before they hit the wire
    responses: 'strict',     // throw on schema mismatch from the agent
  },
});

// Server side — opt-in validation on incoming requests + handler responses
import { createAdcpServer } from '@adcp/client';

createAdcpServer({
  validation: {
    requests: 'strict',      // reject malformed requests with VALIDATION_ERROR
    responses: 'strict',     // catch handler-returned drift (dev/test canary)
  },
  // ... other config
});
```

Modes are `'strict'` (throw/reject), `'warn'` (log, continue), or `'off'` (skip, default). One AJV compile per tool on cold start; one validator invocation per call. Cheap in dev, optional in prod hot paths.

Validation issues carry path + expected-vs-actual so the fix location is obvious. Cheap to enable in CI, cheap to disable in prod hot paths.

---

## Cross-step invariants (custom assertions)

Use `--invariants` to load modules that assert properties across storyboard steps. Example invariant: "every mutating call's `idempotency_key` is echoed in the response," "no secret in `$TOKEN` ever appears in any response body," "governance denial MUST block every subsequent mutation in the same session."

```bash
# Load ./my-invariants.js (relative path) or a bare specifier (npm package)
npx @adcp/client@latest storyboard run http://localhost:3001/mcp \
  --invariants ./assertions/idempotency.js,@my-org/adcp-invariants
```

The invariant module calls `registerAssertion({ id, onStep, onEnd, ... })`; failures flip `overall_passed` to `false`. Assertion modules ship upstream as part of the AdCP spec; the SDK provides the registry + CLI wire-up.

---

## Substitution verification (catalog-driven sellers)

If you ship catalog-driven products with macro-expandable tracker URLs, wire `SubstitutionEncoder` into your seller-side macro path and `SubstitutionObserver` into your test harness:

```typescript
import {
  SubstitutionEncoder,
  SubstitutionObserver,
  CATALOG_MACRO_VECTORS,
} from '@adcp/client';

// Seller side — encode every substituted value:
const encoder = new SubstitutionEncoder();
const url = template.replace(macro, encoder.encode_for_url_context(rawValue));

// Runner side — parse preview HTML, match bindings, assert RFC 3986 safety:
const observer = new SubstitutionObserver();
const records = observer.parse_html(previewHtml);
const matches = observer.match_bindings(records, template, bindings);
for (const m of matches) {
  const result = observer.assert_rfc3986_safe(m);
  if (!result.ok) throw new Error(result.error_code); // substitution_encoding_violation, etc.
}
```

Unencoded substitution is a common XSS / scheme-injection vector. `CATALOG_MACRO_VECTORS` exports the seven canonical test bindings (`url-scheme-injection-neutralized`, `reserved-character-breakout`, `nested-expansion-preserved-as-literal`, etc.). For preview-URL fetches, `observer.fetch_and_parse(url)` enforces an SSRF policy — DNS revalidation, bare-IP rejection, cloud-metadata deny — before the HTTP connect.

---

## The dogfood test: skill → built agent → compliance

`scripts/manual-testing/agent-skill-storyboard.ts` is the capstone test. It spawns a fresh Claude Code instance, hands it one of the `skills/build-*-agent/SKILL.md` files plus a target storyboard, lets Claude build an agent, then runs the compliance grader against what Claude produced. Catches skill regressions — if the skill drifts from the SDK surface, a freshly-built agent will fail conformance.

```bash
# Single skill × storyboard pair
npm run compliance:agent-skill -- \
  --skill skills/build-seller-agent/SKILL.md \
  --storyboard idempotency

# Full matrix (every skill × its canonical storyboards)
npm run compliance:skill-matrix
```

Use before merging skill changes. ~60s per pair; matrix runs fan out.

---

## Reading `💡 Hint:` lines (context-value rejections)

> **If you see a `💡 Hint:` line, the fix is almost always in your catalog, not the SDK.** The two tools named in the hint are returning inconsistent values — unify their source.

Example output:

```
❌ Activate PII signal (412ms)
   Task: activate_signal
   Error: Pricing option not found: po_prism_abandoner_cpm
   💡 Hint: Rejected `pricing_option_id: po_prism_abandoner_cpm` was extracted
           from `$context.first_signal_pricing_option_id` (set by step
           `search_by_spec` from response path
           `signals[0].pricing_options[0].pricing_option_id`). Seller's
           accepted values: [po_prism_cart_cpm].
```

The runner is telling you:

1. Step `search_by_spec` wrote `po_prism_abandoner_cpm` into `$context.first_signal_pricing_option_id` — extracted from `signals[0].pricing_options[0].pricing_option_id` on your own `get_signals` response.
2. Step `activate_signal` sent that id back to you.
3. Your `activate_signal` handler rejected it with `available: [po_prism_cart_cpm]`.

So **`get_signals` advertised one id and `activate_signal` accepted a different one**. **Fix by unifying the catalog source** — typically both handlers should read from the same store ([build-seller-agent/SKILL.md](../../skills/build-seller-agent/SKILL.md) covers the shared-store pattern).

The runner only prints a hint when it can trace the rejected value back to a prior-step `$context.*` write. **No hint?** The mismatch came from somewhere else — a hardcoded `sample_request` in the storyboard, a stale fixture, or a `--request` override. Fix the storyboard, not the handler.

Hints are diagnostic-only; pass/fail is decided by the step result, not by hint presence.

### For CI dashboards

Hints also land in machine-readable output:

- **JUnit XML** — appended to the `<failure>` body as `Hint (context_value_rejected): …`, and used as the `message=` attribute when `step.error` is empty (e.g. validation-only failures on 200-OK responses):

  ```xml
  <failure message="Rejected `pricing_option_id: po_prism_abandoner_cpm` …" type="StoryboardFailure">
  Pricing option not found: po_prism_abandoner_cpm
  Hint (context_value_rejected): Rejected `pricing_option_id: po_prism_abandoner_cpm` …
  </failure>
  ```

- **JSON report** (`--format json`) — on `StoryboardStepResult.hints[]` as `ContextValueRejectedHint` objects. Fields: `kind`, `context_key`, `source_step_id`, `source_kind`, `response_path`, `source_task`, `rejected_value`, `request_field`, `accepted_values`, `error_code`, `message`. Dashboards can aggregate rejections by `source_step_id` or `context_key` to spot systemic catalog-drift. See `StoryboardStepHint` / `ContextValueRejectedHint` types exported from `@adcp/client/testing`.

> The rejection-envelope shape (`errors[].details.available` etc.) is tracked in [adcontextprotocol/adcp#3049](https://github.com/adcontextprotocol/adcp/issues/3049); field names here may evolve as the spec pins a canonical key.

---

## When each check fails: debug first-lookups

| Failure | First lookup |
|---|---|
| `storyboard run` skips steps with "no webhook_receiver_runner" | Add `--webhook-receiver` |
| `storyboard run` fails on `security_baseline` | You skipped `authenticate` in `serve()` — see [build-seller-agent/SKILL.md § signed-requests](../../skills/build-seller-agent/SKILL.md) |
| `storyboard run` reports `Agent requires OAuth` / exits without running | Save tokens once with `adcp --save-auth <alias> <url> --oauth`, or pass `--oauth` to `storyboard run` to complete auth inline |
| `storyboard run` prints `💡 Hint: Rejected …` below an error | Catalog inconsistency between the two tools — see [§ Reading hint lines](#reading--hint-lines-context-value-rejections) above |
| `fuzz` reports `500` status with stack trace | Validate inputs and return `adcpError('REFERENCE_NOT_FOUND', ...)` instead |
| `fuzz` reports `response_shape_mismatch` | Response drifted from schema — regen with `npm run sync-schemas` + check your handler |
| Multi-instance fails with `NOT_FOUND` on read-after-write | State keyed by session ID instead of `(brand, account)` — see multi-instance guide |
| `grade request-signing` fails every negative vector | Missing `verifyRequestSignature` middleware; see [build-seller-agent/SKILL.md § signed-requests](../../skills/build-seller-agent/SKILL.md) |
| `--invariants` load errors | Relative path relative to cwd; bare specifier requires installed package |

---

## CI recipes

### Per-PR smoke (fast, blocks merge)

```yaml
- name: Storyboard (core + products)
  run: npx @adcp/client@latest storyboard run $AGENT_URL --tracks core,products --auth $TOKEN
- name: Fuzz (fixed seed)
  run: npx @adcp/client@latest fuzz $AGENT_URL --seed 42 --auth-token $TOKEN --format json
```

### Nightly (slow, broader coverage)

```yaml
- name: Fuzz (random seed, auto-seed)
  run: npx @adcp/client@latest fuzz $AGENT_URL --auto-seed --auth-token $TOKEN
- name: Full storyboard assessment
  run: npx @adcp/client@latest storyboard run $AGENT_URL --auth $TOKEN --json > report.json
```

Random seed on nightly broadens the surface; fixed seed on per-PR keeps reproducibility.

---

## Deeper dives

- [`CONFORMANCE.md`](./CONFORMANCE.md) — `runConformance` + `adcp fuzz` in depth
- [`MULTI-INSTANCE-TESTING.md`](./MULTI-INSTANCE-TESTING.md) — horizontal scaling bug hunt
- [`BUILD-AN-AGENT.md`](./BUILD-AN-AGENT.md) — server-side implementation
- `skills/build-*-agent/SKILL.md` — per-specialism obligations and storyboard IDs
