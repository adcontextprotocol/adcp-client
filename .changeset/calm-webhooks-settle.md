---
'@adcp/sdk': major
---

Harden legacy purchase continuations by snapshotting caller input before
asynchronous work, binding callbacks and polling to trusted discovered
identities, and recovering durable settlement safely across races, restarts,
and replicas.

Breaking for custom continuation stores: they must use write-once seller-task binding and handle
the `complete()` outcomes `completed`, `pending_completed`, `duplicate`, and `conflict`.
They must atomically cross-check pending callback and bound seller task IDs, and
promote an earlier pending terminal winner from `complete()` without replacing it.
Implement the callback lookup, pending-settlement inbox, and publication
acknowledgement methods together for replica-safe webhooks, or none of them for
the polling-only fallback. Completed-operation replay retention now defaults to
seven days. Handler-less A2A pauses retain an exact-task resume closure only
for a live paused A2A transport Task; MCP and terminal/identity-less A2A pauses are
returned without one. Durable account and seller-session bindings are stored as
hashes, and continuation redemption accepts only the SDK's fixed base64url token
shape.

The v0 server A2A adapter returns handler-produced `input-required` and
`auth-required` arms as completed, nonresumable artifact results. It no longer
leaves a live task that would route continuation-only input through the normal
mutation and idempotency pipeline. Client-side continuations remain available
for sellers that provide a real live A2A task continuation.

`AsyncHandler.handleWebhook()` now returns `handled`, `already_handled`, or
`in_progress`. Typed handler and activity failures propagate so webhook HTTP
helpers can return a retryable failure instead of acknowledging work that was
not published. Dedup processing claims use a renewable, owner-fenced lease and
default to the full dedup retention window, so a renewal failure cannot permit
automatic concurrent handler execution. Setting a shorter
`inFlightTtlSeconds` is an explicit at-least-once liveness tradeoff that
requires idempotent application-side effects. Completed deliveries retain the
configured full dedup TTL.
Custom `IdempotencyBackend` implementations must add atomic
`replaceIfPayloadHash()` and `deleteIfPayloadHash()` operations; these fence
webhook and request claim completion/release across replicas. Request-side
`check()` misses now return a `claimToken` that is required by `save()`,
`saveTransientError()`, and `release()`. With `webhookDedup` configured,
missing MCP idempotency keys and every malformed present key fail closed before
handler dispatch. Configured dedup now also requires the key on A2A deliveries;
older A2A senders must leave receiver dedup disabled.
`putIfAbsent()` must atomically insert when physically absent or replace a
logically expired record using backend time (strictly expired; equality stays
live). Read-then-CAS expiry takeover is not conforming because it permits
renewal and completed-marker ABA races. Custom `IdempotencyStore`
implementations must also provide owner-fenced `renew()` for long-running
mutation claims.
Built-in request claims now use the full advertised replay window as their
base fence and renew while the handler runs. A transient renewal outage cannot
therefore reopen a live mutation after the 120-second working-response window;
the safety tradeoff is that a crashed handler keeps the key in-flight until the
replay window expires.
Idempotency cache publication and release failures now fail closed with
`SERVICE_UNAVAILABLE` after handler execution instead of returning an
unreplayable success, and servers without a runtime idempotency store advertise
`supported: false` even if a capability TTL override was supplied. With a
wired store, the advertised replay window always uses that store's real TTL.
Runtime-cast capability overrides can no longer replace framework-owned AdCP
idempotency declarations.
Webhook dedup completion atomically replaces the owned processing claim with
the handled marker, preventing a stale handler from publishing after lease
loss.
Outside development and test, Redis backends require a deployment-unique
`keyPrefix` unless the operator explicitly acknowledges that the selected
Redis database is isolated. Servers with mutating tools likewise refuse to
start without a runtime idempotency store outside development and test; the
existing explicit disabled mode remains the acknowledged escape hatch.
