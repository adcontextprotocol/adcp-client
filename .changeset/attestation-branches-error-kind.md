---
"@adcp/sdk": patch
---

Preserve generated branch fields for schemas that express mutual exclusion with `not.anyOf`, including upstream traffic attestation payload and digest fields, and require structured controller error metadata before downgrading non-finite JCS digest failures to not_applicable.
