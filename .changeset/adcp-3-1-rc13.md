---
'@adcp/sdk': minor
---

Bump the bundled AdCP schema pin to `3.1.0-rc.13`, refresh generated types, schemas, docs, and registry metadata, and include the rc13 release in the SDK version-compatibility list.

Also keep `npm run sync-schemas` on the full protocol-bundle path during release propagation windows by trying the GitHub dist tarball before falling back to schema-only sync when the canonical site has schemas but not the tarball yet.
