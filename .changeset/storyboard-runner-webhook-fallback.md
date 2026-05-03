---
'@adcp/sdk': minor
---

Storyboard runner — `task_completion.<path>` resolution now races `tasks/get` polling against the active webhook receiver, whichever arrives first.

Per `tasks-get-response.json:75-85`, sellers MAY use webhook-only HITL completion (the spec's `submitted` enumDescription explicitly says _"Client should poll with tasks/get **or provide webhook_url at protocol level**"_). Pre-this-release, `task_completion.<path>` captures fail-closed against webhook-only sellers because the runner only polled. With this release, when `--webhook-receiver` is active, the runner waits for either (a) terminal `tasks/get` response, or (b) a webhook payload whose body's `task_id` matches the originating step. The first to resolve provides the artifact data; the runner extracts the captured field from there.

The `task_completion.` syntax is unchanged — adoption is forward-compatible. Storyboard authors don't need to declare their preferred resolution source; runner picks whatever arrives.

Failure modes preserved from the prior `task_completion.` implementation:

- `capture_poll_timeout` — neither poll nor webhook resolved within the bounded timeout
- `capture_task_failed` — poll returned a terminal failure OR webhook delivered a non-completed terminal status (`failed` / `canceled` / `rejected`)
- `capture_path_not_resolvable` — task succeeded but the artifact (from poll OR webhook) didn't carry the requested field

Closes #1431.
