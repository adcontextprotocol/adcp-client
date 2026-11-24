---
'@adcp/sdk': patch
---

The schema loader now reads and parses each schema document once per bundle, instead of once per reader. The first validation against a release read the whole bundle up to five times: the compile-outcome cache's content digest, core registration, the canonical validators, and each schema-ref validator (`getSchemaValidatorByRef`, which `sync_accounts` and proposal checks call). `getToolSchemaDocument` also parsed the bundle's `index.json` on every call.

Every reader of a bundle now shares one parsed copy of each document, whichever version string selected the bundle. The copies live as long as the bundle's loader state, so `_resetValidationLoader()` and re-entering a changed external root read the files again. The compile-outcome digest hashes the same read the compile uses, so a recorded outcome matches the documents that compiled. Building the validators for four releases in one process takes about 3.0 CPU-s instead of 4.1, with no more retained memory.

The shared documents are deep-frozen, so one caller can't change what another reads. `getToolSchemaDocument`, `getToolInputSchema` and `getToolResponseSchema` now return the same frozen document on each call, as `getSchemaDocumentByRef` already did; copy the schema before modifying it.
