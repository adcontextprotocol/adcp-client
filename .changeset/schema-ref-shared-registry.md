---
'@adcp/sdk': patch
---

Schema-ref validators (`getSchemaValidatorByRef`, which `sync_accounts`, account identity projection, notification and proposal checks call) now share one Ajv registry per schema bundle and option set. Before, each ref built its own Ajv and registered and meta-validated every document of the bundle (about 1,100) again, so a server that validated a few refs against four releases registered the bundle dozens of times. Each validator is still its own function, so calling one never changes another's `errors`, and each validator gives the same verdicts and errors as before. Refs with custom keywords, the delivery-envelope projection and documents outside the bundle's runtime tree (`bundled/`, `mcp/`) keep their own Ajv, as before.

Core, canonical and schema-ref registration also meta-validate each shared schema document once per process instead of once per registry. A document that fails meta-validation still fails wherever it is added.

Building the validators for four releases (three tools, six schema refs) in one process registers 16,409 documents instead of 30,014 and meta-validates 3,302 instead of 29,826.
