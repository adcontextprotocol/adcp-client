# Preview asset durability

Creative workflows often return `preview_creative` renders as MCPUI preview
URLs while the buyer is still iterating. Those URLs are part of the workflow
contract: a browser, MCPUI host, later refinement call, or reviewer may fetch
them after the tool call has returned and after a load balancer has routed the
request to another process.

If a preview URL depends on process-local state, it will fail in multi-pod
deployments. A common failure mode is:

1. Pod A generates a draft creative and returns
   `/creative-sessions/{sessionId}/variants/{variantId}/assets/{assetId}`.
2. The browser or MCPUI host fetches that URL through the load balancer.
3. Pod B receives the request but does not have Pod A's in-memory session map.
4. The preview 404s even though the original tool call succeeded.

## TL;DR

- `preview_url` values should resolve through durable storage in production.
- In-memory maps are fine for local development and single-process demos, but
  not for multi-pod services.
- Treat draft bytes, hosted preview artifacts, and final campaign manifests as
  separate lifecycle stages.
- A cache of preview metadata is not an asset store. Cache entries may point at
  durable URLs; they must not be the only place the asset exists.

## Three lifecycle stages

### 1. Inline draft bytes

Use inline bytes only for small, immediate draft work: model output that has not
yet been accepted, transformed, or reviewed. Inline bytes are convenient inside
one request, but they should not be the only representation behind a URL that
will be fetched later.

Good uses:

- passing a just-generated image to a renderer in the same process
- holding a short-lived thumbnail while deciding whether to persist it
- returning `preview_html` with `bothRender` when the host also receives a
  durable `preview_url`

Avoid:

- returning a URL that can only be resolved from an in-memory `Map`
- assuming sticky sessions will always route follow-up fetches to the creator
  process

### 2. Hosted preview artifact

A hosted preview artifact is the durable resource behind `preview_url`. Store
the bytes in object storage, a database blob table, or another shared backing
service. Store the session and variant metadata in a durable index such as
Postgres so follow-up calls can resolve lineage, selection state, evaluator
notes, and current/final flags.

Recommended shape:

- object storage holds large asset bytes
- Postgres or another durable database holds session, variant, asset, and
  review metadata
- preview routes resolve by opaque IDs and stream bytes from shared storage
- URLs remain valid long enough for review, refinement, and finalization

The URL can still be short-lived if it is re-mintable from durable metadata. For
example, a route may authenticate the caller and redirect to a signed object
storage URL. The critical property is that any pod can perform that lookup.

### 3. Final campaign creative manifest

The final creative manifest is the serving artifact that moves into the campaign
or ad server workflow. It should reference approved assets and serving tags, not
an arbitrary draft cache entry. Keep the draft/session lifecycle separate so a
buyer can iterate without accidentally promoting every preview asset into a
campaign creative.

## Preview cache vs asset store

`src/lib/utils/preview-utils.ts` includes a default process-local cache for
batch preview helpers. That cache stores the result of `preview_creative`; it is
not a durable asset store and is not shared across pods.

Production services that cache preview results should pass a shared
`PreviewCacheBackend`:

```ts
import type { PreviewCacheBackend } from '@adcp/sdk';

const previewCache: PreviewCacheBackend = {
  get: key => redis.get(key).then(raw => (raw ? JSON.parse(raw) : null)),
  set: async (key, entry) => {
    await redis.set(key, JSON.stringify(entry), { EX: 3600 });
  },
  delete: async key => {
    await redis.del(key);
  },
};
```

Only cache references that already resolve durably. If the cached `previewUrl`
points at process-local bytes, a shared cache only makes the broken reference
available to more callers.

## `preview_creative` response guidance

Return `urlRender` or `bothRender` when the preview needs to be opened by a
browser or MCPUI host. `htmlRender` alone is only appropriate when the caller can
use inline HTML directly and no later fetch is required.

For `urlRender` and `bothRender`, make sure `preview_url` is backed by a durable
route:

```ts
import { urlRender } from '@adcp/sdk';

return {
  previews: [
    {
      preview_id: variant.id,
      renders: [
        urlRender({
          render_id: variant.primaryRenderId,
          role: 'primary',
          preview_url: `https://creative.example/previews/${variant.assetId}`,
        }),
      ],
    },
  ],
};
```

The route should be able to resolve `variant.assetId` from shared storage from
any pod. Do not require the serving process to have created the variant in the
same process lifetime.

## Checklist

- Store creative session metadata durably before returning a preview URL.
- Store large preview bytes in shared storage, or make them re-mintable from a
  durable source of truth.
- Make preview asset IDs opaque; do not expose filesystem paths or internal
  storage keys directly.
- Treat memory caches as accelerators only. A cache miss should rehydrate from
  durable storage or return a real not-found/error state.
- Test with at least two app instances and route the fetch to a different
  instance than the one that generated the preview.
