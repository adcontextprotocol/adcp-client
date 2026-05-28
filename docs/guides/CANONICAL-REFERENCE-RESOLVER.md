# Canonical Reference Resolver

AdCP 3.1 `format_schema` and `platform_extensions` references use the same immutable pointer shape:

```ts
{ uri: 'https://publisher.example-ad.com/schema.json', digest: 'sha256:<64 lowercase hex chars>' }
```

Use `@adcp/sdk/canonical-references` instead of hand-rolled fetch code. The resolver applies the SDK SSRF guard, pins DNS before connecting, disables redirects, enforces a 5 second default timeout, caps bodies at 1 MiB by default, verifies the SHA-256 digest, and caches successful fetched root documents by a policy-scoped `uri@digest` key.

```ts
import { createCanonicalReferenceResolver } from '@adcp/sdk/canonical-references';

const resolver = createCanonicalReferenceResolver();

const formatSchemaRef = {
  uri: 'https://publisher.example-ad.com/schemas/slot.json',
  digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const extensionRef = {
  uri: 'https://publisher.example-ad.com/extensions/slot.json',
  digest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
};

const schemaResult = await resolver.resolveFormatSchema(formatSchemaRef, {
  externalRefDigests: {
    'https://publisher.example-ad.com/shared-slot.json':
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
});

if (schemaResult.ok) {
  // schemaResult.document is a JSON Schema with pinned, safe $refs inlined.
  // schemaResult.schemaMeta is present for this path.
} else if (schemaResult.error.code === 'digest_mismatch') {
  // Treat as a substitution-attack signal, not a retryable network failure.
}

const extensionResult = await resolver.resolvePlatformExtensions(extensionRef);
```

## Result Shape

The API is structured and non-throwing. Branch on `result.ok` first, then `result.error.code` for programmatic handling.

Successful results include `document`, `body`, `text`, `httpStatus`, `contentType`, `cacheKey`, and `fromCache`. `resolveFormatSchema()` additionally returns `schemaMeta` with draft, `$ref` count, max `$ref` depth observed, keyword count, and compile time.

Failure statuses are coarse buckets: `unresolvable`, `invalid_document`, `invalid_schema`, `digest_mismatch`, `blocked_unsafe_url`, and `invalid_ref`. The more precise field is `error.code`, including `http_error`, `network_error`, `invalid_json`, `external_ref_unpinned`, `ref_sandbox_violation`, `keyword_limit_exceeded`, `budget_exceeded`, and `digest_mismatch`.

Transient network and 5xx failures return `unresolvable` with `error.retryable: true`. Digest mismatch returns `digest_mismatch` with `error.securitySignal: 'substitution_attack'`.

## Format Schemas

`resolveFormatSchema()` requires an explicit `$schema` and validates the fetched document as Draft-07 or Draft 2020-12 JSON Schema. It sandboxes `$ref` to intra-document, same-origin, or trusted Agentic Advertising mirror refs, rejects `file://`, `http://`, private-network and metadata refs by default, and enforces `$ref` depth/count plus keyword, regex-safety, and compile-time bounds. Regexes with known catastrophic shapes, such as nested unbounded quantifiers in a repeated group, fail as `invalid_schema` with `error.code: 'budget_exceeded'`.

External `$ref` bodies are mutable unless pinned. The canonical resolver therefore requires `externalRefDigests` for every external `$ref` URI. Missing pins return `invalid_schema` with `error.code: 'external_ref_unpinned'`; mismatched pins return `digest_mismatch`. Successful external refs share the same policy-scoped cache as root canonical references.

## Options

| Option | Default | Notes |
|---|---:|---|
| `cache` | fresh per resolver | Caller-owned cache. Entries are cloned on read/write and scoped by security policy. |
| `timeoutMs` | `5000` | Per-fetch timeout. |
| `maxBodyBytes` | `1048576` | Per-body cap for top-level and external ref fetches. |
| `externalRefDigests` | none | Required for every external `$ref` in `format_schema`. |
| `maxTotalRefBytes` | `8388608` | Cumulative external `$ref` body cap. |
| `maxRefResolutionMs` | `5000` | Total wall-clock budget across external `$ref` resolution. |
| `maxRefDepth` | `8` | Transitive `$ref` depth ceiling. |
| `maxRefCount` | `256` | Total `$ref` count ceiling. |
| `maxKeywords` | `10000` | Approximate JSON Schema keyword/object-key ceiling before Ajv compile. |
| `validationBudgetMs` | `250` | Post-compile telemetry budget; schemas exceeding it fail. |
| `allowUnsafeHttp` | `false` | Test/dev-only loopback fixture escape hatch. |
| `allowPrivateNetwork` | `false` | Test/dev-only private-network fixture escape hatch. Metadata/link-local remains blocked. |

The legacy `@adcp/sdk/v2/format-schema` helpers still support the older `ADCP_ALLOW_INTERNAL_PROBES=1` test pattern. The canonical resolver uses explicit per-call/per-resolver options instead, so production code cannot inherit a relaxed environment flag accidentally.
