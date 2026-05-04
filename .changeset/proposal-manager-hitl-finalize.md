---
'@adcp/sdk': minor
---

**HITL finalize commit hook** — wire `TaskHandoff[FinalizeProposalSuccess]` through the framework's existing task-handoff dispatch. Adopters whose finalize logic needs human review (trafficker IO sign-off, broker approval, brand-manager confirmation) can now return `ctx.handoffToTask(fn)` from `proposalManager.finalizeProposal`; the framework wraps the handoff so:

- The buyer immediately receives the spec's `Submitted` envelope from `get_products` (`task_id` populated).
- The wrapped handoff runs in background via the standard `TaskRegistry` flow.
- When the adopter's handoff function resolves with a `FinalizeProposalSuccess`, the framework commits the proposal via `ProposalStore.commit`, emits the `proposal.finalized` log with `path: 'handoff'`, and projects the wire `GetProductsResponse` (committed proposal) as the task's terminal artifact.
- If the handoff fn throws (or returns the wrong shape), the framework's task-registry path treats the task as failed; the proposal stays `draft` so the buyer can retry.

Adopter shape:

```ts
finalizeProposal: async (req, ctx) => {
  if (await this.requiresHITL(req)) {
    return ctx.handoffToTask(async taskCtx => {
      await taskCtx.update({ message: 'Awaiting trafficker' });
      const approval = await this.runHITL(req);
      return {
        proposal: { proposal_id: req.proposalId, /* committed */ },
        expiresAt: approval.expires_at,
      };
    });
  }
  return /* inline FinalizeProposalSuccess */;
}
```

The five-seam dispatch helper (`maybeInterceptFinalize`) gains a third result arm: `{ kind: 'handoff', handoff: TaskHandoff<GetProductsResponse> }`. The runtime routes through `routeIfHandoff` (the same machinery `createMediaBuy` uses for HITL ad-server review). `FinalizeInterceptResult` type updated.

Closes the v1.6+ deferral noted in the original v1.5 dispatch wiring changeset. The pre-existing rejection (`finalizeProposal returned a TaskHandoff — HITL finalize is not yet wired in v1.5`) is gone.

Test coverage: new e2e test in `test/lib/proposal-manager-e2e.test.js` exercises the full flow via `dispatchTestRequest` — adopter returns `ctx.handoffToTask(fn)`, framework commits store + emits `path: 'handoff'` log when the background task resolves.
