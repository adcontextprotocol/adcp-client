---
"@adcp/sdk": minor
---

feat(comply): fire-and-forget A2A tasks/cancel when pollTaskCompletion aborts (adcp-client#1617)

When `comply()` or `waitForCompletion()` is aborted via `AbortSignal` against an
A2A seller, the SDK now dispatches a `tasks/cancel` JSON-RPC call to the seller
before returning the failed `TaskResult`. This prevents orphan tasks from
continuing to run (and billing the seller) after the buyer has given up.

Per A2A 0.3.0 §7.4. Cancel failure is non-fatal — network errors,
`TaskNotCancelableError`, terminal-state races, and the 5s wall-clock cap on
the cancel POST are all swallowed silently. The caller's `TaskResult` is
unchanged (`{ status: 'failed', error: '...cancelled' }`).

Implementation detail (from #1620 expert review):
- `id` field is a real UUID, not `null`. JSON-RPC 2.0 §4.1.3 reserves null
  for notifications; A2A 0.3.0 §7.4 defines `tasks/cancel` as
  request/response. Fire-and-forget is the caller's discipline, not a
  wire-protocol claim.
- `AbortSignal.timeout(5000)` bounds the cancel POST so a hung seller can't
  pin the buyer's event loop past the original abort.
- Silent `.catch()` on rejection: an aborted buyer must not have
  seller-controlled `Error.message` strings echoed into their logs (same
  trust-boundary concern as `raceWithSignal` in `discoverAgentProfile`).
- Phase 2 work (#1617): `signed-requests` sellers will 401 the unsigned
  cancel because `signingContextStorage` is not active inside
  `pollTaskCompletion`. Phase 2 wires explicit context capture at task
  submission and replays it at cancel time.
