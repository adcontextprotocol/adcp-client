---
'@adcp/client': minor
---

feat(testing): add `envelope_field_present` storyboard validation check

Storyboards that assert v3 envelope-level fields (`status`, `task_id`, `adcp_version`, `errors`) need a way to tell static drift detection to walk `protocol-envelope.json` instead of the per-tool response schema. The previous `field_present` check pointed at the inner response schema, which doesn't contain envelope fields, so the `v3-envelope-integrity.yaml` storyboard required a `VERIFIER_UNREACHABLE` exemption.

Adds `envelope_field_present` as a recognized `StoryboardValidationCheck` value:

- **Runtime**: identical semantics to `field_present` — `TaskResult` already merges envelope fields into its surface, so the dispatcher passes through to `validateFieldPresent`. Result objects report the original check name verbatim so reporters can distinguish.
- **Drift detection**: walks `ProtocolEnvelopeSchema` (from `core/protocol-envelope.json`) instead of `TOOL_RESPONSE_SCHEMAS[task]` for `envelope_field_present` entries. The existing `field_present` check stays pinned to inner-response schemas.

Forward-compatible with the current 3.0.1 storyboards (no consumers yet). Lights up when the upstream PR migrates `v3-envelope-integrity.yaml` from `field_present: status` to `envelope_field_present: status` (the `VERIFIER_UNREACHABLE` exemption gets dropped after the next `npm run sync-schemas` post-3.0.2).

Refs adcp#3429.
