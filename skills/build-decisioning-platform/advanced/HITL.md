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
5. Buyer polls `tasks_get` OR receives a webhook (if they passed `push_notification_config.url` in the request).

## When a tool is HITL-capable

Only tools whose wire response defines a `Submitted` arm: `create_media_buy`, `sync_creatives`. Other tools (`update_media_buy`, `get_products`) are sync-only — operator re-approval flows surface eventual transitions via `publishStatusChange(...)` rather than HITL on the call itself.

See `REFERENCE.md` for the full HITL section + hybrid-seller patterns + `taskHandoff.notify` semantics.
