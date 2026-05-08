# RFC: `adcpError()` two-layer emission for AdCP 3.0.7 Error arms

- **Issue:** [adcp-client#1606](https://github.com/adcontextprotocol/adcp-client/issues/1606)
- **Status:** Draft (design pass — no implementation in this PR)
- **Author:** @bokelley
- **Triggers:** PR #1595 (3.0.7 bump), #1600 (proposal-mode adapter schema-fail)
- **Targets:** AdCP 3.0.6 + 3.0.7 (the requirement is identical in both — see §1)

## tl;dr

`adcpError()` produces only the **envelope** layer (`{adcp_error: {...}}`). Eighteen AdCP response schemas — including every mutating `media-buy` task — define a typed Error arm that requires `errors: [{code, message}, ...]` at the **payload** layer. The two layers are not alternatives; the spec's `error-code.json#GOVERNANCE_DENIED` prose says sellers "populate `errors[].code: GOVERNANCE_DENIED` in the payload AND `adcp_error.code: GOVERNANCE_DENIED` on the envelope per the two-layer model" when no structured rejection arm exists. Today every adopter who routes errors through `adcpError()` ships responses that fail schema validation against those 18 tools.

**Recommendation: Option C — framework auto-emits both layers.** Adopters keep calling `adcpError()`. The framework — which already knows the tool name at dispatch — looks up whether the response schema has a typed Error arm and synthesises the `errors[]` payload from the same `{code, message, field, ...}` data. Adopters write one error shape; the wire is correct on both layers; no surface-area churn; we cannot regress because the dispatcher is the only path. Patch-level change behind a feature flag (default-on in the next minor).

## 1. Spec audit

### 1.1 What the spec actually requires

`schemas/cache/3.0.7/enums/error-code.json#GOVERNANCE_DENIED` (lines 73, 98 of the file). Verbatim:

> **Wire placement (full guidance).** Governance denial is a structured business outcome, not a system error — the governance call SUCCEEDED and the agent returned a denial verdict. Two cases:
>
> 1. **Task response defines a structured rejection arm.** The arm IS the canonical denial shape. The seller populates `reason` (human-readable, propagating governance findings) and `suggestions` (optional) and does NOT additionally emit `GOVERNANCE_DENIED` in `errors[]` or `adcp_error`. The rejection arms enforce this at the schema layer: e.g., `AcquireRightsRejected` and `CreativeRejected` both declare `not: { required: [errors] }`, so dual-emission is already a schema violation. The code does not appear on the wire when the rejection arm is used. Transport-level success markers MUST NOT be flipped (HTTP 200, MCP `isError: false`, A2A `succeeded`) — the task ran successfully and produced a structured response.
>
> 2. **Task response has no rejection arm** (e.g., `create_media_buy` returns Success / Error / Submitted arms only). The seller populates **`errors[].code: GOVERNANCE_DENIED` in the payload AND `adcp_error.code: GOVERNANCE_DENIED` on the envelope** per the two-layer model in `error-handling.mdx#envelope-vs-payload-errors-the-two-layer-model`. Transport-level failure markers DO flip in this case (HTTP 4xx, MCP `isError: true`, A2A `failed`) — the task could not produce a success artifact.

(Emphasis added.) `GOVERNANCE_UNAVAILABLE` carries the same instruction: "Sellers MUST place this code in `errors[]` + `adcp_error` (never a structured rejection arm)".

The two-layer rule generalises beyond governance — the GOVERNANCE_DENIED prose explicitly says "The rule generalizes to any current or future task whose response defines a discriminated rejection arm." For tools without a rejection arm but **with** an `errors[]` Error arm, the payload-layer `errors[]` is the canonical failure shape and the envelope-layer `adcp_error` is the cross-protocol marker.

### 1.2 Affected tools (18)

Every response schema with a top-level `oneOf` arm whose `required` includes `"errors"`:

| Track             | Tool                          | Has rejection arm? | Two-layer required? |
| ----------------- | ----------------------------- | ------------------ | ------------------- |
| media-buy         | `create_media_buy`            | No                 | **Yes**             |
| media-buy         | `update_media_buy`            | No                 | **Yes**             |
| media-buy         | `sync_audiences`              | No                 | **Yes**             |
| media-buy         | `sync_catalogs`               | No                 | **Yes**             |
| media-buy         | `sync_event_sources`          | No                 | **Yes**             |
| media-buy         | `provide_performance_feedback`| No                 | **Yes**             |
| media-buy         | `log_event`                   | No                 | **Yes**             |
| media-buy         | `build_creative`              | No                 | **Yes**             |
| signals           | `activate_signal`             | No                 | **Yes**             |
| creative          | `sync_creatives`              | No                 | **Yes**             |
| creative          | `preview_creative`            | No                 | **Yes**             |
| creative          | `get_creative_features`       | No                 | **Yes**             |
| content-standards | `validate_content_delivery`   | No                 | **Yes**             |
| content-standards | `list_content_standards`      | No                 | **Yes**             |
| content-standards | `get_media_buy_artifacts`     | No                 | **Yes**             |
| content-standards | `get_content_standards`       | No                 | **Yes**             |
| content-standards | `create_content_standards`    | No                 | **Yes**             |
| content-standards | `calibrate_content`           | No                 | **Yes**             |

`acquire_rights` (`AcquireRightsRejected`) and `creative_approval` (`CreativeRejected`) have **structured rejection arms** that explicitly forbid `errors[]` (`not: { required: ["errors"] }`). Those tools are NOT in scope for this RFC — the spec already says sellers route denials through the rejection arm and do NOT emit two layers.

The Error-arm payload shape is uniform across all 18 schemas:

```json
"errors": {
  "type": "array",
  "minItems": 1,
  "items": {
    "type": "object",
    "required": ["code", "message"],
    "properties": {
      "code":       {"type": "string", "minLength": 1, "maxLength": 64},
      "message":    {"type": "string"},
      "field":      {"type": "string"},
      "suggestion": {"type": "string"},
      "retry_after":{"type": "number", "minimum": 1, "maximum": 3600},
      "issues":     {"type": "array", "items": {"...": "RFC 6901 pointer object"}},
      "details":    {"type": "object"},
      "recovery":   {"type": "string", "enum": ["transient","correctable","terminal"]}
    }
  }
}
```

### 1.3 Was this requirement new in 3.0.7?

**No.** The 18 schemas with `errors`-arm-required are the same in 3.0.6 as in 3.0.7 (`grep -l '"required":\s*\[\s*"errors"\s*\]'` returns the same 18 paths in both `schemas/cache/3.0.6/bundled/` and `schemas/cache/3.0.7/bundled/`). The `error-code.json#GOVERNANCE_DENIED` two-layer prose is also present in both versions.

What 3.0.7 changed was the **storyboard chaining** for `get_products_refine` (adcp#4088). 3.0.6 storyboards used a literal `balanced_reach_q2` placeholder that broke `context_outputs` chaining, which cascade-skipped `create_media_buy`. 3.0.7 fixes the chain — so `create_media_buy` actually runs against the upstream now, and the schema validator finally exercises the Error arm. The SDK has been emitting wire-incorrect error responses since the SDK first introduced `adcpError()`; the storyboard just couldn't see it before.

This is the canonical "storyboards are assertions, not ground truth" case from `CLAUDE.md`. We checked — the spec does define the contract. The SDK is the bug.

## 2. Current SDK state

### 2.1 What `adcpError()` emits today

`src/lib/server/errors.ts:132` (full function):

```ts
export function adcpError(code, options): AdcpErrorResponse {
  const recovery = options.recovery ?? STANDARD_ERROR_CODES[code]?.recovery ?? 'terminal';
  const adcp_error = {
    code, message: options.message, recovery,
    ...(options.field && { field: options.field }),
    ...(options.suggestion && { suggestion: options.suggestion }),
    // ...
  };
  const filtered = applyAdcpErrorAllowlist(code, adcp_error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ adcp_error: filtered }) }],
    isError: true,
    structuredContent: { adcp_error: filtered },
  };
}
```

Emits the **envelope layer only** (`structuredContent.adcp_error`). The Error arm `errors: [{code, message}]` payload-layer field is never produced.

### 2.2 Call-site audit

`grep -n 'adcpError(' src/` returns **67 occurrences across 12 files**:

| File                                               | Sites |
| -------------------------------------------------- | ----- |
| `src/lib/server/create-adcp-server.ts`             | 33    |
| `src/lib/server/decisioning/runtime/from-platform.ts` | 13 |
| `src/lib/server/envelope-allowlist.ts`             | 7     |
| `src/lib/server/errors.ts` (the helper itself)     | 4     |
| `src/lib/testing/scenarios/error-compliance.ts`    | 2     |
| `src/lib/testing/storyboard/rejection-hints.ts`    | 2     |
| `src/lib/server/governance.ts`                     | 1     |
| `src/lib/server/decisioning/async-outcome.ts`      | 1     |
| `src/lib/server/a2a-adapter.ts`                    | 1     |
| `src/lib/utils/tool-request-schemas.ts`            | 1     |
| `src/lib/validation/schema-errors.ts`              | 1     |
| `src/lib/testing/compliance/comply.ts`             | 1     |

Every framework-internal call site routes through the dispatcher in `create-adcp-server.ts` — no adapter ever touches `adcpError()` without the dispatcher seeing the result.

### 2.3 Adjacent helpers already in the codebase

The framework already understands the **other half** of the picture. `create-adcp-server.ts:2178` defines `isErrorArm(value)` — a detector for handler-returned `{errors: [...]}` payloads — and `wrapErrorArm(value)` (line 2211), which:

```ts
function wrapErrorArm(value: { errors: unknown[] }): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary }],
    isError: true,
    structuredContent: value,
  };
}
```

So today, the framework supports **two parallel error paths**:

1. Adopter calls `adcpError(...)` → envelope-only `{adcp_error: {...}}`.
2. Adopter returns `{errors: [...]}` directly → payload-only `{errors: [...]}`, no envelope.

Neither path produces the two-layer wire shape the spec requires. The two paths are mirror-image bugs.

`sanitizeAdcpErrorEnvelope()` (line 2239) already runs as a finalize step on the dispatcher path — re-applying `ADCP_ERROR_FIELD_ALLOWLIST` to defend against hand-rolled envelopes. This is the natural seam to splice in two-layer synthesis.

### 2.4 Have any adapters worked around this?

`grep "errors:.*adcp_error\|adcp_error.*errors:" examples/ packages/` — no matches. `grep '"errors"' examples/hello_seller_adapter*.ts` — only the proposal-mode adapter touches `errors[]` and only for non-error advisory paths. No adapter has manually emitted both layers.

## 3. Migration options

### Option A — Modify `adcpError()` to emit both layers

`adcpError()` synthesises `errors: [{code, message, field, suggestion, retry_after, issues, details, recovery}]` from the same options and adds it to `structuredContent` alongside `adcp_error`.

```ts
return {
  content: [{ type: 'text', text: JSON.stringify({ adcp_error: filtered, errors: [payloadError] }) }],
  isError: true,
  structuredContent: { adcp_error: filtered, errors: [payloadError] },
};
```

**Pros**

- Single change, fixes every call site automatically.
- `adcpError()` becomes the canonical "do the right thing on wire" helper.

**Cons**

- Tool-agnostic emission. Sites that emit `adcpError()` in contexts where the response schema is *not* a `media-buy`-style Error-arm tool (e.g., `get_adcp_capabilities`, `tasks/get`, `tasks/list`) get a spurious top-level `errors[]` that the schema doesn't define — most response schemas use `additionalProperties: true` so this is non-fatal, but it's noise.
- Adopters who match against `{adcp_error}` shape only (their own integration tests) will see a new key. Wire-compatible but observably different.
- `tasks/get` envelope: response schema does not currently define `errors[]`. Adding one might confuse strict consumers.
- Patch the wire-shape but doesn't fix handlers that bypass `adcpError()` and hand-roll envelopes (the path `sanitizeAdcpErrorEnvelope` exists for).

**Blast radius:** all 67 SDK call sites + every adopter. Wire-compatible but cosmetically different.

**Version bump:** patch — strictly additive on the wire. Adopters' own integration tests may need a one-line update to ignore the new key.

### Option B — New helper alongside, deprecate the old

Ship `adcpErrorWithPayload()` (or a `payload: true` flag on the existing options bag) that emits both layers. Keep `adcpError()` envelope-only behaviour for backward compatibility; deprecate it; remove in next major.

**Pros**

- Adopters opt in; no surprise wire changes.
- Clear migration path with codemod-style search/replace.

**Cons**

- Two helpers doing 95% the same thing — "use libraries, don't reinvent the wheel" applies internally too.
- Migration guidance per call site: the helper choice depends on the *tool* the handler is wired to (Error-arm tool → new helper; non-Error-arm → old helper). Adopters have to think about something they shouldn't have to.
- Default still ships the wire-incorrect shape until adopters migrate. Slow rollout.

**Blast radius:** opt-in adoption curve. SDK-internal: 67 sites need audit + flag-flip per site.

**Version bump:** minor (additive helper) + deprecate-warn. Removal is breaking → next major.

### Option C — Framework auto-wraps (recommended)

`adcpError()` keeps its current signature and continues to return the envelope as today. The framework dispatcher in `create-adcp-server.ts` — which already runs `sanitizeAdcpErrorEnvelope()` and `finalize()` on every response — gains a sibling step `enrichErrorPayloadLayer()` that:

1. Looks up whether the **current tool's** response schema has a typed Error arm (precomputed at server-build time from the bundled schema cache; one boolean per tool name).
2. If yes, and if `structuredContent.adcp_error` is present, and if `structuredContent.errors` is *not* present, synthesises `errors: [{code, message, field?, suggestion?, retry_after?, issues?, details?, recovery?}]` from the existing `adcp_error` payload and adds it to both `structuredContent` and the L2 JSON text in `content[0].text`.
3. Symmetric for the inverse: if a handler returns `{errors: [...]}` (payload-layer; current `wrapErrorArm` path) and the schema also expects an envelope, synthesise `adcp_error` from `errors[0]` so the cross-protocol marker is set.

```ts
function enrichErrorPayloadLayer(
  response: McpToolResponse,
  toolName: string,
  toolHasErrorArm: boolean,
): void {
  if (!toolHasErrorArm) return;
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc) return;
  const env = sc.adcp_error as AdcpErrorPayload | undefined;
  // Path A: envelope present, payload missing → synthesise payload from envelope
  if (env && !Array.isArray(sc.errors)) {
    sc.errors = [projectEnvelopeToPayloadError(env)];
    syncContentJsonText(response, sc);
    return;
  }
  // Path B: payload present, envelope missing → synthesise envelope from payload[0]
  if (!env && Array.isArray(sc.errors) && sc.errors.length > 0) {
    sc.adcp_error = projectPayloadErrorToEnvelope(sc.errors[0]);
    syncContentJsonText(response, sc);
  }
}
```

**Pros**

- Adopters keep calling `adcpError()` (or returning `{errors}` arm) — no API churn.
- Single source of truth at the framework layer. Identical to how `sanitizeAdcpErrorEnvelope()` already works.
- Tool-aware: only tools whose response schema defines `errors[]` get the synthesis. `get_adcp_capabilities`, `tasks/get`, etc., are untouched.
- Symmetric: fixes both the `adcpError()` envelope-only bug AND the `wrapErrorArm` payload-only bug in one stroke.
- Cannot regress: the dispatcher is on the only path from handler to wire. Future helpers automatically get the right shape.
- Zero-cost when the tool schema doesn't have an Error arm — early return on the boolean.

**Cons**

- Adds one synthesis step to the dispatcher hot path (negligible — one map lookup + one array push when the code path triggers).
- Adopters who want envelope-ONLY emission (do they exist? unclear — the spec says always emit both) can't opt out. If we discover such a case, gate behind a `capabilities.errorEmission: 'envelope-only' | 'two-layer' | 'auto'` knob with `'auto'` default. Probably overengineering — defer until someone asks.
- Schema lookup: adds a build-time dependency on the bundled schema cache being present. Already true (`schemas/cache/<version>/bundled/...` is loaded for validation).

**Blast radius:** SDK-internal only. No call-site changes. Adopter ships next minor and gets the fix automatically.

**Version bump:** **minor** (`6.10.0`). The wire-shape change *removes a violation of an existing schema requirement* — strictly additive, all responses become more compliant. Patch-level is defensible (we're shipping a bug fix that was always required), but minor is honest given the visibility of the wire change.

## 4. Recommended path: Option C

**Justification matrix:**

| Criterion              | Option A | Option B | **Option C** |
| ---------------------- | -------- | -------- | ------------ |
| Adopter friction       | Medium (no code change, but new wire key on every error) | High (opt-in migration of every call site, per-tool decision) | **Low (zero adopter code change)** |
| Wire correctness       | Partial (over-emits on non-Error-arm tools) | Partial (until full migration completes) | **Full (per-schema-aware)** |
| Maintainability        | Medium (every future helper must remember to dual-emit) | Low (two parallel helpers diverge over time) | **High (single dispatcher seam)** |
| Regression resistance  | Medium (hand-rolled envelopes still skip it) | Low (default still wrong) | **High (dispatcher is the only path)** |
| Symmetry with `wrapErrorArm` | Asymmetric (envelope side only) | Asymmetric | **Fixes both sides** |

The case for Option C is essentially the case `sanitizeAdcpErrorEnvelope` already makes — defence in depth at the framework layer beats every-call-site discipline. It's the pattern this codebase has already chosen.

## 5. Test strategy

### 5.1 Schema-driven regression test

`test/server/error-arm-schema-validation.test.ts` (new):

```ts
describe.each(TOOLS_WITH_ERROR_ARM)('%s error response', (toolName) => {
  it('passes Error-arm schema validation when adcpError() is returned', async () => {
    const server = await createTestServer({
      handlers: {
        [toolName]: () => adcpError('VALIDATION_ERROR', {
          message: 'test',
          field: 'foo',
        }),
      },
    });
    const response = await server.callTool(toolName, validRequest);
    const validate = ajv.compile(loadResponseSchema(toolName));
    expect(validate(response.structuredContent)).toBe(true);
    // Both layers present
    expect(response.structuredContent.errors).toEqual([
      expect.objectContaining({ code: 'VALIDATION_ERROR', message: 'test' }),
    ]);
    expect(response.structuredContent.adcp_error).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('passes when handler returns {errors:[...]} arm directly', async () => {
    // ...same assertions, exercising wrapErrorArm path
  });
});
```

`TOOLS_WITH_ERROR_ARM` is generated from the bundled schema cache at test time — adding a new Error-arm tool in a future AdCP minor automatically extends coverage with no test edits.

### 5.2 Storyboard invariant

Add `errors_two_layer_when_schema_requires` to `src/lib/testing/storyboard/default-invariants.ts`. Asserts that on every step targeting a tool whose response schema has an `errors`-arm, a failure response carries both `structuredContent.errors[]` and `structuredContent.adcp_error`. Ratchets the SDK + every conformance-tested adapter.

### 5.3 Wire-shape conformance fixture

`test/conformance/adcp-error-two-layer.fixture.ts` — replays a captured failing-path response from `hello_seller_adapter_proposal_mode` (the adapter that surfaced #1606 via #1600) and asserts both layers post-fix. Concrete reproduction guard.

### 5.4 Lock-in: bundled-schema drift test

`scripts/check-error-arm-coverage.ts` (new, run in CI) — re-derives `TOOLS_WITH_ERROR_ARM` from the schema cache, diffs against a checked-in snapshot, fails CI if a tool gains/loses an `errors`-arm without an explicit ack. Prevents silent drift on AdCP minor bumps.

## 6. Implementation phases (Option C)

- **Phase 1 — Framework auto-wrap.** Add `enrichErrorPayloadLayer()` in `create-adcp-server.ts`, call it from `finalize()` after `sanitizeAdcpErrorEnvelope()`. Add `TOOLS_WITH_ERROR_ARM` precompute pass at server-build time, sourced from the bundled schema cache. Both `adcpError()` envelope path and `wrapErrorArm` payload path covered.
- **Phase 2 — Tests.** Schema-driven regression suite (§5.1), storyboard invariant (§5.2), conformance fixture (§5.3), drift-check script (§5.4).
- **Phase 3 — Changeset + migration recipe.** Minor bump. Recipe in `docs/migration-6.9-to-6.10.md` (or wherever the next migration doc lands): "Error responses now emit both AdCP wire layers automatically. No code change required. If your integration tests assert on `structuredContent` shape, expect a new top-level `errors[]` key on tools with an Error arm — see RFC `docs/proposals/adcperror-two-layer-emission.md` § 1.2 for the list."
- **Phase 4 — Adopter communication.** Release-notes block + a paragraph in `skills/build-seller-agent/SKILL.md` § error handling. The skill currently teaches `adcpError()` — text update to clarify that the framework auto-emits both layers, and that adopters can also return `{errors:[...]}` directly for the typed Error-arm path.
- **Phase 5 (optional, future) — Deprecate `wrapErrorArm` direct use.** Once adopters have migrated to a single `adcpError()` mental model, consider whether `wrapErrorArm` should remain a public surface. Out of scope for this RFC.

## 7. Open questions

1. **Should `recovery` be required on the payload-layer error?** Schema marks it optional. Current envelope payload always carries it (auto-populated from `STANDARD_ERROR_CODES`). Recommendation: emit it on the payload too — it's identical data and the recovery classifier is what makes autonomous-buyer behaviour possible. No downside.
2. **`details` mirroring.** Today `adcpError()` allows `details: {issues: [...]}` for backward compat. Payload-layer `errors[].details` and `errors[].issues` are distinct. Recommendation: project the same `details` value to both layers verbatim — adopters will be surprised if they diverge.
3. **`additionalProperties: true` on the tasks/get response — does adding `errors[]` to envelope-shaped responses ever conflict?** Per spec scan, no Error-arm tool's response uses `additionalProperties: false`. Safe.

## 8. Related prior art

- **adcp-client**: `sanitizeAdcpErrorEnvelope()` (`src/lib/server/create-adcp-server.ts:2239`) — the existing dispatcher-side defence-in-depth for hand-rolled envelopes. Option C is the same pattern applied to the dual-layer requirement.
- **adcp-client**: `wrapErrorArm()` (`src/lib/server/create-adcp-server.ts:2211`) — the existing handler-returned payload-layer path. Option C makes it symmetric with the envelope path.
- **AdCP spec**: `error-code.json#GOVERNANCE_DENIED` and `#GOVERNANCE_UNAVAILABLE` (both versions 3.0.6 and 3.0.7) — the canonical statement of the two-layer model.
- **AdCP spec**: `error-handling.mdx#envelope-vs-payload-errors-the-two-layer-model` (referenced from `error-code.json`; the prose section that defines the two-layer rule). Worth verifying the rendered docs match the schema prose before landing the migration recipe.
- **AdCP rejection arms**: `acquire-rights-response.json#AcquireRightsRejected`, `creative-approval-response.json#CreativeRejected` — the `not: { required: ["errors"] }` clause that proves the spec actively *prohibits* the two-layer shape on tasks with structured rejection arms. Option C honours this by gating on `TOOLS_WITH_ERROR_ARM` derived from the schema cache.
