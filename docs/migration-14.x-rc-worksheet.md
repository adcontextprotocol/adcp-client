# SDK 14 release-bound upgrade worksheet

This page joins the release facts that adopters need before changing a production pin. It is generated from package and version metadata with `npm run generate-release-worksheet`; migration decisions remain documented in [Migrating from 13.x to the 14 prerelease](./migration-13-to-14.md).

## Release represented by this checkout

The changesets version lifecycle regenerates this section whenever the package
version changes. For an unpublished candidate, integrity is intentionally shown
as unavailable until the registry assigns it; use the exact registry command
below as the publication/deployment gate.

| Fact | Value |
| --- | --- |
| Exact npm package | `@adcp/sdk@14.0.0-rc.45` |
| npm integrity | registry-derived after publication; run `npm view @adcp/sdk@14.0.0-rc.45 dist.integrity` |
| Node.js runtime | `^20.19.0 || >=22.12.0` |
| Default AdCP wire release | `3.2.0-rc.4` |
| Maintained wire releases | `v2.5`, `v2.6`, `v3`, `3.0.0`, `3.0`, `3.0.1`, `3.0.2`, `3.0.3`, `3.0.4`, `3.0.5`, `3.0.6`, `3.0.7`, `3.0.8`, `3.0.9`, `3.0.10`, `3.0.11`, `3.0.12`, `3.0.13`, `3.0.14`, `3.0.15`, `3.0.16`, `3.0.17`, `3.0.18`, `3.0.19`, `3.0.20`, `3.0.21`, `3.0.22`, `3.0.23`, `3.0.24`, `3.0.25`, `3.1.0`, `3.1`, `3.1.1`, `3.1.2`, `3.1.3`, `3.1.4`, `3.1.5`, `3.1.6`, `3.1.7`, `3.1.8`, `3.1.9`, `3.1.10`, `3.1.11`, `3.1.12`, `3.1.13`, `3.1.14`, `3.1.15`, `3.1.16`, `3.1.17`, `3.1.18`, `3.2.0-rc.4`, `3.2-rc.4` |
| Canonical migration notes | [13.x → 14](./migration-13-to-14.md) |

Install exact production inputs rather than a moving prerelease range:

```bash
npm install --save-exact '@adcp/sdk@14.0.0-rc.45'
npm view '@adcp/sdk@14.0.0-rc.45' dist.integrity
```

### Required and optional peers

Install the peer packages used by your application at versions satisfying these release ranges. A2A and MCP calls continue to use their official protocol clients.

| Peer | Supported range | Installation |
| --- | --- | --- |
| `@a2a-js/sdk` | `^1.0.1` | Required |
| `@modelcontextprotocol/sdk` | `^1.24.0` | Required |
| `@opentelemetry/api` | `^1.0.0` | Optional |
| `redis` | `^4.6.0 || ^5.0.0 || ^6.0.0` | Optional |
| `zod` | `^4.1.5` | Required |

## Schema access and validation tiers

| Tier | Public route | Intended use | Normative behavior |
| --- | --- | --- | --- |
| Convenience Zod schemas | Generated values such as `GetReportingStatusResponseSchema` from `@adcp/sdk/schemas` | Application parsing and typed integration | SDK convenience surface; do not substitute it for protocol conformance |
| Runtime AJV validation | Automatic client/server validation | Live wire traffic with extensible response envelopes | Response roots may be relaxed for envelope compatibility; diagnostics are bounded for runtime input |
| Canonical JSON Schema validation | `getCanonicalToolValidator()` from `@adcp/sdk/schemas` | Offline conformance checks and CI | Exact selected protocol documents, no response-root relaxation, all AJV errors collected |
| Bundled tool descriptor | `getToolInputSchema()` and `getToolResponseSchema()` | Schema publication and MCP registration | Self-contained, pre-resolved descriptor retained for compatibility; returns a caller-owned document, not a compiled validator |
| Raw authored document | `getSchemaDocumentByRef()` | Immutable graph inspection and custom tooling | Callers traversing `$ref` must register the complete selected-version graph and preserve nested `$id` scopes |

The canonical validator compiles the complete selected bundle offline and does
not fetch references at runtime. Unknown tools return `undefined`; unresolved,
unknown, or cross-version references fail compilation rather than falling back
to another bundled release. It is deliberately not the live-response validator:
transport envelope extensions accepted by the SDK runtime can be rejected by
the authored tool schema.

ESM example:

```ts
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';

const validate = getCanonicalToolValidator('get_reporting_status', 'sync', {
  adcpVersion: '3.2.0-rc.4',
});
if (!validate) throw new Error('Requested protocol schema is unavailable');

const valid = {
  status: 'failed',
  view: 'summary',
  failure_kind: 'lookup_unavailable',
  message: 'Reporting status resource is unavailable.',
  errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
};
if (!validate(valid)) throw new Error(JSON.stringify(validate.errors));

const invalid = { status: 'completed', view: 'summary' };
if (validate(invalid)) throw new Error('Invalid control unexpectedly passed');
console.error(validate.errors); // all collected normative violations
```

CommonJS uses the same packed-artifact export:

```js
const { getCanonicalToolValidator } = require('@adcp/sdk/schemas');
const validate = getCanonicalToolValidator('get_reporting_status', 'sync', {
  adcpVersion: '3.2.0-rc.4',
});
if (!validate) throw new Error('Requested protocol schema is unavailable');
if (validate({ status: 'completed', view: 'summary' })) {
  throw new Error('Invalid control unexpectedly passed');
}
console.error(validate.errors);
```

## Historical worked example: rc.33/rc.35 → rc.36

This example is intentionally retained as the concrete migration that introduced
the rc.2 wire pin; it does not change when a later SDK candidate is released.

1. Change the exact SDK pin from `14.0.0-rc.33` or `14.0.0-rc.35` to `14.0.0-rc.36` and verify that historical release with `npm view @adcp/sdk@14.0.0-rc.36 dist.integrity`.
2. Upgrade communicating 3.2 peers together. rc.33 and rc.35 defaulted to AdCP `3.2.0-rc.1`; rc.36 defaults to `3.2.0-rc.2` and no longer advertises the superseded rc.1 pin as compatible.
3. Preserve an existing server's explicit `defaultAdcpVersion`. Raising the supported ceiling to rc.2 must not silently move unversioned callers off the release the application chose to serve by default.
4. Audit durable idempotency records containing malformed lone UTF-16 surrogates. rc.36 preserves distinct malformed payloads in request fingerprints, so a request that previously collided may now correctly return an idempotency conflict. Well-formed request fingerprints do not change.
5. Run mixed-version integration coverage for every release your deployment still advertises, then deploy all rc.2-speaking peers before sending rc.2-only payloads.

The complete behavioral inventory, including server-default separation and A2A 1.0 peer requirements, is in the [13.x → 14 migration guide](./migration-13-to-14.md).
