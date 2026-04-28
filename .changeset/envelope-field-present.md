---
'@adcp/client': minor
---

feat(testing): add envelope-scoped storyboard validation checks

Storyboards that assert v3 envelope-level fields (`status`, `task_id`, `message`, `replayed`, `governance_context`, `timestamp`, `context_id`, `push_notification_config`) need a way to tell static drift detection to walk `protocol-envelope.json` instead of the per-tool response schema. The previous un-prefixed checks pointed at the inner response schema, which doesn't contain envelope fields, so the `v3-envelope-integrity.yaml` storyboard required a `VERIFIER_UNREACHABLE` exemption.

Adds three envelope-scoped `StoryboardValidationCheck` values:

- `envelope_field_present` — companion to `field_present`
- `envelope_field_value` — companion to `field_value`
- `envelope_field_value_or_absent` — companion to `field_value_or_absent`

**Runtime**: identical semantics to the un-prefixed checks — `TaskResult` already exposes envelope fields at its surface (`data.status`, `data.task_id`, etc.), so the dispatcher passes through to the existing handlers. Result objects report the original check name verbatim so reporters can distinguish. The same passthrough lands in `scripts/conformance-replay.ts` so storyboard replay grades the new checks.

**Drift detection**: walks `ProtocolEnvelopeSchema` (from `core/protocol-envelope.json`) instead of `TOOL_RESPONSE_SCHEMAS[task]` for envelope-scoped entries. The existing un-prefixed checks stay pinned to inner-response schemas.

**Not envelope fields**: `errors` lives inside `payload` (per the per-tool response schema), and `adcp_version` / `adcp_major_version` are request-side only — these stay on the un-prefixed checks.

Forward-compatible with the current 3.0.1 storyboards (no consumers yet). Lights up when the upstream PR migrates `v3-envelope-integrity.yaml` from `field_present: status` to `envelope_field_present: status` (the `VERIFIER_UNREACHABLE` exemption gets dropped after the next `npm run sync-schemas` post-3.0.2).

A future PR will add `field_absent` + `envelope_field_absent` runner support so `v3-envelope-integrity.yaml` can land its currently-TODO `task_status` / `response_status` MUST-NOT assertions.

Refs adcp#3429.
