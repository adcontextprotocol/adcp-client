---
'@adcp/sdk': major
---

Harden legacy purchase continuations by snapshotting caller input before
asynchronous work, binding callbacks and polling to trusted discovered
identities, and recovering durable settlement safely across races, restarts,
and replicas.

Migration checklist:

- Custom legacy-purchase stores: implement the six callback/publication methods
  together, including owner-fenced publication and retained acknowledgement proof.
- Custom deferred stores: implement atomic `putIfAbsent`, `replaceIfVersion`, and
  `takeIfVersion` with the documented TTL and generation semantics.
- Idempotency backends: provide owner-fenced replace/delete, retain records through
  clock skew, and configure replica-safe key/table namespaces.
- Buyer clients: persist deferred state for callback-capable committed purchases
  and resume restart tokens through the same client/coordinator route.
- Operators: run backend migrations and readiness probes before serving traffic.

Breaking for custom continuation stores: they must use write-once seller-task binding and handle
the `complete()` outcomes `completed`, `pending_completed`, `duplicate`, and `conflict`.
They must atomically cross-check pending callback and bound seller task IDs, and
promote an earlier pending terminal winner from `complete()` without replacing it.
That promotion must atomically install the pending callback's `serverTaskId` as
the completed operation's seller-task binding when one was not already present.
Implement the callback lookup, pending-settlement inbox, publication
acknowledgement, and deferred-task-token binding methods together for
replica-safe webhooks, or none of them for the polling-only fallback.
Publication acknowledgement must atomically replace the pending entry with a
stable, nonempty `acknowledgedSettlementFingerprint`, retain that proof through
the operation replay fence, and return it from both callback-capable lookup
methods. Exact acknowledgement retries must validate the same proof. This
prevents duplicate completion-handler publication when the legacy ACK succeeds
but deferred-checkpoint finalization must be retried. When an exact completed
result has no pending outbox entry, acknowledgement installs the proof after
successful publication. Custom stores should use the exported
`legacyPurchaseSettlementFingerprint()` helper for the enforced canonical
proof.
Callback-capable stores also implement renewable, owner-fenced
`claimPendingSettlementPublication` and
`releasePendingSettlementPublication` operations. They make SDK-observed
polling completion reclaimable after a crash while excluding healthy
concurrent publishers; pending acknowledgement requires the exact owner and
handlers remain idempotent across lease expiry.
Sender callback writes still stop at the operation replay deadline, while an
SDK-owned polling/inline publication fence may be installed later for already
dispatched seller work and remains retained until exact-owner acknowledgement.
Every accepted sender or SDK terminal outbox starts a fresh seven-day recovery
horizon so handler retry and cross-store finalization cannot outlive the
durable callback route.
That acknowledgement extends the completed replay fence by at least seven days
so a crash before a separate deferred-checkpoint ACK can still recover the
publication proof.
Deferred-token binding is generation-fenced: nested pauses compare-and-swap
the exact prior token rather than allowing a stale continuation to overwrite
the callback recovery route. Restarted/public resumes persist the replacement
checkpoint, atomically rebind that exact coordinator route, and only then
consume the prior checkpoint or return the replacement; a failed handoff leaves
both generations fail-closed without redispatch. Callback-capable committed deferred records also
require the owning durable coordinator to authorize the exact current,
unexpired claimed token before sending seller continuation input. Already
pending or terminal checkpoints remain recoverable without redispatch.
Because the default reference continuation store is callback-capable, a
committed A2A pause now also requires configured deferred storage. Without it,
the pause fails closed instead of exposing a callback-racy in-process resume.
Polling-only stores that omit all six callback methods retain live in-process
pause behavior.
Durably stored deferred tokens are bearer capabilities and must be generated
with a cryptographically secure random source. The SDK accepts UUIDv4 tokens
or 43–256 character URL-safe opaque tokens and rejects weaker or malformed
tokens before any storage read or write.
Completed-operation replay retention now has a seven-day minimum, independent
of shorter unresolved-operation monitoring settings. Handler-less A2A pauses retain an exact-task resume closure only
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
configured full dedup TTL. During upgrade, the receiver also reads the
unexpired raw-agent scoped v1 marker written by the previous SDK so an already
handled callback is not dispatched a second time under the new hashed-agent
key. New claims and completions are written only to the distinct v2 hashed
namespace, preventing a hash-shaped raw agent ID from aliasing another sender.
This namespace cutover requires a drained, all-at-once receiver upgrade: stop
webhook traffic, drain in-flight handlers, upgrade every replica, and then
restart traffic. Mixed old/new receivers are unsupported because they claim
different namespaces and can dispatch the same callback once each; the legacy
read preserves completed fences but does not coordinate mixed-version claims.

Custom deferred-task storage is now typed as `DeferredTaskStorage` and must
provide atomic `putIfAbsent()` and generation-fenced `replaceIfVersion()` and
`takeIfVersion()` operations. Resume atomically
transitions the stored generation to a claimed fence with a fresh dispatch
lease without making the token physically absent; cleanup removes only that
exact claimed generation. Committed continuations use a renewable admission
lease during route authorization and trusted-agent resolution, then atomically
enter a non-reclaimable dispatch-committed phase immediately before the seller
call. This lets a callback win before dispatch while preventing input replay
after an uncertain dispatch. Callback-first terminal winners also converge
when the seller's direct continuation response is still working or submitted,
and retained terminal observations recover a missing metadata task ID from the
checkpoint's validated seller-work binding. A
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
Committed resumes that remain working/submitted retain their seller work handle
under the same durable token, so restart reconstructs polling without sending
the human input again. Only seller-authoritative terminal polling results can
replace that pending route; local observation failures remain retryable, and a
terminal `track()` observation is checkpointed for token-based finalization.
Seller-authoritative `input-required` and `auth-required` polling transitions
remain explicit but nonresumable because an AdCP polling handle is not an A2A
transport task ID. The pending route remains available for later polling
without fabricating a fresh mutation or a false continuation.
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
`AgentClient.resumeDeferredTask(token, input)` delegates through its owned
single-agent client so a reconstructed media-buy compatibility coordinator's
settlement recoverer, exact-token authorizer, response finalization, completion
handlers, and session bookkeeping remain on the public restart path.
Custom `IdempotencyBackend` implementations must add atomic
`replaceIfPayloadHash()` and `deleteIfPayloadHash()` operations; these fence
webhook and request claim completion/release across replicas. Request-side
`check()` misses now return a `claimToken` that is required by `save()`,
`saveTransientError()`, and `release()`. With `webhookDedup` configured,
missing MCP idempotency keys and every malformed present key fail closed before
handler dispatch. Configured dedup now also requires the key on A2A deliveries;
older A2A senders must leave receiver dedup disabled.
Canonical request equivalence now excludes the write-only
`authentication.credentials` value from both `push_notification_config` and
`reporting_webhook`, so secret rotation does not false-conflict. URL, scheme,
token, reporting frequency, requested metrics, and every other routing or
request-semantic field remain hashed.
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
