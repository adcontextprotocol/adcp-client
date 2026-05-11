---
"@adcp/sdk": minor
---

fix(comply): forward structured adcp_error detail from failed storyboard steps

`ComplianceResult` now surfaces `adcp_error?: AdcpErrorInfo` alongside the existing
`error?: string` on `ComplianceFailure` and `StoryboardStepResult`. Previously,
the structured error envelope (code, field, validation_errors) returned by the
agent was silently dropped at the `executeStoryboardTask` boundary — only the
human-readable string was forwarded.

Consumers (dashboards, LLM self-correction loops) can now read `failure.adcp_error.field`
and `failure.adcp_error.details.validation_errors` directly instead of re-running the
failing step to obtain the wire-level detail. Fixes #1679.
