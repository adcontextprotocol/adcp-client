---
'@adcp/client': minor
---

Storyboard runner: capture A2A wire shape on `protocol: 'a2a'` runs and
add the `a2a_submitted_artifact` validation check. Closes the regression
class from adcp-client#904 — pre-#899 A2A adapters that emitted
`Task.state: 'submitted'` with `final: true` and `adcp_task_id` inside
`artifact.parts[0].data` instead of `artifact.metadata` would otherwise
pass the storyboard suite despite being non-conformant per A2A 0.3.0.

The check asserts the wire-shape invariants for AdCP `submitted` arms
over A2A:

1. `Task.state === 'completed'` — A2A Task.state tracks the HTTP
   transport call; `'submitted'` is the INITIAL state per A2A 0.3.0
   and forbidden as a terminal value.
2. `Task.id` and `Task.contextId` non-empty — required by A2A 0.3.0
   for `tasks/get` addressability and follow-up correlation.
3. `artifact.artifactId` non-empty — required for chunked-artifact
   resumption and buyer-side caching.
4. `artifact.metadata.adcp_task_id` carries the AdCP-level handle
   (per A2A 0.3.0 metadata-extension convention).
5. `artifact.parts[0]` is a DataPart with `data.status === 'submitted'`
   — the AdCP payload preserves its native discriminator.
6. If `data.adcp_task_id` is also present (forward-compatibility for
   a future AdCP tool whose response schema legitimately includes
   it), it MUST equal `metadata.adcp_task_id` — divergent or
   solo-payload writes are the regression class.

JSON-RPC error envelopes fail the check with a distinct
`error_code: 'a2a_jsonrpc_error_envelope'` so dashboards can separate
transport rejections from submitted-arm shape drift.

The check self-skips with a `not_applicable` observation on non-A2A
runs (MCP, raw-probe dispatch path) so storyboards can include it
alongside MCP-shape assertions without forcing the runner to know
which transport ran.

Wires `withRawResponseCapture` around the SDK-driven A2A dispatch in
the runner so the JSON-RPC envelope is observable for validation;
captured response bodies pass through `redactSecrets` before landing
in `ValidationContext.a2aEnvelope` so AdCP-style secret-shaped fields
in DataPart payloads (`api_key`, `client_secret`, etc.) don't reach
persisted compliance reports. `withRawResponseCapture` now surfaces
partial captures on rejection (attached as `error.captures`) so
storyboard validators get a wire-shape envelope even when the SDK
threw mid-parse. Adds `A2ATaskEnvelope` to the public testing types
and exports `getCapturesFromError` from the protocols module.

The companion compliance scenario (adcontextprotocol/adcp#3083 — the
`create_media_buy_async_submitted` storyboard) drives this check.
Closes the runner-side half of adcp-client#904.
