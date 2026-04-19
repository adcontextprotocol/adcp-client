---
'@adcp/client': minor
---

Round-2 runner enhancements for the `universal/security.yaml` conformance baseline (adcp-client#565).

> **Upgrade note** — this release tightens one test-kit invariant (`test_kit.auth.probe_task` is now required whenever `test_kit.auth` is declared, with an allowlist) and tightens its TypeScript type accordingly. Callers that relied on the 5.0.x implicit default must add `probe_task: list_creatives` to preserve the prior behavior. See the "Breaking" section below.

Picks up the outstanding runner-side asks flagged during expert review of the storyboard. The directives and validation checks from the first round already shipped in 5.0.x; this release closes the remaining gaps before the storyboard can drive conformance against real v3.x agents.

**Version-gated storyboard execution**

Storyboards can now declare the AdCP version that introduced them via a new optional `introduced_in: "<major.minor>"` field. When an agent's `get_adcp_capabilities.adcp.major_versions` does not include the storyboard's major, the runner skips it with `skip_reason: 'not_applicable'` instead of running and retroactively failing. A v3.0 agent tested against a v3.1-introduced storyboard now surfaces a distinct "not applicable" row in compliance reports rather than a silent pass or a misleading fail.

`resolveStoryboardsForCapabilities()` now returns `{ storyboards, not_applicable, bundles }` — callers that previously destructured only `{ storyboards }` continue to work. The new `AgentCapabilities.major_versions` input drives the gate; when omitted (v2 agents, failed-discovery profiles) every storyboard runs as before.

**`test_kit.auth.probe_task` is now required with an allowlist**

The kit field that tells the runner which authenticated read-only task to probe for unauth / invalid-key rejections no longer silently defaults to `list_creatives`. A kit that declares `test_kit.auth` without a `probe_task` now fails at load with a `TestKitValidationError`. `probe_task` must be one of `list_creatives`, `get_media_buy_delivery`, `list_authorized_properties`, `get_signals`, `list_si_sessions` — auth-required, read-only AdCP tasks that accept an empty request body so auth failures fire before schema validation.

This is the issue-565 round-2 "Option A" call: explicit declaration blocks the silent-regression hazard where every signals-only / SI-only / retail-only agent would fail the storyboard for kit-config reasons, not agent reasons, on the day the storyboard shipped. `validateTestKit()` is exported from `@adcp/client/testing` so upstream YAML loaders can reject malformed kits at file-load time.

**Probe-task error disambiguation (400 / 422 vs 401 / 403)**

When a probe step expects an auth rejection (`http_status_in: [401, 403]`) and the agent instead returns 400 or 422 with a JSON-RPC invalid-params / schema-validation body, the runner now reports a targeted kit-config error: "agent's schema validator rejected the probe before the auth layer ran; fix `test_kit.auth.probe_task`." This is the safety net behind the allowlist: even if a non-allowlisted task slipped through, the diagnostic points at kit config, not a nonexistent agent auth bug.

**Breaking (narrow)**

Two compile-time / runtime behaviors change for callers that use `TestOptions.test_kit.auth`:

- The TypeScript type of `probe_task` is now required (`probe_task: string`, not `probe_task?: string`). TypeScript users get a compile error the first time they build against 5.1.0.
- At runtime, `comply()` / `runStoryboard()` / `runStoryboardStep()` throw `TestKitValidationError` when `test_kit.auth` is declared without `probe_task`, or with a value outside the allowlist. No default is substituted.

Kits that don't declare a `test_kit.auth` block are unaffected. To migrate: set `probe_task: list_creatives` if you previously relied on the implicit default, or pick the allowlisted task that matches your agent's surface (`get_media_buy_delivery`, `list_authorized_properties`, `get_signals`, `list_si_sessions`).
