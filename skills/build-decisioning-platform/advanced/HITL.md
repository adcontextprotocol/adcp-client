# HITL — long-running tools

When a tool can't return synchronously (operator approval, expensive report, brand-safety review), promote the call to a background task with `ctx.handoffToTask(fn)`. Framework returns the spec-defined `Submitted` envelope to the buyer immediately and runs `fn` in the background.

## Pattern

```ts
import { AdcpError } from '@adcp/sdk/server';

createMediaBuy: async (req, ctx) => {
  if (this.requiresOperatorApproval(req)) {
    return ctx.handoffToTask(async (taskCtx) => {
      await taskCtx.update({ message: 'Awaiting trafficker' });
      const order = await this.runApprovalFlow(req);                // can take hours
      return { media_buy_id: order.id, status: 'pending_creatives', packages: ... };
    });
  }
  return await this.commitSync(req);
}
```

## What the framework does

1. Detects the `TaskHandoff` marker on your return.
2. Allocates a `task_id`, returns `{ task_id, status: 'submitted' }` to the buyer.
3. Runs your handoff `fn` in the background.
4. `fn`'s return value becomes the task's terminal `result`. Thrown `AdcpError` becomes terminal `error`.
5. Buyer polls `tasks_get` OR receives a webhook when the seller owns a configured delivery path.

## Push-enabled handoffs

`push_notification_config.url` is a delivery obligation, not merely a buyer
preference. If its URL validates and your handler returns a `TaskHandoff`, the
framework fails closed with `UNSUPPORTED_FEATURE` unless SDK task webhooks are
configured. Remove the push config for polling-only work and retry the modified
request with a new `idempotency_key`.

The refusal is thrown synchronously by the `ctx.handoffToTask(...)` call, before
the framework creates a task or runs the handoff callback, and before any code
after that call in your method. Let it propagate. To check without building a
marker, call `ctx.canHandoffToTask(options)`: it returns `{ ok: true }` or
`{ ok: false, error }`, where `error` is the same `AdcpError`. Check before a
side effect the refusal would waste, such as calling a remote agent.
Proposal-backed framework reservations are unwound on this refusal.

External settlement (`handoffToTask(..., { settlement: 'external' })`) can use
`push_notification_config` only when the server is given
`taskSettlementCoordinator` (`createPostgresTaskSettlementCoordinator` on the
same Postgres task registry, whose table needs the `push_binding` column). The SDK then
stores the buyer's validated route against the task before acknowledging it,
and your worker settles with `completeBoundPushTask(coordinator, taskRef, result)`
(or `failBoundPushTask` / `rejectBoundPushTask`). The worker never passes a URL
or token. Without a coordinator, framework webhooks do not help: the handoff is
refused, and `ctx.canHandoffToTask({ settlement: 'external' })` reports that up
front.

## When a tool is HITL-capable

Only tools whose wire response defines a `Submitted` arm: `create_media_buy`, `sync_creatives`. Other tools (`update_media_buy`, `get_products`) are sync-only — operator re-approval flows surface eventual transitions via `publishStatusChange(...)` rather than HITL on the call itself.

See `REFERENCE.md` for the full HITL section + hybrid-seller patterns + `taskHandoff.notify` semantics.
