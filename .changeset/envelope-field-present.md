---
'@adcp/client': minor
---

feat(testing): add envelope-scoped storyboard validation checks

Storyboards that assert v3 envelope-level fields (`status`, `task_id`, `message`, `replayed`, `governance_context`, `timestamp`, `context_id`, `push_notification_config`) need a way to tell static drift detection to walk `protocol-envelope.json` instead of the per-tool response schema. The previous un-prefixed checks pointed at the inner response schema, which doesn't contain envelope fields, so the `v3-envelope-integrity.yaml` storyboard required a `VERIFIER_UNREACHABLE` exemption.

Adds five new `StoryboardValidationCheck` values:

- `field_absent` — passes when the path is absent; fails when present (companion to `field_present`)
- `envelope_field_absent` — envelope-scoped companion to `field_absent`; signals drift detection to walk `protocol-envelope.json`; absence checks skip reachability assertions by design
- `envelope_field_present` — companion to `field_present`
- `envelope_field_value` — companion to `field_value`
- `envelope_field_value_or_absent` — companion to `field_value_or_absent`

**Runtime**: identical semantics to the un-prefixed checks — `TaskResult` already exposes envelope fields at its surface (`data.status`, `data.task_id`, etc.), so the dispatcher passes through to the existing handlers. Result objects report the original check name verbatim so reporters can distinguish. The same passthrough lands in `scripts/conformance-replay.ts` so storyboard replay grades the new checks.

**Drift detection**: walks `ProtocolEnvelopeSchema` (from `core/protocol-envelope.json`) instead of `TOOL_RESPONSE_SCHEMAS[task]` for envelope-scoped entries. `field_absent` and `envelope_field_absent` are collected by the drift detector but skip reachability assertions — absence checks have no schema target by design.

**Not envelope fields**: `errors` lives inside `payload` (per the per-tool response schema), and `adcp_version` / `adcp_major_version` are request-side only — these stay on the un-prefixed checks.

Forward-compatible with the current 3.0.1 storyboards. Lights up when the upstream PR migrates `v3-envelope-integrity.yaml` from `field_present: status` to `envelope_field_present: status` (the `VERIFIER_UNREACHABLE` exemption gets dropped after the next `npm run sync-schemas` post-3.0.2). The `task_status` / `response_status` MUST-NOT assertions in `v3-envelope-integrity.yaml` can now land using `field_absent` / `envelope_field_absent` without a further SDK release.

Refs adcp#3429.
