---
'@adcp/sdk': patch
---

Refresh the default AdCP 3.2.5 and maintained AdCP 3.1.29 compliance bundles with the corrected inline creative and provenance scenarios. Inline creative tests use the seller's advertised canonical or legacy representation, preserve product and publisher selector identities, and require a complete create, update, and readback path. Provenance scenarios seed schema-valid products and declared formats so their probes reach the intended provenance checks. The maintained bundle also includes corrected legacy request-signing vectors.

The previous exact compliance caches, 3.2.4 and 3.1.24, are replaced by 3.2.5 and 3.1.29. Runs using `--compliance-version` with either previous packaged patch must select its replacement patch. Supported historical wire and schema version aliases remain available.

The advertised `AdcpVersion` compatibility set adds 3.1.25 through 3.1.29 and 3.2.5. These wire and schema aliases select the packaged minor-version schemas; they do not add exact compliance caches for the intermediate patches.
