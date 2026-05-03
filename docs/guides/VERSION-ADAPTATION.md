# Version Adaptation

Three versions move at the same time when you ship an AdCP agent or
client:

| Axis | Example | What changes |
|---|---|---|
| **Spec version** | AdCP `2.5 → 3.0.5 → 3.1` | Wire shapes, error codes, lifecycle states, new tools |
| **SDK version** | `@adcp/sdk` 5.x → 6.x | API surface, ergonomics, compile-time guarantees |
| **Peer version** (per call) | Buyer at v3.0, seller at v2.5 | A single conversation crosses versions |

`@adcp/sdk` ships three concrete mechanisms so adopters don't carry the
translation matrix in handler code. This guide is the recipe per
mechanism. For the conceptual background see
[the architecture deep-dive](../architecture/adcp-stack.md#version-adaptation).

## Mechanism 1 — Pin the spec version per call

Use this when you're a **client** talking to a peer that's pinned to
an older (or newer beta) spec version. The SDK runs your request and
the peer's response through adapter modules so your handler code stays
on the canonical (current) shape.

### Pin the version on a single agent

```ts
import { ADCPMultiAgentClient } from '@adcp/sdk';

const client = ADCPMultiAgentClient.simple(
  'https://legacy-agent.example.com/mcp/',
  {
    authToken: process.env.AGENT_TOKEN,
    adcpVersion: 'v2.5', // ← pin here
  },
);

const agent = client.agent('default-agent');
const result = await agent.getProducts({ brief: 'CTV inventory' });
```

The `adcpVersion` field accepts any value from `COMPATIBLE_ADCP_VERSIONS`
in `src/lib/version.ts`. Editors autocomplete the canonical list;
forward-compatible strings (e.g., a beta channel that hasn't been
added yet) are still accepted.

### Validate the version up front

`adcpVersion` is validated at construction time. The SDK only accepts
versions whose **schema bundle ships with the build** — if the bundle
isn't present (e.g., you pinned a beta channel that hasn't been
synced into your installed SDK), `resolveAdcpVersion` throws a typed
`ConfigurationError` at construction with a pointer to
`sync-schemas` + `build:lib`.

Type-level vs runtime: `AdcpVersion | (string & {})` lets editors
autocomplete canonical values from `COMPATIBLE_ADCP_VERSIONS` while
still accepting any string at the type level. Runtime acceptance is
gated on the bundled schema set — the type system won't catch a
forward-compatible string that has no schema bundle, but the
constructor will, before any wire traffic.

To see what your installed SDK actually has bundled:

```ts
import { COMPATIBLE_ADCP_VERSIONS, ADCP_VERSION } from '@adcp/sdk';

console.log(ADCP_VERSION); // GA version this build targets, e.g. '3.0.5'
console.log(COMPATIBLE_ADCP_VERSIONS); // declared compatibility list
```

### What the adapters actually do

Look in `src/lib/adapters/legacy/v2-5/` for the per-tool translation
modules: `create_media_buy.ts`, `get_products.ts`,
`sync_creatives.ts`, etc. Each is a pure shape translation
(field renames, default population, structural reshaping). The SDK
applies them transparently when `adcpVersion` is set; your handler
sees the current shape regardless of which version the peer speaks.

When AdCP 3.1 ships and you bump `@adcp/sdk`, a new adapter folder
appears for the now-legacy 3.0. Your handlers don't move.

## Mechanism 2 — Migrate SDK majors via subpath imports

Use this when you bump `@adcp/sdk` from one major to the next and
don't want to rewrite every handler the day you upgrade. The SDK
keeps the prior major's surface available at a legacy subpath.

### Example: 5.x → 6.x

In v6.0, `createAdcpServer` was hard-removed from the top-level and
`@adcp/sdk/server` exports. Your existing v5 code keeps working by
swapping one import:

```ts
// v5 code — change only the import path
import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';

serve(() => createAdcpServer({
  name: 'My Agent',
  version: '1.0.0',
  // …existing v5 handler bag — unchanged
}));
```

Greenfield code in the same project uses the platform entry point
side by side. The signature is `(platform, opts)` — two positional
args, with the typed `DecisioningPlatform` first and runtime options
second:

```ts
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

const platform = new MyPlatform(); // implements DecisioningPlatform
const server = createAdcpServerFromPlatform(platform, {
  name: 'my-agent',
  version: '1.0.0',
  // …other runtime options
});
```

Both compile, both run, both pass conformance. You migrate one
handler — or one specialism — at a time. The legacy subpath is a
documented co-existence path, not a deprecation warning.

For a complete platform example, see
[`examples/decisioning-platform-mock-seller.ts`](https://github.com/adcontextprotocol/adcp-client/blob/main/examples/decisioning-platform-mock-seller.ts).

### One-shot search-replace for a 5.x → 6.0 bump

See [`docs/migration-5.x-to-6.x.md`](../migration-5.x-to-6.x.md) for
the full cumulative migration. The "tl;dr — five breaking changes to
search-replace" table is the fastest path if you've skipped rounds.

### When to actually migrate

Stay on the legacy subpath as long as the surface keeps compiling
and passing conformance. Migrate a specialism when you want the new
features (compile-time specialism enforcement, capability
projection, idempotency / signing / async-task / status-normalization
pre-wiring on greenfield code). There's no rush.

## Mechanism 3 — Wire-level negotiation

Use this when you're a **server** and you want to be explicit about
which spec versions you accept.

### Declare what you support

`supported_versions` (release-precision strings) and/or
`major_versions` go on the `AdcpCapabilitiesConfig` passed to
`createAdcpServer`. Use release-precision strings — `'3.0.5'`,
`'3.1.0'` — not the legacy aliases (`'v2.5'`, `'v3'`) used for
client-side pinning. A 3.x server with no v2.5 handler logic should
not declare `'v2.5'` here — its 2.5 callers go through *client-side*
adapters at the buyer end, not the server's accepted-version set.

```ts
import { createAdcpServer } from '@adcp/sdk/server';

const server = createAdcpServer({
  name: 'My Agent',
  version: '1.0.0',
  capabilities: {
    major_versions: [3],
    supported_versions: ['3.0.5', '3.1.0'],
    // …other capability fields
  },
  // …handlers
});
```

The union of `supported_versions` (parsed to majors) and
`major_versions` defines the seller's accepted set on inbound
`adcp_major_version` / `adcp_version` claims.

### What happens on a mismatch

If a buyer's request carries an `adcp_major_version` (or
`adcp_version`) that isn't in the accepted set, the SDK returns a
`VERSION_UNSUPPORTED` error envelope. The envelope echoes the
seller's `supported_versions` so the buyer can downgrade their pin
without an out-of-band lookup.

### Buyer side: two surfaces

There are two places version mismatch can surface on the client, and
they fire in different conditions:

**1. `VersionUnsupportedError` thrown pre-flight.** When the client
already has the peer's capabilities cached and knows up front that
the call won't go through (synthetic mismatch, version mismatch,
idempotency mismatch), the SDK throws `VersionUnsupportedError`
*before* sending the request. Catch it from the call site:

```ts
import { VersionUnsupportedError } from '@adcp/sdk';

try {
  const result = await agent.getProducts({ brief: '…' });
} catch (err) {
  if (err instanceof VersionUnsupportedError) {
    // peer doesn't support this call at the pinned version —
    // re-pin adcpVersion or switch agents
  }
  throw err;
}
```

**2. `VERSION_UNSUPPORTED` envelope from the wire.** When the
mismatch is only detected on the server side (e.g., the buyer's
`adcp_major_version` parses different than the buyer's `adcp_version`
string), the response carries a typed `VERSION_UNSUPPORTED` error
envelope that echoes the seller's `supported_versions`:

```ts
const result = await agent.getProducts({ brief: '…' });

if (!result.success && result.adcpError?.code === 'VERSION_UNSUPPORTED') {
  const supported = result.adcpError.details?.supported_versions ?? [];
  // pick a version you also support, then re-issue with adcpVersion pinned
}
```

`VERSION_UNSUPPORTED` is recovery-classified `correctable` — clients
that handle it programmatically retry against a supported version.

This is the third mechanism rather than a fallback to the first:
negotiation tells you *what's possible*; per-call pinning tells the
SDK *which one to use*.

## Putting it together

A typical multi-version production setup:

1. **Server**: declare `supported_versions: ['3.0.5', '3.1.0']` in
   capabilities. The SDK accepts both on the wire and returns
   `VERSION_UNSUPPORTED` to anyone outside the set. (Only declare a
   version your handlers actually satisfy.)
2. **Client (per peer)**: pin `adcpVersion` (e.g., `'v2.5'`) based on
   what the registry or peer's capabilities advertise. The
   client-side adapters translate the wire shape so your application
   code stays on the current spec.
3. **SDK upgrades**: bump `@adcp/sdk` on your schedule; switch to
   `createAdcpServerFromPlatform` per specialism over time; keep the
   rest on `@adcp/sdk/server/legacy/v5` until you're ready.

The combined effect: **one handler codebase, three version axes, no
fork.**

## What this saves you from building

A from-scratch agent has to:

- Maintain a translation matrix between every spec version it claims
  to support, and update it every time a release ships.
- Hand-roll API stability across its own internal refactors.
- Implement the negotiation handshake (`adcp_major_version` parsing,
  `adcp_version` cross-checks, `VERSION_UNSUPPORTED` envelope shaping
  with the supported-versions echo).
- Keep its conformance test surface in sync as new versions ship.

Each of these compounds at every spec revision. The SDK absorbs
them so your team's effort goes into L4 differentiation, not into
versioning plumbing.

See also:

- [Architecture: the AdCP stack](../architecture/adcp-stack.md)
- [Where to start](../where-to-start.md)
- [Migration 5.x → 6.x](../migration-5.x-to-6.x.md)
- [Migration 4.x → 5.x](../migration-4.x-to-5.x.md)
