# Common shape gotchas

Discriminated-union and embedded-shape patterns adopters consistently get wrong on the first pass. The strict response validators in the storyboard runner catch these at runtime; type checkers don't, because the types are technically satisfiable in the wrong shape. Each entry below: the wrong shape adopters write first, the right shape, and a one-line "why."

Five patterns surfaced repeatedly while building reference adapters (`examples/hello_seller_adapter_*.ts`) and during blind LLM matrix runs. Catching them costs 1–3 iterations of "why is this field reported missing?" — this page is the shortcut.

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
