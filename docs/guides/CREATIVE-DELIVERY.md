# Creative Delivery Helpers

Buyer integrations should treat creative-library sync and inline media-buy
creatives as different workflows.

Use `supportsSyncCreatives(caps)` to decide whether the seller advertises a
reusable creative library:

```ts
import { inlineCreativesForPackages, supportsSyncCreatives } from '@adcp/sdk';

const caps = await agent.getCapabilities();

if (supportsSyncCreatives(caps)) {
  await agent.syncCreatives({
    account,
    idempotency_key: crypto.randomUUID(),
    creatives,
    assignments,
  });
} else if (caps.features.inlineCreativeManagement) {
  const packagesWithRefs = packages.map((pkg, index) => ({
    ...pkg,
    context: { ...pkg.context, buyer_ref: pkg.context?.buyer_ref ?? `pkg_${index}` },
  }));

  await agent.createMediaBuy({
    account,
    idempotency_key: crypto.randomUUID(),
    packages: inlineCreativesForPackages(packagesWithRefs, creatives, { assignments }),
  });
} else {
  throw new Error('Seller supports neither creative library sync nor inline creative uploads.');
}
```

`supportsSyncCreatives(caps)` keys off `creative.has_creative_library`. It does
not infer support from tool-list presence or from
`media_buy.features.inline_creative_management`.
Only use `inlineCreativesForPackages()` as the fallback when
`caps.features.inlineCreativeManagement` is true. When supplying assignments
for create payloads, make sure each package has a stable key such as
`context.buyer_ref`, or pass a custom `packageId` resolver.

For post-create replacement, build the same package-scoped patch and preflight
it against the current buy before dispatching:

```ts
import { inlineCreativesForPackages, preflightUpdateMediaBuy } from '@adcp/sdk';

const patch = {
  media_buy_id: currentBuy.media_buy_id,
  idempotency_key: crypto.randomUUID(),
  packages: inlineCreativesForPackages([{ package_id: 'pkg_1' }], creatives, {
    assignments: [{ creative_id: 'cre_1', package_id: 'pkg_1', weight: 100 }],
  }),
};

const preflight = preflightUpdateMediaBuy(currentBuy, patch);
if (!preflight.ok) {
  throw new Error(`Creative replacement unavailable: ${preflight.denials[0].reason}`);
}

await agent.updateMediaBuy(patch);
```

Each mutating leg needs its own `idempotency_key`. Do not reuse a
`sync_creatives` key for the fallback `create_media_buy` or `update_media_buy`
request.
