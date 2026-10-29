---
'@adcp/sdk': patch
---

Validate `get_products` pricing currency filters against every returned media price and observable compulsory product-scoped signal charge, while permitting account-specific FX conversion and optional foreign-currency add-ons. Custom signal pricing whose incremental charge cannot be established is reported as unproven instead of being assumed incompatible. Fixture discovery also respects the negotiated canonical creative capability rather than forcing canonical wire mode on legacy-only AdCP 3.1 sellers.

Validate supplied standard and vendor required-metric filters against every returned product, respecting implicit metrics, documented derivations and numeric container subsumption. Vendor and metric pins must match the same declared vendor metric; absent filters impose no optional-feature requirement and valid empty matches remain allowed.
