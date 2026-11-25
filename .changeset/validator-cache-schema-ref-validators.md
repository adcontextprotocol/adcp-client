---
'@adcp/sdk': patch
---

With `ADCP_VALIDATOR_CACHE_DIR` set, the validator cache now also keeps the schema-ref validators of the shared schema-ref registry (`getSchemaValidatorByRef`, which `sync_accounts`, account identity projection, notification and proposal checks call). A later process loads them without building the registry, which registers about 1,100 documents of the release, and without an Ajv compile. A hit still runs the registry's document scan, so a release whose documents share an `$id` with different content throws as before. Validators with custom keywords, the delivery-envelope projection and documents outside the runtime tree keep their own Ajv and are not cached.

The canonical and schema-ref caches no longer store or load the functions Ajv compiles beside a validator while it resolves references. Those compiles matter only through diagnostic origins, which these registries don't record, so each validator loads fewer entries. Validation results and errors are the same with the cache off, cold and warm.
