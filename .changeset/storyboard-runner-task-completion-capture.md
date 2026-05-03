---
'@adcp/sdk': minor
---

Storyboard runner — `task_completion.<path>` prefix on `context_outputs.path`.

When a step's immediate response is a submitted-arm task envelope (HITL / async-signed-IO flows), the seller-assigned IDs only exist on the eventual completion artifact, not the immediate response. Pre-this-release, storyboard authors who tried to capture from the artifact got `capture_path_not_resolvable` for a value the seller correctly produced — just on a later message. The workaround was to author a redundant follow-up `get_*` step purely to expose the field.

The `task_completion.<path>` prefix is an explicit author opt-in: when the runner sees this prefix, it polls `tasks/get` until terminal and resolves the rest of the path against the artifact's `data`.

```yaml
context_outputs:
  - name: media_buy_id
    path: 'task_completion.media_buy_id'
```

The prefix triggers polling on any non-terminal status that carries a `task_id` — `submitted`, `working`, and `input-required`, per the AdCP `tasks-get-response.json` enum. Storyboards with intentional non-terminal-arm assertions are unaffected because the prefix is the only opt-in (no shape inference).

Polling is bounded (default 30s, override with `STORYBOARD_TASK_POLL_TIMEOUT_MS`); per-poll cadence default 1.5s (override with `STORYBOARD_TASK_POLL_INTERVAL_MS`). `task_id` is validated (length cap + control-char rejection) before reaching the SDK's `tasks/get` call.

Failures map to three distinct validation checks so compliance reports surface the right diagnostic:

- `capture_poll_timeout` — task didn't reach terminal state within the timeout
- `capture_task_failed` — task reached terminal `failed` / `canceled` / `rejected`
- `capture_path_not_resolvable` — task succeeded but the artifact's data didn't carry the requested field

This applies to any HITL flow where artifact-only fields land in `context_outputs`: `create_media_buy` (the originally-reported case), `sync_creatives` async approval (`creative_id`), `acquire_rights` (`rights_grant_id`), `si_initiate_session` / `si_send_message`, and any future tool routed through async-signed-IO.

Closes #1417 (Option 1 from the issue's three options; protocol-expert and code-reviewer triage notes converged on this surface as the cleanest fix).
