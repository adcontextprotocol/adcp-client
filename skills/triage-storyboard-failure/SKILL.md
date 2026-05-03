---
name: triage-storyboard-failure
description: Use when an AdCP compliance storyboard fails on an adapter you believe is spec-correct. Walks the rubric for deciding whether to fix the SDK, the adapter, or file upstream against the spec/storyboard.
---

# Triage a Storyboard Failure

## Overview

Storyboards in `compliance/cache/<version>/` are assertions about adopter behavior. They are **not** the spec — they are tests authored against the spec. Storyboards drift. When one fails, the question is _which side is wrong_: the adapter, the SDK, or the storyboard itself.

This skill is the rubric for that decision. It exists because adopter-facing failures look identical regardless of cause, and the wrong-direction fix (changing the SDK to satisfy a storyboard that disagrees with the spec) compounds drift across the ecosystem.

## When to Use

- A `storyboard run` step fails on an adapter you believe satisfies the spec
- The runner reports `expect_error.code` mismatch, `context_outputs path did not resolve`, or a `response_schema` failure on a response that round-trips through the generated TS types
- You're tempted to add a field, change an error code, or adjust a response shape "to make the test pass"

**Not this skill:**

- Real adopter bugs (your handler returns malformed data, throws unexpectedly, ignores a required field) — fix the adapter
- Wire-schema validation failures (`additionalProperties`, missing required) on requests YOU sent — fix the request

## The rubric

For any failing step, work the three checks in order. **Stop at the first answer.**

### 1. Does the spec define the contract the storyboard is asserting?

Open the schema the storyboard's step references (`schemas/cache/<version>/<protocol>/<tool>-response.json` or similar). Find the field, error code, or shape the storyboard expects.

- **Field exists in the spec, with the shape the storyboard expects** → continue to step 2.
- **Field exists in the spec but with a different shape** → spec or storyboard mismatch; the storyboard is wrong. File upstream against `adcontextprotocol/adcp`. Cite the schema file path + line.
- **Field does NOT exist in the spec** → the storyboard authored an opinion that has no spec basis. The storyboard is wrong. File upstream.
- **Spec is silent** (the contract is ambiguous) → flag the spec gap upstream. The storyboard's interpretation may be reasonable, but adopters can't know which interpretation to follow without spec clarity.

### 2. Does the SDK shape match the spec?

If the spec defines the contract correctly, check whether the SDK's generated TS types and runtime validators match it. Read the relevant `src/lib/types/*.generated.ts` interface and confirm:

- Every `required` field in the schema is present and non-optional in the TS type
- Every discriminator (e.g., `asset_type`, `status`) is preserved (codegen sometimes strips `oneOf` discriminators when generating union types)
- Format constraints (date vs date-time, URL pattern, idempotency_key length/pattern) are reflected in either the TS type or the framework's runtime validator

- **TS type matches spec, runtime validation works** → continue to step 3.
- **TS type allows what spec rejects (or vice versa)** → SDK bug. Fix the codegen or hand-fix the type. File against `adcp-client`.

### 3. Is the storyboard's expectation actually testable from the request the runner sent?

Run the failing step in step mode (`adcp storyboard step <agent> <storyboard_id> <step_id> --json`) and inspect:

- The actual request payload the runner sent
- The actual response your adapter returned
- Each `validations[]` entry's pass/fail

Common patterns:

- **`context_outputs path did not resolve`** → the runner couldn't capture a value from your response under the expected path. Check whether the path matches what the spec defines (e.g., adcp#3892 captured `rights_grant_id` but the spec field is `rights_id` — storyboard was wrong).
- **`expect_error: code: X`** but your adapter returned a structured success response (e.g., `AcquireRightsRejected` with `reason`) → storyboard is asserting a thrown-error shape when the spec gives a first-class denial arm. Storyboard convention, not spec contract. File upstream.
- **`unresolved context variables from prior steps`** → the runner can't seed a variable the storyboard requires. Runner gap. File upstream against the storyboard runner.

## Heuristics

- **Generated TS types** are not always tighter than the schema. Discriminator fields, `additionalProperties: false` constraints, and `oneOf` arms can be loosened during codegen. Trust the JSON Schema as ground truth.
- **`response_schema` validation passes but the step still fails** → almost always a storyboard `context_outputs` or `expect_error` mismatch. Your response is correct; the test's assertion is wrong.
- **A storyboard expects a thrown error code** (`expect_error: true` + `code: X`) when the spec defines a structured denial arm → the storyboard is shipping a non-spec convention. The Rejected/Pending/Acquired union is the canonical shape; thrown error codes are for system failures (timeout, unreachable), not policy decisions.
- **`requires_scenarios:`** in a storyboard YAML lists prerequisite scenarios that must run first. Step-mode runs lose this dependency; use full `storyboard run` mode to verify, then re-step the failing piece for diagnostics.

## What to file

When the rubric points upstream, file with this template:

> **Title**: `<storyboard_id>` step `<step_id>`: `<assertion>` is non-spec — `<canonical_shape>` is the canonical wire shape
>
> **Repro**: Run any spec-compliant adapter; show the failing step's `--json` output.
>
> **Root cause**: Cite the spec schema file path + line that defines (or is silent on) the contract the storyboard asserts.
>
> **Fix**: Update the storyboard YAML (or the spec doc-comment, if the spec is genuinely ambiguous).

Cross-link to the adapter PR that surfaced it. The storyboard maintainers see the convergent signal across adopters and can prioritize.

## Examples from production

Real triage walks from this codebase:

- **adcontextprotocol/adcp#3892** (closed): brand-rights storyboard's `acquire_rights` step captured `rights_grant_id` via `context_outputs`. Spec field is `rights_id`. Cascading skip on next step. **Resolution**: spec → field is `rights_id`; storyboard is wrong; filed; closed.
- **adcontextprotocol/adcp#3914** (open): brand-rights/governance_denied storyboard's `acquire_rights_denied` step expected thrown `code: GOVERNANCE_DENIED`. Spec gives `AcquireRightsRejected` arm with `reason`. **Resolution**: storyboard is asserting a non-spec convention; filed upstream; adapter ships spec-correct shape.
- **adcontextprotocol/adcp#3913** (open): `brand_rights/governance_denied` storyboard step `sync_governance` skips because `$context.governance_agent_url` is unresolved; runner has no `--context` flag for full `storyboard run` mode. **Resolution**: runner gap, not adapter or spec gap; filed upstream.

## See also

- CLAUDE.md (this repo): "When a compliance storyboard fails, triage before patching" — the inline guidance this skill expands.
- `docs/guides/VALIDATE-YOUR-AGENT.md` — adopter-facing validation flow that runs storyboards.
- `docs/development/WIRE-VERSION-COMPAT.md` — storyboard cache layout per spec version.
