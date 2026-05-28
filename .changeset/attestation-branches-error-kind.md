---
"@adcp/sdk": patch
---

Preserve generated branch fields for schemas that express mutual exclusion with `not.anyOf`, including upstream traffic attestation payload and digest fields plus stricter geo proximity and catchment union types. Require structured controller error metadata before downgrading non-finite JCS digest failures to not_applicable, and allow `TestControllerError` to carry controller `context`/`ext` metadata.
