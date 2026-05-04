---
'@adcp/sdk': minor
---

**HITL finalize commit hook** — `proposalManager.finalizeProposal` accepts both inline `FinalizeProposalSuccess` returns AND `TaskHandoff<FinalizeProposalSuccess>` returns. The framework threads both through its standard `routeIfHandoff` dispatch (the same machinery `createMediaBuy` and `syncCreatives` HITL use), running a single projection callback for both arms. The projection commits the proposal via `ProposalStore.commit`, emits the `proposal.finalized` log, and shapes the wire `GetProductsResponse`.

There is no special-case wrapper for finalize. By design — finalize HITL inherits whatever cancellation, restart-via-durable-store, deadline, and webhook delivery semantics the framework's task lifecycle provides for every other unified-hybrid tool. If those guarantees improve in a future SDK release, finalize benefits without code changes here.

**Buyer-facing behavior:**

- Inline path (sync `FinalizeProposalSuccess` return): buyer gets the committed proposal in the `get_products` response immediately.
- HITL path (`TaskHandoff<FinalizeProposalSuccess>` return): buyer gets the spec's `Submitted` envelope (`task_id` populated). Adopter's handoff fn runs in background; framework commits the proposal when it resolves; buyer polls `tasks/get` (or receives the `push_notification` webhook) to retrieve the committed proposal.

Adopter shape:

```ts
finalizeProposal: async (req, ctx) => {
  if (await this.requiresHumanApproval(req)) {
    return ctx.handoffToTask(async taskCtx => {
      await taskCtx.update({ message: 'Awaiting trafficker IO sign-off' });
      const approval = await this.runApprovalWorkflow(req);
      return {
        proposal: { proposal_id: req.proposalId, /* committed */ },
        expiresAt: approval.expires_at,
      };
    });
  }
  return /* inline FinalizeProposalSuccess */;
}
```

The dispatch helper `maybeInterceptFinalize` returns the raw adopter result + a projection callback; the runtime threads them through `routeIfHandoff`. `FinalizeInterceptResult.intercepted` now carries `{ result, project }` instead of a pre-projected `response` — the projection callback is what fires for both arms. JS callers that consumed the previous `response`-shaped intercept arm need to call `await intercept.project(intercept.result)` themselves.

Test coverage: new e2e test in `test/lib/proposal-manager-e2e.test.js` exercises the full HITL flow via `dispatchTestRequest` — adopter returns `ctx.handoffToTask(fn)`, framework commits store + emits `path: 'handoff'` log when the background task resolves.
