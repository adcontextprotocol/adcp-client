# Severity model

AAO-SECRETARIAT classifies findings into four severities. Both the reviewer (which assigns severities) and the arbiter (which interprets them for the gate decision) use these definitions verbatim.

## Critical
Data loss, security holes, billing bugs, auth bypass, multi-tenant boundary breaks, happy-path crashes on load-bearing flows. Always blocks.

## High
Reproducible runtime errors, broken queries, AdCP spec drift, customer-contract breaks, V1 edits in repos that have migrated to V2, reproducible bugs on load-bearing paths. Always blocks.

## Medium
Unhandled edge cases (empty array, null, race windows), missing timeouts on external calls, warn-only error handling on durable / async / billing paths, missing tests on new branches, LLM-context scope gaps. Surfaced inline; may or may not block depending on category and count (see arbiter decision rules).

## Low
Style, naming, structure, "you could also" suggestions, speculative concerns. Omitted from the output unless the arbiter is producing an approve-with-nits summary.

---

## What counts as each tier (with examples)

**Critical:** data loss/corruption, security holes, billing/money bugs, auth bypass, multi-tenant isolation breaks, a crash on the happy path.

**High:** runtime error on a real branch, broken query, AdCP spec drift, breaking a customer contract, V1 contamination, a concrete reproducible bug on a load-bearing path.

**Medium:** an unhandled edge case that will actually occur (empty array, null deref, the error branch, a real concurrency window); a missing timeout/cancellation on a path that can hang user-visible work, a worker lane, a queue claim, or a billing path; warn-only error handling that hides a durable-state, async, upload, or billing failure; a missing test for a branch this PR added where a regression would be silent and costly; an agent-context scope/lifetime/budget gap; non-deterministic SQL on a load-bearing path.

**Low:** code style, naming, structure, formatting; "you could also handle X" for an X that won't happen; "consider extracting a helper"; speculative "in the future"; wrong/missing changeset where the change itself is sound; docs MUST-vs-SHOULD wording.
