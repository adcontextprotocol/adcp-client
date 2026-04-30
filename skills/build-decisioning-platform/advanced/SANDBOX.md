# Sandbox routing

When a buyer sends `account: { id: '...', sandbox: true }`, route the call to your platform's test/staging environment instead of production. The buyer wants to validate against your real surface without touching prod.

```ts
accounts: {
  resolve: async (ref) => {
    if (ref?.sandbox === true) {
      return { id: ref.id, operator: 'mypub-sandbox', metadata: { env: 'staging' } };
    }
    return { id: ref?.id ?? 'pub_main', operator: 'mypub', metadata: { env: 'production' } };
  },
  ...
}

createMediaBuy: async (req, ctx) => {
  const target = ctx.account.metadata.env === 'staging' ? this.gamSandbox : this.gam;
  return await target.createOrder(req);
}
```

There is no separate "dry-run" mode — sandbox subsumes "validate against real platform without writing to production." Tool-specific `dry_run` flags on `sync_catalogs` / `sync_creatives` are wire fields you receive and honor; they are NOT a framework-level mode.

See `REFERENCE.md` for the full sandbox section.
