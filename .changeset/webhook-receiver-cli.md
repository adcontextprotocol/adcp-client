---
'@adcp/client': minor
---

Expose the storyboard-runner webhook receiver on the CLI (closes adcp-client#675).
Before this change, `adcp storyboard run` could not enable the `webhook_receiver`
runtime plumbing that already existed on `runStoryboard`, so storyboards whose
grading depends on observing outbound webhooks — `webhook-emission`,
`idempotency`, and any sales specialism that grades `window_update` /
IO-completion flows — skipped their webhook-assertion steps with
`"Test-kit contract 'webhook_receiver_runner' is not configured on this runner."`
even when the agent emitted fully spec-compliant signed RFC 9421 webhooks.

Three new flags on `adcp storyboard run` / `adcp comply`:

- `--webhook-receiver [MODE]` — host an ephemeral receiver. `MODE` is
  `loopback` (default; binds on 127.0.0.1) or `proxy` (operator-supplied
  public URL).
- `--webhook-receiver-port PORT` — force a specific bind port; defaults to
  auto-assign.
- `--webhook-receiver-public-url URL` — public HTTPS base URL for `proxy`
  mode (implies `--webhook-receiver proxy` when used alone).

Setting any of these activates the receiver and adds `webhook_receiver_runner`
to the run's `contracts` set so `requires_contract` gates resolve. The flags
are also plumbed through `ComplyOptions` (`webhook_receiver`, `contracts`) so
programmatic callers of `comply()` get the same behavior without dropping to
`runStoryboard` directly.
