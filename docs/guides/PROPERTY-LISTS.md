# Property lists: matching, registry contribution, and serving

## Buyer enforcement

`validation.productPropertyPolicy` reads `get_products.filters.property_list`
and the deprecated top-level `property_list`. When both are present they must
have the same `agent_url`, `list_id`, and `auth_token`; conflicting references
fail closed with `property_list_conflicting_references`. A malformed nested
reference never falls back to the top-level field. The same reference is kept
for polling, tracking, and webhook completions.

These location and mixed-identifier fixes ship together. As before, request
list enforcement defaults to enabled. Set `enforceRequestPropertyList: false`
to disable local resolution, or `productPropertyPolicy: false` to disable the
policy entirely. Resolution errors (including a non-MCP list URL) fail closed.

Lists may mix domains, app bundles, and CTV store IDs. Non-domain types no
longer cause an unconditional response failure. A product's
`publisher_properties` contains publisher selectors, not app IDs: `property_ids`
are opaque names scoped to a publisher. Supply complete catalogs to match
their real identifiers:

```typescript
import { AdCPClient, type ProductPolicyResolvedProperty } from '@adcp/sdk';

declare const loadPublisherCatalog: (
  domain: string
) => Promise<readonly ProductPolicyResolvedProperty[] | undefined>;

const client = new AdCPClient(agents, {
  validation: {
    productPropertyPolicy: {
      enforceRequestPropertyList: true,
      unknownSelectorBehavior: 'flag',
      resolvePublisherProperties: loadPublisherCatalog,
    },
  },
});
```

The resolver receives normalized, untrusted publisher hostnames and an optional
`{ signal }` argument. It returns the complete
catalog of `{ property_id?, identifiers: [{ type, value }], tags? }` records
from your publisher metadata store or discovery layer. Alternatively provide
`publisherProperties: { [publisherDomain]: catalog }` directly. Keys use the exact
normalized publisher hostname, including `www.` when present; catalogs are not
shared across host aliases. When catalogs are configured, missing or failed
lookups mean unknown metadata; `[]` means a known empty catalog. This hook does
not initiate any additional registry or publisher lookups unless you implement
them. Identifier type and value must match exactly for non-domain identifiers;
bundle casing is preserved. `all`, `by_id`, and `by_tag` selectors are resolved
against these records. Products with `property_targeting_allowed: true` may
retain a proven eligible subset; other products must satisfy the policy for
every selected property.

Catalog loading is limited to 100 distinct lookups per response, 10 seconds
per lookup, and a 10-second total budget by default (`maxPublisherLookups`,
`publisherLookupTimeoutMs`, `publisherLookupBudgetMs`).
Overflow and failed/timed-out lookups stay unknown even when a domain matches.
Literal IP and localhost inputs do not reach the hook. For network discovery,
use the SDK's SSRF-safe networking utilities to protect DNS resolution too;
catalog identity/ownership verification remains the catalog provider's job.

Products whose membership cannot be judged follow `unknownSelectorBehavior`
(`allow`, `flag`, or `reject`). Request-derived policies remain strict by
default, so the default unknown behavior is `reject`; choose `flag` explicitly
to retain uncertain products. Known disallowed properties still reject even
when another property is unknown. Diagnostics appear under
`metadata.productPropertyPolicy`, including per-product
`unresolved_property_identifiers` / `identifier_types` and
`request_property_list.unsupported_identifier_types` for unrecognized types.

## Identifier normalization and registration

`normalizePropertyIdentifier(type, value)` (also exported as
`validatePropertyIdentifier`) returns either `{ ok: true, value, rewrite? }`
or `{ ok: false, error: IdentifierValidationError }`. Named normalizers cover
domain, subdomain, iOS/Android bundles, Apple/Google/Roku/Samsung store IDs,
Fire TV ASINs, and Apple TV/generic bundles. Each normalizer validates too.

Domain normalization accepts HTTP(S) URLs and reports their reduction to a
hostname, lowercases IDNs, and preserves wildcards. It preserves `www.` and
`m.` because removing those labels would broaden an explicit allowlist.
`subdomain` rejects wildcards. Platform names preserve case; numeric IDs stay
strings without losing precision. Formats for app/store identifiers are SDK
input hygiene rules, not assertions of registration, ownership, or existence.
Opaque identifier families retain their spelling (including station names
with spaces). Use these opt-in helpers before storing or matching values:

```typescript
import { normalizePropertyIdentifier } from '@adcp/sdk';

const checked = normalizePropertyIdentifier('domain', submittedValue);
if (!checked.ok) throw checked.error;
await identifierStore.save({ type: 'domain', value: checked.value });
// checked.rewrite, when present, records { from, to } for your review/audit UI.
```

`validatePublisherDomain(value)` is deliberately stricter: a publisher
registration must already be a lowercase bare hostname. URLs, wildcards,
ports, whitespace, trailing dots, malformed labels, and IP literals reject
with `IdentifierValidationError.code === 'invalid_publisher_domain'`.
`RegistryClient.saveProperty()` always performs this validation before HTTP.
`saveProperties()` uses the same check for every record; failed records retain
the existing `error` string and expose the typed error as `cause`.

## Bulk catalog contribution

`resolveIdentifiers()` in default `resolve` mode is the primary bulk catalog
registration path: it contributes provenance, creates missing entries, and
returns stable `property_rid` handles. Use `mode: 'lookup'` for read-only lookup.
A RID is a join handle and does not grant advertising authorization.

```typescript
import { RegistryClient, isRegistryRequestError } from '@adcp/sdk';

const registry = new RegistryClient({ apiKey: process.env.ADCP_REGISTRY_API_KEY });
const outcomes = await registry.resolveIdentifiersAll({
  identifiers,
  provenance: { type: 'agency_allowlist', context: campaignId },
  // Omit mode to register/contribute. Use mode: 'lookup' for a pure read.
}, {
  batchSize: 10_000,
  maxRequestBytes: 1024 * 1024,
  concurrency: 2,
  maxRetries: 3,
  maxRetryDelayMs: 60_000,
});

for (const outcome of outcomes) {
  if (outcome.success) useCatalogHandle(outcome.identifier, outcome.result.property_rid);
  else if (isRegistryRequestError(outcome.error)) {
    reportRegistryFailure(outcome.index, outcome.error.status, outcome.error.retryAfterMs);
  } else reportInputFailure(outcome.index, outcome.error);
}
```

The helper caps each request at 10,000 identifiers and the configured UTF-8
JSON byte limit, including provenance. It limits concurrency, honors
`retryAfterMs` on HTTP 429, and returns an outcome for each input in input order,
including duplicates. Oversized individual items, missing/malformed response
entries, and failed batches become per-input errors; successful batches remain
available. Inputs should already use canonical identifier spelling so registry
results can be correlated by type and value. Empty input returns `[]`.

Only rate limits are retried automatically. A server delay exceeding
`maxRetryDelayMs` stops pending requests and returns the typed 429 (including
its `retryAfterMs`) for callers to reschedule, without retrying early.
Network and 5xx failures may have
already contributed activity: identifier-to-RID resolution is idempotent, but
the activity log is additive. The single-call API guards the 10,000-item limit;
use the helper for byte-based splitting. `/api/registry/resolve` accepts responses
up to 16 MiB by default; explicit `RegistryClientConfig.maxBodyBytes` still wins.

Use `saveProperty()` when publishing or updating hosted publisher
configuration (names, property identities, tags), rather than contributing a
large identifier catalog. `saveProperties()` is a bounded client-side fan-out
over that endpoint, intended for configuration updates. Its results are keyed
by publisher domain; submit one configuration per domain.

Registry HTTP failures use the exported `RegistryRequestError` /
`isRegistryRequestError` contract, with `status`, `method`, `retryAfterMs`, and
bounded untrusted `details`. Do not parse `error.message` for status or retry
timing. Input validation and transport failures are separate errors.

## Serve buyer-issued references over MCP

`registerPropertyListTool` registers a real MCP `get_property_list` tool using
the official MCP server. The reference's `auth_token` must authorize its exact
`list_id`. It arrives in `Authorization: Bearer` or `x-adcp-auth`, never as a
tool argument. The verifier runs before storage is read, on every page.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serve } from '@adcp/sdk';
import { registerPropertyListTool } from '@adcp/sdk/server';

serve(() => {
  const server = new McpServer({ name: 'Buyer property lists', version: '1.0.0' });
  registerPropertyListTool(server, {
    verifyToken: ({ listId, token }) => listStore.verifyListToken(listId, token),
    loadPage: (request, principal) => listStore.loadAuthorizedPage(request, principal),
  });
  return server;
}, {
  path: '/property-lists/mcp',
  publicUrl: 'https://buyer.example/property-lists/mcp',
  authenticate: listEndpointAuthenticator,
});
```

Use your list endpoint's authenticator to validate list tokens globally and
return `{ principal, token }`; the per-tool verifier still checks exact list
access. Mount this read-only endpoint separately if your normal platform auth
only accepts account bearers. Its proxy/auth middleware must allow the list
token through. Ordinary MCP initialization needs no list ID. The helper also
supports raw HTTP headers when a transport does not populate `authInfo`.
It denies conflicting credentials and does not expose verifier/storage errors.

`loadPage` receives a verified principal and the validated request, including
`resolve` and `pagination`. Return `{ list, identifiers, pagination?,
resolved_at?, cache_valid_until? }`. The list includes at least `list_id` and
`name`; `identifiers` must be an array when resolving, including `[]` for an
empty list. For `resolve: false`, return metadata without resolving identifiers.
Honor the requested page limit (default 1,000; maximum 10,000). Provide a
nonempty continuation cursor only when `has_more` is true, and bind cursors to
the list, principal, and catalog revision. `list.property_count` is the total
property count, not the current page's identifier count. Return coherent
`cache_valid_until` timestamps across pages. The helper adds completion status
and echoes request context on success and errors.

Issue references whose `agent_url` points at this MCP endpoint. A plain REST
URL returning JSON does not implement `get_property_list`.

## Signed change notifications and certification

Use your configured SDK `WebhookEmitter` (or the emitter from
`createPostgresWebhookRuntime`) so signing, bounded retries, durable delivery
bindings, and crash recovery use the same infrastructure as other webhooks:

```typescript
import { sendPropertyListChanged } from '@adcp/sdk/server';

const result = await sendPropertyListChanged(
  webhooks.emitter.forTenantScope(trustedTenantId),
  {
    url: subscriber.webhookUrl,
    delivery_id: persistedDeliveryId,
    notification: {
      list_id: changedListId,
      resolved_at: resolvedAt.toISOString(),
      change_summary: { properties_added: added, properties_removed: removed, total_properties: total },
    },
  },
);
```

Retain the same delivery ID and exact notification for retries. Each distinct
event/subscriber delivery needs its own ID. The helper selects RFC 9421,
includes the compatibility marker `signature: 'rfc9421'`, and lets the emitter
bind a stable cryptographic `idempotency_key`. It sends a summary; receivers
refresh through `get_property_list`. Configure production delivery storage,
recovery, signing keys, and per-attempt subscription authorization on the
emitter; see [the runtime reference](../TYPE-SUMMARY.md#postgresql-webhook-runtime).

Before certifying a buyer, resolve references it actually issued:

```typescript
import { runPropertyListConformance, runConformance } from '@adcp/sdk/conformance';

const report = await runPropertyListConformance(issuedReferences);
if (report.totalFailures) throw new Error('Buyer-issued property lists are not resolvable');

// Or include them in the main certification report/failure count:
const fullReport = await runConformance(buyerAgentUrl, {
  propertyListReferences: issuedReferences,
});
```

Certification disables caches, validates each resolved page, checks list
identity, rejects failure envelopes/oversized pages/cursor cycles, and uses
the same MCP resolver as sellers. Reports identify inputs by index and never
echo the reference token, URL, or remote exception. Empty lists are valid;
unresolvable references fail the report rather than silently certifying.
