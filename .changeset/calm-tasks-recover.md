---
'@adcp/sdk': minor
---

Add crash-safe PostgreSQL settlement for push-enabled decisioning tasks. The
new coordinator commits terminal task state and the durable webhook outbox in
one transaction, reports task compatibility separately from delivery state,
protects task-webhook validation tokens at rest, and withholds the submitted
response until the external producer's durable queue write succeeds.
