---
'@adcp/sdk': patch
---

fix(registry): `RegistryClient.listBrands` sends the `house_domain` filter. Its options type has accepted `house_domain` since the registry types were refreshed, but the query builder sent only `search`, `limit`, `offset` and `source`, so the filter was dropped and the call listed the whole registry. The builder now sends every option it is given, so a filter the generated types gain is not dropped the same way.
