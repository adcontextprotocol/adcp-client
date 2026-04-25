# Specialism: audience-sync

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `audience-sync`.


Storyboard: `audience_sync`. Track is `audiences` — separate from the core seller lifecycle, but lives in this skill because identifier sync and account discovery sit next to media-buying.

Required tools: `sync_audiences` and `list_accounts`. `sync_audiences` is overloaded — it handles three cases through its request payload:

- **Discovery**: call with no `audiences` array (or empty). Returns the audiences already on the platform for the account.
- **Add**: each audience entry has an `add: [{ hashed_email }, { hashed_phone }, ...]` array of hashed identifiers.
- **Delete**: each audience entry has `delete: true`.

There is no separate `delete_audience` tool — deletion rides on `sync_audiences`.

```typescript
createAdcpServer({
  accounts: {
    syncAccounts: /* baseline */,
    listAccounts: async (params, ctx) => {
      const { items } = await ctx.store.list('accounts');
      const brandFilter = params.brand?.domain;
      return { accounts: brandFilter ? items.filter((a) => a.brand.domain === brandFilter) : items };
    },
  },
  eventTracking: {
    syncAudiences: async (params, ctx) => {
      // Discovery mode — no audiences in request
      if (!params.audiences?.length) {
        const { items } = await ctx.store.list('audiences');
        return { audiences: items.map((a) => ({ audience_id: a.audience_id, name: a.name, status: 'active' as const })) };
      }
      // Add / delete mode
      return {
        audiences: await Promise.all(params.audiences.map(async (a) => {
          if (a.delete) {
            await ctx.store.delete('audiences', a.audience_id);
            return { audience_id: a.audience_id, name: a.name, action: 'deleted' as const, status: 'inactive' as const };
          }
          const identifiers = a.add ?? [];
          const uploaded = identifiers.length;
          const matched = Math.floor(uploaded * 0.72);   // simulated match rate
          await ctx.store.put('audiences', a.audience_id, { ...a, uploaded, matched });
          return {
            audience_id: a.audience_id,
            name: a.name,
            action: 'created' as const,
            status: 'active' as const,
            uploaded_count: uploaded,
            matched_count: matched,
            effective_match_rate: uploaded ? matched / uploaded : 0,
          };
        })),
      };
    },
  },
});
```

**Identifier rules:** each `add` entry is a single-identifier object (`{hashed_email}` OR `{hashed_phone}`, not both). Values are SHA-256 of lowercased, trimmed input. Salting/normalization is out-of-band between buyer and platform — document your expected input format.

**Platform types:** destinations span `['dsp', 'retail_media', 'social', 'audio', 'pmax']`. Each has its own `activation_key` shape — see `skills/build-signals-agent/SKILL.md` for activation patterns, which are shared across signals and audience sync.

