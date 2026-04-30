# Specialism: sales-broadcast-tv

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-broadcast-tv`.

Storyboard: `media_buy_broadcast_seller`. Broadcast has four protocol surfaces not used in digital.

**Pricing** — unit-based (cost per spot). Until a `pricing_model: 'unit'` lands, express as CPM with a very high `fixed_price` that represents the cost per thousand spots equivalent, or use a custom pricing option ID and clarify in `description`.

**Agency estimate number** — top-level on `create_media_buy`. Echo it on the response:

```typescript
{
  media_buy_id,
  agency_estimate_number: params.agency_estimate_number,  // "PNNL-NM-2026-Q4-0847"
  status: 'submitted',
  // ...
}
```

**Measurement terms** — per-package on the request:

```typescript
packages: [
  {
    product_id: 'primetime_30s_mf',
    measurement_terms: {
      billing_measurement: {
        vendor: { domain: 'videoamp.com' },
        measurement_window: 'c7',
        max_variance_percent: 10,
      },
    },
  },
];
```

Echo `measurement_terms` on the response's package entries — the buyer uses `c7` as the guarantee basis for reconciliation.

**Ad-ID on creatives** — `sync_creatives` rejects spots without a valid Ad-ID:

```typescript
syncCreatives: async (params) => ({
  creatives: params.creatives.map((c) => {
    const adId = c.industry_identifiers?.find((x) => x.type === 'ad_id')?.value;
    if (!adId) return { creative_id: c.creative_id, action: 'created', status: 'rejected',
      rejection_reason: 'Ad-ID required for broadcast spots' };
    return { creative_id: c.creative_id, action: 'created', status: 'accepted' };
  }),
}),
```

**Measurement windows on products** — `reporting_capabilities.measurement_windows` is an **array of objects**, not string enum values. Each window object must match `MeasurementWindowSchema`:

```typescript
reporting_capabilities: {
  // ...standard reporting fields...
  measurement_windows: [
    { window_id: 'live', duration_days: 0, expected_availability_days: 1,  is_guarantee_basis: false },
    { window_id: 'c3',   duration_days: 3, expected_availability_days: 4,  is_guarantee_basis: false },
    { window_id: 'c7',   duration_days: 7, expected_availability_days: 8,  is_guarantee_basis: true },
  ],
}
```

Don't declare `measurement_windows: ['live', 'c3', 'c7']` — the Zod schema rejects bare strings and your product won't validate.

**Measurement windows on delivery** — each delivery row tags `measurement_window: 'live' | 'c3' | 'c7'`, `is_final: boolean`, and `supersedes_window` (for window upgrades). Live ratings mature in 24h, C3 in ~4d, C7 in ~8d. Final reconciliation lands ~15d after last air date.

**Emit window_update webhooks** via `ctx.emitWebhook` (see [§ Webhooks](#webhooks-async-completion-signed-outbound) above). Use `operation_id: \`window_update.${media_buy_id}.${stage}\`` so C3 → C7 supersession retries share a stable idempotency_key.
