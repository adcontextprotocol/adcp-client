---
'@adcp/sdk': minor
---

fix(runner): attribute Zod schema rejects to `response_schema`, short-circuit invariants (#1709)

When the SDK's response unwrapper rejects an agent response against the
codegen-emitted Zod schema for the tool (e.g. an `additionalProperties:
true` field the runner's `.strict()` schema doesn't enumerate, like the
recently-added `authorization` field on `sync_accounts`), the exception
previously propagated as a generic `Error` with a freeform message.
The runner's step-execution catch absorbed it into `stepResult.error`
but never attributed the failure to schema validation in
`step.validations[]`. Step-scope invariants then ran against the
malformed payload, and whichever fired first (canonically
`context.no_secret_echo` — the next assertion in the default-invariant
queue) became the surfaced failure. BidMachine spent 10+ deploys
chasing the `no_secret_echo` ghost before the strict-Zod root cause
surfaced. Full trace: adcontextprotocol/adcp#4419.

Fix:

- New `ResponseSchemaValidationError` typed error class in
  `src/lib/utils/response-unwrapper.ts`. Carries `toolName`, `issues`
  (raw Zod issues), and `data` (the rejected payload) for downstream
  attribution. Stable `name === 'ResponseSchemaValidationError'` so
  cross-bundle consumers can detect by string match without `instanceof`.
  Replaces the two generic `new Error('Response validation failed for
  ${toolName}: ...')` throws in the unwrapper.

- `runStep` in `src/lib/testing/client.ts` now returns
  `{ result?, step, caughtError? }`. The new `caughtError` is the
  raw thrown value (typed `unknown`) so callers can pattern-match on
  typed exceptions. Backwards-compatible — pre-existing callers that
  consume only `result` and `step` are unaffected.

- Storyboard runner `executeStep` threads `caughtError` from the
  dispatch fn, and on `ResponseSchemaValidationError` prepends a
  synthesized `response_schema` ValidationResult to `step.validations`.
  The synthesized entry carries the structured issues, the failing
  tool name, an RFC 6901-shaped `json_pointer`, and the rejection
  message. `extractFailures.find(v => !v.passed)` now picks it up
  before any inline or invariant entry.

- Step-scope invariants in `executeStoryboardPass` are short-circuited
  when the synthesized `response_schema` entry is present. Each bypassed
  invariant emits a single skip marker entry (passed: true) so consumers
  see WHICH invariants were bypassed and why, but the bypass entries
  don't crowd out the schema failure in extractFailures.

Sequencing: this PR is the upstream dependency for #1707 (dynamic
schema fetch + strict→passthrough flip + codegen regen). Lands first
so any remaining Zod rejects during #1707's rollout produce honest
signal instead of misattributing to `no_secret_echo`. After both #1709
and #1707 land, BidMachine's 63/128 comply-vs-45/59 CLI delta
(adcp#4419) should collapse — fgranata volunteered as the retest
target on adcp-client#1711.

Coordinated stance: adcp-client#1685 (the SDK is a witness, not a
translator). Same anti-pattern: the SDK was fabricating a different
failure (`no_secret_echo`) than what actually went wrong (schema
rejection); this PR makes it a faithful witness.
