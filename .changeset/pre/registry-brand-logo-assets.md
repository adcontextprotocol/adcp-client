---
'@adcp/sdk': patch
---

Refresh the registry OpenAPI snapshot and generated types for the published brand logo endpoints:

- `GET /assets/brands/{domain}/{logoId}.{ext}` (`getBrandLogoAsset`) downloads an AgenticAdvertising.org-hosted brand logo, with optional `format=png` and `w` rendition parameters.
- `GET /logos/brands/{domain}/{logoId}` (`getBrandLogoLegacy`) is the legacy extension-less form.
- Brand manifest and brand entry logos document their `background` field.

All changes are additive.
