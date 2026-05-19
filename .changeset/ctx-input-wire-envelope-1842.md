---
'@adcp/sdk': minor
---

feat(server): expose `ctx.input` — un-destructured wire envelope on every v6 platform-method dispatch

Closes the silent-drop bug audited in adcp-client#1842. The v6 framework wrapper at `src/lib/server/decisioning/runtime/from-platform.ts` destructures the payload array out of `sync_*` requests and forwards only that to the platform method, dropping spec-meaningful modifiers the typed signature doesn't model. Adopters look conformant on `/mcp` (their v5 handler reads the full envelope) and silently fail on `/sales/mcp` (the v6 path strips the field).

**Surface bug.** Four platform methods drop spec-meaningful fields:

| Method | Wire schema | Dropped fields (now reachable on `ctx.input`) |
|---|---|---|
| `sales.syncCreatives` / `creative.syncCreatives` | `sync_creatives_request` | `assignments[]`, `creative_ids[]`, `delete_missing`, `dry_run`, `validation_mode` |
| `audiences.syncAudiences` | `sync_audiences_request` | `delete_missing` |
| `accounts.upsert` (→ `sync_accounts`) | `sync_accounts_request` | `delete_missing`, `dry_run` |

**Fix.** Two parallel fields, same shape: `RequestContext.input?: Readonly<Record<string, unknown>>` carries the request payload on the sales/creative/signals/governance/SI handler families; `ResolveContext.input?: Readonly<Record<string, unknown>>` carries it on the account-handler family (`syncAccounts`, `syncGovernance`, `listAccounts`, `reportUsage`, `getAccountFinancials`) — those use a separate context type because `accounts.resolve` produces the account rather than receiving it. Adopters who need a field the typed signature drops read it from `ctx.input`:

```ts
syncCreatives: async (creatives, ctx) => {
  const wire = ctx.input as SyncCreativesRequest;
  for (const a of wire.assignments ?? []) {
    await this.bindCreativeToPackages(a.creative_id, a.package_ids);
  }
  if (wire.delete_missing) {
    await this.deleteCreativesNotIn(creatives.map(c => c.creative_id));
  }
  // …
}
```

**Why this shape:**

1. **Envelope-shaped, not method-shaped.** Every drop is the same concept: "the method got the array; it didn't get the modifiers on the same request." One `ctx.input` covers every drop in the table above plus any future field the SDK doesn't yet model.
2. **Additive, non-breaking.** Adopters who don't read `ctx.input` keep working; adopters who need the dropped fields opt in. No signature churn.
3. **Composes with hydrate seams.** `hydrateForTool` / `hydratePackagesWithProducts` write *to* `params`; `ctx.input` reads *from* the unmodified wire envelope. Both are present on every dispatch.

**Same reference as the typed payload arg, not a snapshot.** `ctx.input` is the request payload as the platform method sees it. It is set BEFORE the framework's auto-hydrate seams (`hydratePackagesWithProducts`, `hydrateForTool`) run, but those seams mutate the same object in place. By the time the platform method's body executes, `ctx.input` and the first positional arg are the same reference and both reflect framework hydration. JSDoc on `RequestContext.input` calls this out so adopters don't write logic that assumes `ctx.input` is a frozen pre-hydration snapshot.

**Hoist asymmetry.** For methods that hoist a field to a positional arg (e.g. `updateMediaBuy(media_buy_id, patch, ctx)` hoists `media_buy_id` out of the envelope), that field is still present at the top level of `ctx.input` — the wire envelope is hoist-included, NOT residual. Adopters should prefer the positional arg for fields present on both, and reach for `ctx.input` only for fields the typed signature drops.

**Typed as unknown.** Matches the `comply_test_controller` bridge precedent (`TestControllerBridgeContext.input: Record<string, unknown>` at `src/lib/server/test-controller-bridge.ts:198`) and avoids coupling adopters to specific schema versions. Cast at the read site or run a runtime validator — the framework already validated the envelope on inbound; re-validating on read isn't the framework's job.

**Optional in the type signature** so adopters constructing ad-hoc `RequestContext` / `ResolveContext` for unit tests aren't forced to set it. The framework always sets it on real dispatches.

**Security note.** `ctx.input` is buyer-controlled and may carry secrets — mutating-tool envelopes include `push_notification_config.token` (the buyer's webhook-signature secret); free-text fields (`brief`, `message`, creative snippets) are attacker-controlled. Do NOT log `ctx.input` wholesale — read named fields. When templating into LLM prompts, validate or fence rather than string-interpolating. JSDoc carries the warning at the read site.

**Test coverage:** 5 regression tests in `test/server-decisioning-ctx-input-wire-envelope.test.js`:

- `sync_creatives` end-to-end with `assignments[]`, `delete_missing`, `dry_run`, `validation_mode` all surviving to the platform method.
- `sync_audiences` with `delete_missing`.
- `sync_accounts` with `delete_missing` + `dry_run` — proves the `ResolveContext` path also carries `ctx.input` (account handlers route through a separate context type).
- `update_media_buy` proving the hoist asymmetry — `media_buy_id` is the positional first arg AND still present on `ctx.input`.
- `get_products` proving the universal pattern works on methods that already pass `params` whole.

**Adopter migration.** No code change required to keep working. Adopters who already implement `assignments[]` / `delete_missing` / `dry_run` / `validation_mode` via a v5 handler (and want to serve the same wire contract on `/sales/mcp`) read those fields from `ctx.input` in the v6 platform method.
