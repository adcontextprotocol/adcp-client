---
'@adcp/sdk': minor
---

Bump the bundled AdCP schema pin to `3.1.0-rc.10`, refresh generated types, schemas, docs, and registry metadata, and include the rc10 release in the SDK version-compatibility list.

Adds codegen and runtime projection handling for rc10's postal-area migration: platform capabilities can declare either country-keyed postal system arrays or deprecated legacy booleans, and the framework emits both forms during the deprecation window. Also keeps `schemas:ensure` from leaving `schemas/cache/latest` pointed at a legacy support cache after backfilling missing local caches.
