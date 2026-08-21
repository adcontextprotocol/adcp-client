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
That promotion must atomically install the pending callback's `serverTaskId` as
the completed operation's seller-task binding when one was not already present.
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

Custom deferred-task storage is now typed as `DeferredTaskStorage` and must
provide atomic `putIfAbsent()` and generation-fenced `replaceIfVersion()` and
`takeIfVersion()` operations. Resume atomically
transitions the stored generation to a claimed fence with a fresh dispatch
lease without making the token physically absent; cleanup removes only that
exact claimed generation. A
seller that pauses again publishes a fresh persisted continuation before it is
returned. `DeferredTaskState` now
matches the durable runtime shape, including required A2A task identity,
the original `serverVersion`, trusted `agentId`, numeric creation/expiry
timestamps, and restart-safe conversation state. An opaque serializable client
context is round-tripped so public-client resumes reapply response
normalization, product policy, canonical creative projection/routing, preview
association, and completion handlers, including when the seller pauses again.
Serializable per-call projection catalogs are retained across recovery, and
non-serializable per-call legacy converter functions now fail before dispatch
when durable continuation storage is enabled. Resumed legacy product discovery
also restores the concealed product-to-format route cache needed by a later
canonical purchase.
Committed mutation pauses retain their trusted settlement operation identity;
after restart, resume refuses before seller dispatch unless the reconstructed
durable coordinator is available. Terminal observations are persisted before
recovery and retried without redispatching the seller mutation; task completion
is published only after durable settlement, response finalization, and completion
handlers succeed. The finalized public result is then durably marked so exact
retries do not rerun seller dispatch, settlement recovery, or completion
handlers. A renewable generation-fenced finalization lease excludes healthy
concurrent replicas from the same checkpoint; failed finalization releases the
checkpoint and crashed-owner leases expire. Recovery callbacks and completion
handlers must remain idempotent because a replacement owner cannot stop a
partitioned or event-loop-stalled former owner after its lease expires.
Admitted claims and terminal checkpoints receive an
independent safety horizon that cannot be shortened by the human continuation
TTL; they remain as exact-replay fences through that safety horizon, avoiding
token-cleanup ABA races.
Persisted records no longer contain agent credentials; secret-shaped request,
conversation, and client-context fields are recursively redacted before
durable storage. Secret-shaped containers are removed as a whole and
over-depth subtrees are truncated rather than persisted unvisited. Authenticated
request property lists that require buyer-side verification fail before seller
dispatch when durable storage is configured, because their credential cannot
be safely reconstructed after restart. Continuation tokens are omitted from
public error messages. Restart recovery resolves the current agent through
`resolveDeferredAgent`.
`SingleAgentClientConfig` exposes the storage, resolver, and token TTL directly,
and `SingleAgentClient.resumeDeferredTask(token, input)` resumes the exact
persisted A2A task after restart. Handler-issued deferrals without durable
storage retain a same-process exact-task closure.
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
Backend entries must also preserve the new absolute `retainUntil` horizon so
physical cleanup cannot remove a completed mutation inside the configured
clock-skew replay window. The PostgreSQL migration adds the matching
`retain_until` column and cleanup index. Active request claims now bind the
canonical request hash as well as their owner generation, so a different
payload reusing an in-flight key conflicts immediately. Failed handlers now
transition their owner claim to a fenced retryable marker instead of deleting
the record: an exact retry can proceed, while changed payloads remain bound to
the original key and conflict.
PostgreSQL keeps `retain_until` nullable for rolling compatibility with old
writers. Reads use the greater of `retain_until` and
`expires_at + legacyRetentionGraceSeconds`; cleanup uses the mathematically
equivalent raw-column predicate so its immutable index remains usable. An old
writer that advances `expires_at` therefore cannot leave a stale
physical-retention timestamp behind. The
backend's legacy grace must be at least the store's `clockSkewSeconds`; unsafe
configurations fail at construction. Redis retains the complete equality second
at the physical horizon, matching the store and SQL cleanup boundary.
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
