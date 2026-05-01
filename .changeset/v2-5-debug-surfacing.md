---
'@adcp/sdk': patch
---

Drift from the warn-only post-adapter v2.5 validation pass now surfaces via `result.debug_logs` instead of dropping silently on the floor. Before this change, `validateAdaptedRequestAgainstV2` ran on every v2-detected request but the `SingleAgentClient` call sites passed no `debugLogs` array — the warning entries had nowhere to go and adapter regressions could land in production unnoticed until a v2 seller reported a wire-shape rejection.

`SingleAgentClient.executeAndHandle` and `SingleAgentClient.executeTask` now collect drift entries into a local array, then merge them into `result.debug_logs` after `executor.executeTask` returns. Adopters reading `result.debug_logs` see post-adapter v2.5 warnings alongside the executor's own logs, so a malformed adapted shape becomes a debuggable signal instead of an invisible bug.

No public API change. The `executor.validateAdaptedRequestAgainstV2(taskName, params, debugLogs?)` seam already accepted an optional `debugLogs` parameter — only the call sites changed.

Closes the observability hole the v2.5-foundation PR (`#1121`) deliberately deferred. Lays the groundwork for the broader compatibility-matrix work that needs reliable drift signal across version pairs.
