---
'@adcp/sdk': patch
---

Fix canonical format matching when a buyer's direct selector omits the product's `asset_source`, `buyer_asset_acceptance`, `composition_model`, `slots`, or `ssl_required`. These declarations remain on the product and do not need to be repeated to select it; omission does not supply defaults or assert contrary policy. Explicit conflicts still fail matching, and dimensions, duration, encoding limits, and unknown product constraints remain enforced.

This fixes the published AdCP 3.2.6 canonical_formats positive selector in storyboard validation and the shared canonical_format_satisfies fixture-discovery predicate. The same rule applies when legacy format IDs are projected for canonical matching. Seller rejection of a compatible selector remains a failure. Requests, product declarations, creative-manifest validation, and seed data are preserved.
