---
'@adcp/sdk': patch
---

Refresh the registry OpenAPI snapshot and generated types for the published compliance coverage fields:

- `coverage_incomplete` on the agent compliance summary and on compliance runs. It is true when any track had a coverage-gap skip, and it is reported beside `status`, not folded into it.
- `track_details[].skipped_by_reason`, which counts a track's skipped steps by skip reason.
- `not_applicable_universal_bundle_ids`, listing universal bundles that are partial only because the agent advertises no tools for a surface it does not declare.

All the new fields are optional.
