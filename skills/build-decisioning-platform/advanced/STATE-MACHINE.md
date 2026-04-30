# Media buy state machine

The wire spec defines a closed status enum; transitions are constrained. Sales agents that get state wrong fail compliance.

## States and transitions

```
pending_creatives  → buyer hasn't pushed creatives yet
       ↓
pending_start      → creatives synced + approved; awaiting campaign start_time
       ↓
active             → delivering
       ↓
paused             → buyer or operator paused (resumable)
       ↓
completed          → end_time passed naturally
       ↓
canceled           → terminated before end_time

rejected           → never accepted (compliance / governance fail at create time)
```

## Rules

1. **`createMediaBuy` returns `pending_creatives`** unless creatives were synced in the same request batch (rare). Returning `active` immediately is wrong — the buyer hasn't synced anything yet.
2. **`syncCreatives` doesn't change media-buy status itself.** Operator approval flow / start_time tick advances it. Use `publishStatusChange(...)` to emit the transition.
3. **Transition events are spec-aligned**: `pending_creatives` → `pending_start` happens when ALL packages have at least one approved creative. `pending_start` → `active` happens when `start_time` is reached.
4. **`paused` and `active` are reversible.** `canceled`, `completed`, `rejected` are terminal.
5. **Illegal transitions throw `InvalidStateError`.** Buyer trying to update a `completed` buy → throw, don't silently accept.

## Pattern: emit transitions via the bus

```ts
import { publishStatusChange } from '@adcp/sdk/server';

// When all packages have approved creatives:
publishStatusChange({
  account_id: ctx.account.id,
  resource_type: 'media_buy',
  resource_id: mediaBuyId,
  status: 'pending_start',
  occurred_at: new Date().toISOString(),
});
```

Buyers subscribed via push_notification_config or MCP Resources see the transition.

## Where to track state

If your platform has the source of truth (GAM order status), read it on every `getMediaBuyDelivery` / `getMediaBuy` and project via `StatusMappers`. If your SDK is the source, use `ctx.ctxMetadata` to stash the current state per buy and update on every mutation.

See `REFERENCE.md` for the full status mapper section.
