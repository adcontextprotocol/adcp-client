---
'@adcp/sdk': patch
---

With `ADCP_VALIDATOR_CACHE_DIR` set, a release whose modular validators all come from the cache no longer registers its documents (about 1,100) in the modular Ajv. The loader selects the documents registration would add, in the same order and as the same objects, and serves cache hits from that selection. The first validator that is not a hit, or the first read of a hit's `schemaEnv`, registers exactly those objects. `getRegisteredSchemaIds` reports the same ids in the same order before and after registration. A selection that fails leaves registration to run as before, so the same error is thrown.
