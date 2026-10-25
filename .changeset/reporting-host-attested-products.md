---
'@adcp/sdk': minor
---

Allow reporting source offerings to declare `applicability: { productIds: [], products: { kind: 'host_attested' }, constituentKinds }` for products created per brief or buy. Trusted host coverage resolution remains responsible for per-product eligibility and account authorization; constituent kinds and product bindings remain enforced. Existing `applicability.productIds` declarations retain their validation, required array type, and capability hashes. Buyer declarations cannot supply applicability fields, and an adapter's executor cannot broaden a declared product allowlist.
