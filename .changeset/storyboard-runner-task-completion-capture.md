---
"@adcp/sdk": minor
---

Storyboard runner — `task_completion.<path>` prefix on `context_outputs.path`.

When a step's immediate response is a submitted-arm task envelope (HITL / async-signed-IO flows), the seller-assigned IDs only exist on the eventual completion artifact, not the immediate response. Pre-this-release, storyboard authors who tried to capture from the artifact got `capture_path_not_resolvable` for a value the seller correctly produced — just on a later message. The workaround was to author a redundant follow-up `get_*` step purely to expose the field.

The `task_completion.<path>` prefix is an explicit author opt-in: when the runner sees this prefix, it polls `tasks/get` until terminal and resolves the rest of the path against the artifact's `data`.

```yaml
context_outputs:
  - name: media_buy_id
    path: "task_completion.media_buy_id"
```

Polling is bounded (default 30s, override with `STORYBOARD_TASK_POLL_TIMEOUT_MS`); per-poll cadence default 1.5s (override with `STORYBOARD_TASK_POLL_INTERVAL_MS`). The runner never auto-polls based on response shape — the prefix is the only opt-in, so existing storyboards with intentional submitted-arm responses don't change behavior.

`task_id` is validated (length cap + control-char rejection) before reaching the SDK's `tasks/get` call.

Failures emit a distinct `capture_poll_timeout` validation result (not the recycled `capture_path_not_resolvable`) so the failure-class is unambiguous.

Closes #1417 (Option 1 from the issue's three options; the protocol-expert and code-reviewer triage notes converged on this surface as the cleanest fix).
