---
'@adcp/sdk': minor
---

**Beta-channel break for beta.4 pins:** this SDK advertises and negotiates only the AdCP `3.3-beta.5` preview and no longer packages or advertises `3.3-beta.4`. A buyer or seller still on beta.4 will not select the 3.3 preview with this release; the pair negotiates a shared stable release (3.2.8, 3.1.31 or 3.0.25) instead. Betas are not additive over each other, so the SDK keeps one 3.3 preview at a time. Upgrade both sides together to keep exercising 3.3 preview features. An explicit `adcpVersion: '3.3.0-beta.4'` (or `'3.3-beta.4'`) pin now fails with a configuration error.

Adopt the signed AdCP 3.3.0-beta.5 bundle (tag commit e096e60c, sha256 6c716e67..., cosign-verified), replacing 3.3.0-beta.4. Public types, Zod schemas, tool metadata and the packaged compliance corpus are regenerated from the beta.5 release.

- **Experimental match keys:** new `MatchKey` and `MatchKeyUse` types (`core/match-key.json`, `enums/match-key-use.json`), `get_adcp_capabilities` `media_buy.supported_match_keys`, `Product.identity.match_keys` and TMP provider-registration `match_keys`. Sellers using them list the `media_buy.match_keys` experimental feature. Served to an AdCP 3.2 buyer, `get_products` removes `Product.identity.match_keys` and reports the drift; `get_adcp_capabilities` passes `supported_match_keys` through, like other 3.3 capability additions, because the 3.2 capability schema is open.
- **`ProductIdentity`** is now a type alias rather than an interface, because the schema adds a conditional rule; `extends` and `implements` keep working.
- **`sales-fixed-rate`** is a stable specialism.
- **Compliance:** `deterministic_testing` and the product-seeding scenarios bind their product and pricing-option fixtures to the consuming sandbox account; the storyboard schema defines the offline legacy-format catalog the runner already supports.
- The canonical storyboard fixtures and reporting-subscription vectors are pinned to v3.3.0-beta.5; both are byte-identical to beta.4.
