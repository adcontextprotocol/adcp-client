# Validate Your Agent

Your checklist to get from "agent boots" to "agent ships." Every tool below is already in `@adcp/sdk`; this page tells you which one runs when, what it catches, and how to read the output.

## TL;DR — five commands, roughly in order

```bash
# 1. Does it answer at all? (60s)
npx @adcp/sdk@latest http://localhost:3001/mcp get_adcp_capabilities '{}'              # MCP
npx @adcp/sdk@latest --protocol a2a http://localhost:3001 get_adcp_capabilities '{}'   # A2A (preview)

# 2. Does it walk the golden path? (2–5 min)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp --auth $TOKEN            # MCP
npx @adcp/sdk@latest storyboard run --protocol a2a http://localhost:3001 --auth $TOKEN # A2A (preview)

# 3. Does it crash on weird inputs? (1–3 min)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --auth-token $TOKEN

# 4. Does webhook/async conformance pass? (2–5 min)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --webhook-receiver --auth $TOKEN

# 5. Does it survive horizontal scaling? (same as 2, two URLs)
npx @adcp/sdk@latest storyboard run \
  --url https://a.agent.example/mcp --url https://b.agent.example/mcp \
  sales-guaranteed --auth $TOKEN
```

If all five pass and your skill's specialism-specific checks below pass, you're conformant. The rest of this page explains why each check exists and how to debug failures.

**Serving both transports (MCP + A2A)?** If your agent mounts MCP and A2A on the same process (via `serve()` + `createA2AAdapter`), run command sets 1–2 against both endpoints — storyboards and capability checks are protocol-independent. MCP validators target the `/mcp` sub-path; A2A validators target the base URL. See [BUILD-AN-AGENT.md § Exposing your agent over A2A](./BUILD-AN-AGENT.md#exposing-your-agent-over-a2a-preview) for the dual-mount setup.

**Working on the agent locally?** Before you reach for the remote-agent commands above, see [`VALIDATE-LOCALLY.md`](./VALIDATE-LOCALLY.md) — the same storyboards, zero tunnel setup, ten lines of code. Point `--local-agent <module>` at your handlers or call `runAgainstLocalAgent` directly from a test file.

**Why `@latest` in every `npx` command?** Without the pin, `npx` reuses whatever version happens to be cached in `~/.npm/_npx/` — and it never re-checks. If you ran `npx @adcp/sdk` six months ago, you're still on that version today. `npx @adcp/sdk@latest` forces npx to resolve the `latest` dist-tag against the registry on every run. If an old cache is causing confusing behavior, `rm -rf ~/.npm/_npx` clears all cached CLI versions.

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
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp --auth $TOKEN

# Single bundle or storyboard by id
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp sales-guaranteed --auth $TOKEN

# Specific tracks only (faster feedback when iterating)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp --tracks core,products --auth $TOKEN

# Ad-hoc YAML (new storyboards under development)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp --file ./my-wip.yaml --auth $TOKEN

# JSON report for CI / tooling
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp --json > report.json
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
npx @adcp/sdk@latest --save-auth my-agent https://agent.example.com/mcp --oauth
npx @adcp/sdk@latest storyboard run my-agent

# (b) inline on first run
npx @adcp/sdk@latest --save-auth my-agent https://agent.example.com/mcp --no-auth
npx @adcp/sdk@latest storyboard run my-agent --oauth
```

Either way, subsequent runs reuse the cached tokens (auto-refresh on expiry via the stored `refresh_token`). Raw URLs don't support `--oauth` — save an alias first.

**CI.** `--oauth` needs a browser. In CI, save tokens once locally, ship `~/.adcp/agents.json` to the runner, and drop the `--oauth` flag from the CI command — the stored `refresh_token` auto-renews on 401.

**Output:** JSON with `tracks[].status` (`passed`/`failed`/`skipped`), `steps[]` with diagnostics, and validations per step.

### `adcp fuzz` — property-based schema fuzzing

Generates schema-valid requests, calls your agent, checks every response under the two-path oracle (schema-valid success *or* well-formed AdCP error envelope with uppercase reason code). Anything else — 500, stack traces, lowercase error codes, token leaks — fails.

```bash
# Tier 1 + Tier 2 stateless + referential (safe, no mutation)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --auth-token $TOKEN

# Reproducible (rerun with same seed to repro a failure)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --seed 42 --auth-token $TOKEN

# Pre-seeded ID pools for referential tools (Tier 2)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --fixture creative_ids=cre_a,cre_b \
  --fixture media_buy_ids=mb_1

# Auto-seed + Tier 3 update-tool fuzzing (mutates agent state — SANDBOX ONLY)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --auto-seed --auth-token $TOKEN

# Uniform-error-response invariant in full cross-tenant mode
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --auto-seed \
  --auth-token            $TENANT_A_TOKEN \
  --auth-token-cross-tenant $TENANT_B_TOKEN

# Inspect the tool list + tier classification
npx @adcp/sdk@latest fuzz --list-tools
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
npx @adcp/sdk@latest grade request-signing https://sandbox.agent.example/mcp

# Skip rate-abuse (vector 020 fires cap+1 requests; skip in dev loops)
npx @adcp/sdk@latest grade request-signing https://sandbox.agent.example/mcp --skip-rate-abuse

# MCP transport (wraps vectors in JSON-RPC envelopes)
npx @adcp/sdk@latest grade request-signing https://sandbox.agent.example/mcp --transport mcp

# Isolate a single vector
npx @adcp/sdk@latest grade request-signing https://sandbox.agent.example/mcp --only 016-replayed-nonce
```

### Multi-instance testing

Exposes `(brand, account)`-scoped state that lives per-process instead of in a shared store — a class of bug that single-URL runs never catch. See [`docs/guides/MULTI-INSTANCE-TESTING.md`](./MULTI-INSTANCE-TESTING.md).

```bash
npx @adcp/sdk@latest storyboard run \
  --url https://a.agent.example/mcp \
  --url https://b.agent.example/mcp \
  sales-guaranteed --auth $TOKEN
```

---

## Deterministic testing (force state transitions the happy path can't reach)

The `deterministic_testing` universal storyboard — plus rejection-branch and delivery-reporting sub-scenarios across several specialisms — requires your agent to expose `comply_test_controller`. Without it, the grader records `controller_detected: false` and skips or fails every step that needs a forced state transition, simulated delivery, or seeded error condition.

**Use `createComplyController`** — adapter-based scaffold that handles dispatch, param validation, typed error envelopes, and re-seed idempotency for you:

```typescript
import { createComplyController } from '@adcp/sdk/testing';

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

### Platform-proxy sellers (state-of-record lives upstream)

Sellers whose read path proxies to upstream platforms (`snapClient.getCreatives(...)`, `metaClient.getMediaBuy(...)`) don't read seeded fixtures from their own data layer — controller-seeded state is a dead write. Wire `TestControllerBridge` to feed those fixtures back into the read path on sandbox requests, without stubbing 13 upstream clients per adapter.

```typescript
import { createAdcpServer, bridgeFromSessionStore } from '@adcp/sdk/server';

const server = createAdcpServer({
  // ... usual config + per-adapter handlers ...
  testController: bridgeFromSessionStore({
    loadSession: input => sessionStore.load(sessionKey(input)),

    // Each selector is opt-in by presence — wire the ones whose storyboards
    // your specialism gates on. Returned entries are validated (warn-and-drop
    // on shape errors, never throw) and merged into the matching tool's
    // response on sandbox requests only.
    selectSeededProducts:           s => s.seededProducts,          // get_products                                  → sales-* product discovery
    selectSeededCreatives:          s => s.seededCreatives,          // list_creatives                                → creative-* upload/listing
    selectSeededMediaBuys:          s => s.seededMediaBuys,          // get_media_buys                                → sales-non-guaranteed delivery-readback
    selectSeededMediaBuyDelivery:   s => s.seededDelivery,           // get_media_buy_delivery                        → sales-* delivery-snapshot assertions
    selectSeededAccounts:           s => s.seededAccounts,           // list_accounts                                 → audience-sync / governance-* multi-account
    selectSeededAccountFinancials:  s => s.seededFinancials,         // get_account_financials                        → governance-spend-authority financial readback
    selectSeededCreativeFormats:    s => s.seededFormats,            // list_creative_formats                         → creative-template / creative-generative
    selectSeededPropertyLists:      s => s.seededPropertyLists,      // list_property_lists + get_property_list       → property-lists / governance-aware-seller property catalog seeding
    selectSeededCollectionLists:    s => s.seededCollectionLists,    // list_collection_lists + get_collection_list   → collection-lists (program-level brand safety)
    selectSeededContentStandards:   s => s.seededContentStandards,   // list_content_standards + get_content_standards → content-standards (brand safety / suitability policies)
    selectSeededSignals:            s => s.seededSignals,             // get_signals                                   → signal-marketplace / signal-owned (signal_id discriminator handles both)
    selectSeededCreativeDelivery:   s => s.seededCreativeDelivery,    // get_creative_delivery                         → creative-ad-server / creative-template / creative-generative delivery readback
    selectSeededCreativeFeatures:   s => s.seededCreativeFeatures,    // get_creative_features                         → creative-* governance feature evaluation (feature-level overrides into success-arm results[])
    selectSeededBrandIdentity:      s => s.seededBrandIdentity,      // get_brand_identity                            → brand-rights identity discovery
    selectSeededRights:             s => s.seededRights,             // get_rights                                    → brand-rights rights discovery
    selectSeededSiOffering:         s => s.seededSiOffering,         // si_get_offering                               → sponsored-intelligence offering lookup
  }),
});
```

Bridge contract:

- **Triply gated.** Bridge runs only when the bridge is registered, the request carries a sandbox marker (`account.sandbox === true` or `context.sandbox === true`), and — if `resolveAccount` produced a record — that record is `sandbox: true` too. Production traffic untouched.
- **Post-handler merge.** The adapter's real handler runs first (so a broken `snapClient.getCreatives()` still fails the conformance gate — the bridge supplements, it does not replace adapter behavior). Seeded entries append; on id collision the seeded fixture wins.
- **Singleton exception.** `get_account_financials` returns one account's envelope, so the bridge picks the seeded fixture whose `account.account_id` matches the request's `account.account_id` and REPLACES the handler envelope for that account. Other accounts pass through unchanged. When `resolveAccount` produces a record, the resolved `account_id` wins over the request's `account_id` — fixtures are interchangeable across `AccountReference` variants. The same pattern applies to `get_property_list` / `get_collection_list` (pick seeded entry by `list_id` matching `request.list_id`, replace the response's `list` field while preserving handler `identifiers` / `pagination` / `resolved_at` / `cache_valid_until` / `coverage_gaps` / `context` / `ext`), `get_content_standards` (pick by `standards_id`, replace the `ContentStandards` body and preserve handler's `context` and `ext`), `get_brand_identity` (pick by `brand_id`, replace the success body and preserve handler `context` / `ext`), and `si_get_offering` (pick by `offering.offering_id` matching `request.offering_id`, replace the response body and preserve handler `context` / `ext`). The seeded fixture array for each governance tool also feeds the matching list tool (`list_property_lists`, `list_collection_lists`, `list_content_standards`) via append-merge with seeded-wins on collision. `get_rights` is a discovery / search tool with an array response — append-merge by `rights_id`, seeded wins on collision (no list / singleton pair).
- **Delivery merge recomputes aggregated_totals.** `get_media_buy_delivery` is the one append-merge bridge that updates the response envelope: after seeded deliveries merge in (seeded wins on `media_buy_id` collision — matches the precedent set by the other five `getSeeded*` bridges, since storyboards seed deliberately and a seeded fixture for an existing id is an explicit author override), `aggregated_totals` is recomputed from the merged per-delivery `totals`. Required sums (`impressions`, `spend`, `media_buy_count`) always recompute. Optional sums (`clicks`, `completed_views`, `views`, `conversions`, `conversion_value`) only recompute when every merged delivery populates the field — partial population falls back to the handler's value (no silent under-counting). Derived ratios (`roas`, `completion_rate`, `cost_per_acquisition`) recompute only when both inputs were recomputed AND the divisor is non-zero. Pass-through fields (`reach`, `reach_unit`, `frequency`, `new_to_brand_rate`) keep the handler's value verbatim — they aren't derivable from per-delivery `totals`.
- **Validation drops invalid fixtures.** Entries missing the dedup id (`creative_id`, `media_buy_id`, `account_id`, `account.account_id`, `format_id.{agent_url,id}`, `list_id` for property + collection lists, `standards_id` for content standards, `signal_id.{source,id,data_provider_domain|agent_url}` for signals, `creative_id` for creative delivery, `feature_id` for creative features, `brand_id` for brand identity, `rights_id` for rights, `offering.offering_id` for SI offerings) are warn-and-dropped, not thrown — a broken test fixture shouldn't tank the request under test.
- **`get_creative_features` is the only nested-array merge.** `get_creative_features` returns a `oneOf` envelope. When the handler returned the success arm, seeded `CreativeFeatureResult[]` merge into the success arm's `results` array by `feature_id` (seeded wins on collision); framework-managed envelope fields (`context`, `ext`, `detail_url`, `pricing_option_id`, `vendor_cost`, `currency`, `consumption`) round-trip from the handler verbatim. When the handler returned the error arm, the bridge is a no-op — the error envelope passes through unchanged.
- **`_bridge` marker on augmented responses.** When the bridge merges seeded fixtures into a handler response, the framework stamps a non-normative `_bridge: { callback, tool, merged_count }` field on `structuredContent` (and mirrors it onto `content[0].text` when that body is JSON). This is the runner-visible signal that distinguishes _"this pass exercised the adopter's adapter against upstream"_ from _"this pass exercised wire conformance against fixture data merged by the SDK"_. Storyboard runners and compliance leaderboards read the marker to attribute bridge participation in run records — without it, a green storyboard step through fixture-merge reads identically to one that ran through a real adapter. The underscore prefix and AdCP's `additionalProperties: true` on every bridge-augmented response top level keep the marker schema-safe. Absent when no merge occurred (callback omitted, non-sandbox traffic, or singleton-replace fixture didn't match the request id). Marker payload:

  - `callback` — bridge callback that produced the seeded entries (e.g. `getSeededCreatives`)
  - `tool` — tool name whose response was augmented (mirrors envelope context)
  - `merged_count` — number of post-validation seeded entries the callback returned

  **Interpreting a bridge-augmented pass:** wire conformance against fixture data, _not_ adapter-against-upstream health. Pair the conformance suite with a separate live-OAuth run against the real upstream platform before promoting an adapter to production. **If you're a buyer reading a compliance score**, treat `_bridge`-marked passes as supplier wire-readiness, not as evidence the adapter can fulfill against the live upstream — a fully bridge-augmented response array (`merged_count` equal to the response's entry count) means every entry came from a fixture; a `merged_count` smaller than the response's entry count means the bridge supplemented a real adapter call. The leaderboard policy that surfaces this distinction is tracked in [`adcp-client#1782`](https://github.com/adcontextprotocol/adcp-client/issues/1782); see [`adcp-client#1775`](https://github.com/adcontextprotocol/adcp-client/issues/1775) for the cross-repo coordination context (storyboard runner surfacing).

Plain hand-rolled `TestControllerBridge` (no session store) is also supported — wire `getSeededProducts` / `getSeededCreatives` / etc. directly. See `src/lib/server/test-controller-bridge.ts` for the interface.

---

## Schema-driven validation (catch field drift at dev time)

Wire AJV-based validation into your client or server so payload drift surfaces in tests, not production:

```typescript
// Client side — strict response validation in dev
import { SingleAgentClient } from '@adcp/sdk';

const client = new SingleAgentClient(url, {
  validation: {
    requests: 'warn',        // log shape issues before they hit the wire
    responses: 'strict',     // throw on schema mismatch from the agent
  },
});

// Server side — opt-in validation on incoming requests + handler responses
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

createAdcpServerFromPlatform(platform, {
  name: 'My Agent',
  version: '1.0.0',
  validation: {
    requests: 'strict',      // reject malformed requests with VALIDATION_ERROR
    responses: 'strict',     // catch handler-returned drift (dev/test canary)
  },
});
```

Modes are `'strict'` (throw/reject), `'warn'` (log, continue), or `'off'` (skip, default). One AJV compile per tool on cold start; one validator invocation per call. Cheap in dev, optional in prod hot paths.

Validation issues carry path + expected-vs-actual so the fix location is obvious. Cheap to enable in CI, cheap to disable in prod hot paths.

---

## Cross-step invariants (custom assertions)

Use `--invariants` to load modules that assert properties across storyboard steps. Example invariant: "every mutating call's `idempotency_key` is echoed in the response," "no secret in `$TOKEN` ever appears in any response body," "governance denial MUST block every subsequent mutation in the same session."

```bash
# Load ./my-invariants.js (relative path) or a bare specifier (npm package)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
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
} from '@adcp/sdk';

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

## The fork-matrix: canonical adapter → compliance

`test/examples/hello-*.test.js` is the canonical compliance gate. Each test boots the matching `examples/hello_*_adapter_*.ts` reference adapter against a mock-server upstream, runs the storyboard grader, and verifies upstream traffic — the three-gate contract documented in [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade. Adopters inherit the gate by extending the test file with their own adapter path and `expectedRoutes`.

```bash
# Run every fork-target gate (deterministic, ~10s parallel)
npm run compliance:fork-matrix

# Or one specialism
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-guaranteed"
```

Use before merging adapter or skill changes. Deterministic — no LLM variance, no minutes-long Claude spin-up.

> **Note:** storyboards with webhook steps (e.g. `webhook_emission`) hold the grader subprocess open until the agent emits a webhook. If your agent doesn't emit one, the harness kills the subprocess after 120s and logs `grader: subprocess timed out` — this is a harness-level timeout, not a conformance failure from your agent's response.

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

- **JSON report** (`--format json`) — on `StoryboardStepResult.hints[]` as `ContextValueRejectedHint` objects. Fields: `kind`, `context_key`, `source_step_id`, `source_kind`, `response_path`, `source_task`, `rejected_value`, `request_field`, `accepted_values`, `error_code`, `message`. Dashboards can aggregate rejections by `source_step_id` or `context_key` to spot systemic catalog-drift. See `StoryboardStepHint` / `ContextValueRejectedHint` types exported from `@adcp/sdk/testing`.

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
  run: npx @adcp/sdk@latest storyboard run $AGENT_URL --tracks core,products --auth $TOKEN
- name: Fuzz (fixed seed)
  run: npx @adcp/sdk@latest fuzz $AGENT_URL --seed 42 --auth-token $TOKEN --format json
```

### Nightly (slow, broader coverage)

```yaml
- name: Fuzz (random seed, auto-seed)
  run: npx @adcp/sdk@latest fuzz $AGENT_URL --auto-seed --auth-token $TOKEN
- name: Full storyboard assessment
  run: npx @adcp/sdk@latest storyboard run $AGENT_URL --auth $TOKEN --json > report.json
```

Random seed on nightly broadens the surface; fixed seed on per-PR keeps reproducibility.

---

## Deeper dives

- [`CONFORMANCE.md`](./CONFORMANCE.md) — `runConformance` + `adcp fuzz` in depth
- [`MULTI-INSTANCE-TESTING.md`](./MULTI-INSTANCE-TESTING.md) — horizontal scaling bug hunt
- [`BUILD-AN-AGENT.md`](./BUILD-AN-AGENT.md) — server-side implementation
- `skills/build-*-agent/SKILL.md` — per-specialism obligations and storyboard IDs
