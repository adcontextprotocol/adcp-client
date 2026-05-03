# Common shape gotchas

Discriminated-union and embedded-shape patterns adopters consistently get wrong on the first pass. The strict response validators in the storyboard runner catch these at runtime; type checkers don't, because the types are technically satisfiable in the wrong shape. Each entry below: the wrong shape adopters write first, the right shape, and a one-line "why."

Six patterns surfaced repeatedly while building reference adapters (`examples/hello_{seller,creative,signals}_adapter_*.ts`) and during blind LLM matrix runs. Catching them costs 1–3 iterations of "why is this field reported missing?" — this page is the shortcut.

---

## 1. `ActivationKey` `oneOf` — `key`/`value` are top-level, not nested

When returning `activate_signal` deployments with `type: 'key_value'` activation keys, `key` and `value` sit at the TOP level of `activation_key`. NOT nested under a `key_value` sub-field.

✗ Wrong (intuitive — the discriminator name *suggests* nesting):

```ts
activation_key: {
  type: 'key_value',
  key_value: { key: 'segment', value: 'abc123' },
}
```

✓ Right (matches `/schemas/3.0/core/activation-key.json` `oneOf[1]`):

```ts
activation_key: {
  type: 'key_value',
  key: 'segment',
  value: 'abc123',
}
```

`value` MUST be a string. The schema allows a `segment_id` variant for platform-segment-id activations:

```ts
activation_key: { type: 'segment_id', segment_id: 'plat_seg_xyz' }
```

— same flatness, single string ID under the discriminator.

---

## 2. `signal_ids` is `signal_id[]` (provenance objects), not `string[]`

`get_signals` accepts a `signal_ids` filter to look up specific signals by data-provider provenance. The filter is an array of provenance tuples, NOT bare ID strings.

✗ Wrong:

```ts
{ signal_ids: ['cohort_abc', 'cohort_xyz'] }
```

✓ Right (matches `/schemas/3.0/core/signal-id.json`):

```ts
{
  signal_ids: [
    { source: 'catalog', data_provider_domain: 'tridentauto.example', id: 'likely_ev_buyers' },
    { source: 'catalog', data_provider_domain: 'tridentauto.example', id: 'purchase_propensity' },
  ],
}
```

`SignalID` is a discriminated union: `source: 'catalog'` (with `data_provider_domain` + `id`) or `source: 'agent'` (with `agent_url` + `id`). When implementing the filter on the seller side, narrow on `source` before reading `data_provider_domain` — only the catalog variant has it.

---

## 3. `VASTAsset` requires an embedded `delivery_type` discriminator

`asset_type: 'vast'` is itself a discriminator at the asset level. A *second* discriminator (`delivery_type`) picks between inline VAST XML and a redirect URL. Both are required; you can't pass `content` or `vast_url` without `delivery_type`.

✗ Wrong (flat `content` without `delivery_type`):

```ts
{ asset_type: 'vast', content: '<VAST version="4.2">...</VAST>' }
```

✓ Right — inline VAST:

```ts
{ asset_type: 'vast', delivery_type: 'inline', content: '<VAST version="4.2">...</VAST>' }
```

✓ Right — redirect VAST:

```ts
{ asset_type: 'vast', delivery_type: 'redirect', vast_url: 'https://ad-server.example/vast/abc.xml' }
```

Same pattern applies to `DAASTAsset` (audio).

---

## 4. `PreviewCreativeResponse` is a three-way discriminated union

`preview_creative` returns one of `single | batch | variant`, with `response_type` as the discriminator. Even single-preview responses use the `previews[]` ARRAY shape — the validator grades per variant and won't accept a flat single-preview shape.

✗ Wrong (flat object, no discriminator):

```ts
{ preview: { type: 'url', url: 'https://...', expires_at: '...' } }
```

✓ Right (single-variant `previews[]` array):

```ts
{
  response_type: 'single',
  previews: [
    {
      preview_id: 'prv_abc',
      renders: [
        {
          render_id: 'rnd_1',
          output_format: 'url',
          preview_url: 'https://preview.example/abc',
          role: 'primary',
        },
      ],
      input: { name: 'default' },
    },
  ],
  expires_at: '2026-05-03T00:00:00Z',
}
```

Each `PreviewRender` requires `render_id`, `output_format: 'url'` (or `'inline_html'`), `preview_url`, and `role`. Don't omit `role` — the validator requires it.

---

## 5. `BuildCreativeReturn` has 4 valid shapes — framework auto-wraps the bare manifest

`build_creative` handlers can return any of:

```ts
type BuildCreativeReturn =
  | CreativeManifest                    // bare single — framework wraps as { creative_manifest: <obj> }
  | CreativeManifest[]                  // bare multi  — framework wraps as { creative_manifests: <arr> }
  | BuildCreativeSuccess                // shaped single — passthrough; you set sandbox/expires_at/preview
  | BuildCreativeMultiSuccess           // shaped multi  — passthrough
```

Easy mistake: return a bare `CreativeManifest` and confirm the response *seems* fine via tests that read `response.format_id` directly. The wire shape after framework wrapping is `response.creative_manifest.format_id` — a level deeper. Storyboards check the wire path; if you didn't go through the framework wrapper in your test, the storyboard will surface "field missing at `creative_manifest.format_id`" while your local test passes.

If you need to set `sandbox: true` or attach `preview` previews, return the shaped envelope directly:

```ts
return {
  creative_manifest: { format_id: { agent_url, id }, assets },
  sandbox: true,
  expires_at: '2026-05-03T00:00:00Z',
};
```

---

## 6. `log_event` projection for walled-garden CAPIs

Sales-social adopters fronting walled-garden conversion APIs translate AdCP's `log_event` wire shape onto the upstream CAPI's. Three projections trip every walled-garden integration on the first pass — the upstream returns `400` and the AdCP wire surface gives no hint that the field name or encoding was the problem.

| AdCP wire (`Event`)                                                            | Walled-garden CAPI                                                                          | Translation                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `event_type` (string)                                                          | `event_name` (string)                                                                       | rename on the way out                                                        |
| `event_time` (ISO 8601 string)                                                 | `event_time` (UNIX seconds, number)                                                         | `Math.floor(new Date(t).getTime() / 1000)`                                   |
| `user_match` (`hashed_email` / `hashed_phone` / `uids[]` / `click_id` / `client_ip`+`client_user_agent`) | `user_data.{email_sha256,phone_sha256,external_id_sha256}` (≥1 required) | map per the upstream's identifier types; drop events with empty `user_match` |

### 6.1 `event_name`, not `event_type`

✗ Wrong (passes AdCP type-check, fails the walled-garden 400):

```ts
upstream.trackEvents({ events: req.events });
```

✓ Right:

```ts
upstream.trackEvents({
  events: req.events.map(e => ({
    event_name: e.event_type,
    // …other fields…
  })),
});
```

### 6.2 UNIX seconds, not ISO 8601

✗ Wrong:

```ts
{ event_time: e.event_time }                 // '2026-04-05T14:30:00Z'
```

✓ Right:

```ts
{ event_time: Math.floor(new Date(e.event_time).getTime() / 1000) }
```

### 6.3 Hashed-identifier requirement — read `Event.user_match`, drop on empty

Every walled-garden CAPI rejects events without at least one matchable identifier in `user_data` — typically `email_sha256`, `phone_sha256`, or `external_id_sha256` (64-char lowercase hex SHA-256). The AdCP wire field is `Event.user_match` (per `/schemas/3.0.4/core/user-match.json` — `hashed_email`, `hashed_phone`, `uids[]`, `click_id`, `client_ip`+`client_user_agent`). Project it onto the upstream's `user_data` shape; **drop events with empty `user_match`** rather than synthesize a fake identifier.

```ts
const userData: { external_id_sha256?: string; email_sha256?: string; phone_sha256?: string } = {};
if (e.user_match?.hashed_email) userData.email_sha256 = e.user_match.hashed_email;
if (e.user_match?.hashed_phone) userData.phone_sha256 = e.user_match.hashed_phone;
const firstUid = e.user_match?.uids?.[0]?.value;
if (firstUid && /^[a-f0-9]{64}$/.test(firstUid)) userData.external_id_sha256 = firstUid;
if (Object.keys(userData).length === 0) continue; // drop unmatchable events
```

✗ **Do not** synthesize `external_id_sha256` from `event_id` (or any non-identity field). `event_id` is a buyer-side dedup string per `/schemas/3.0.4/core/event.json`; hashing it and shipping as a stable user identifier fabricates a matching signal the buyer never granted, joins unrelated events as the "same user" in the platform's identity graph, and pollutes attribution. The defensible behavior is to drop unmatchable events and surface the delta via `events_received` − `events_processed` so the buyer can populate `user_match` and retry.

The `examples/hello_seller_adapter_social.ts` reference adapter codifies all three patterns in its `logEvent` handler; build-seller-agent §sales-social references this section, and AdCP's `createTranslationMap` helper (#1285) handles the buyer→upstream id mapping when the buyer carries a `media_buy_id` that needs translation to an upstream pixel-source id.

---

## How to debug a "Field not found at path: …" error fast

The validator's path naming is precise. When you see:

```
✗ Response matches schema: : Invalid input;
✗ Field not found at path: deployments[0].activation_key
```

Three steps:

1. Find the schema file the validator names (typically `/schemas/3.0/<protocol>/<task>-response.json` or `/schemas/3.0/core/<type>.json`).
2. Inside the schema, find the `oneOf` (or `anyOf`) at that path. The error path tells you which variant the validator was trying to match.
3. Compare the schema's required fields to your actual response. The wrong shape tells you which discriminator branch you accidentally landed on.

Schemas are the authoritative spec for shape. Prose around the schema (in skills, in field descriptions) is supplementary — when prose and schema disagree, the schema wins, and the validator agrees with the schema.
