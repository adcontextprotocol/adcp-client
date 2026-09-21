# Principal lifecycle

AdCP resolves a principal from authenticated transport state. A buyer never sends
its own `principal_id`; it reads the seller-issued configuration version and uses
that opaque value only as an optimistic-concurrency fence.

Use the typed methods for individual operations:

```ts
const current = await seller.getPrincipal();

await seller.syncPrincipal({
  idempotency_key: crypto.randomUUID(),
  expected_configuration_version:
    current.status === 'completed' && current.data.result.kind === 'current'
      ? current.data.result.configuration_version
      : undefined,
  configuration: {
    notification_configs: [],
  },
});
```

For normal setup, `syncPrincipalLifecycle` performs the bounded read, guarded
replacement, conflict retry, and destination-state polling as one operation:

```ts
import { syncPrincipalLifecycle } from '@adcp/sdk';

const controller = new AbortController();
const result = await syncPrincipalLifecycle(
  seller,
  {
    reporting_destinations: [destination],
    declarations: {
      async_adcp_versions: ['3.2'],
      webhook_signing_algorithms: ['ed25519'],
    },
  },
  {
    maxAttempts: 3,
    setupTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    signal: controller.signal,
  }
);

if (!result.destinationsReady) {
  // At least one active destination is still pending or reached action_required/rejected.
  console.log(result.current.configuration.reporting_destinations);
}

console.log(result.declarations?.accepted);
console.log(result.declarations?.selected_async_adcp_version);
console.log(result.declarations?.exclusions);
```

Each conflict retry is a new logical mutation with a fresh idempotency key and
the latest `configuration_version`. A lost-response transport retry remains the
responsibility of the normal client task executor, which reuses the request's
key. Polling stops when every destination is ready, when any destination reaches
a terminal setup state, when the timeout expires, or when the caller aborts. It
also fails closed if the authenticated principal or configuration version changes
while setup is being observed; seller-driven setup transitions keep the same
version by protocol contract. Caller-suspended (`active: false`) destinations
are excluded from the readiness quorum.

If a protocol task is accepted asynchronously or pauses for input/authentication,
the helper throws `PrincipalLifecycleError` with the original `taskResult`
attached. Use its `submitted` or `deferred` continuation when present; do not
start a second logical replacement with a new idempotency key.
