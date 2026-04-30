# Brand rights specialism

If you claim `brand-rights`, implement `BrandRightsPlatform`. Buyers call to discover brand identity, query rights, and acquire rights for creative production.

```ts
class MyPlatform implements DecisioningPlatform {
  capabilities = {
    specialisms: ['brand-rights'] as const,
    brand: { /* BrandCapabilities — see REFERENCE.md for shape */ },
    ...
  };

  brandRights: BrandRightsPlatform = {
    getBrandIdentity: async (req, ctx) => { ... },
    getRights: async (req, ctx) => { ... },
    acquireRights: async (req, ctx) => {
      // Returns one of three native arms — Acquired / PendingApproval / Rejected
    },
  };
}
```

Async delivery for the `PendingApproval` arm rides the buyer's `push_notification_config.url`. There's no polling tool for `acquire_rights` — webhook is the only delivery channel.

See `REFERENCE.md` for the full brand-rights section + the 3-arm wire shape.
