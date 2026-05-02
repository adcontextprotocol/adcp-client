---
"@adcp/sdk": patch
---

fix(codegen): dedupe inline-enum exports with byte-identical literal sets to a single canonical export, with `@deprecated` aliases for the parent-prefixed variants. Keeps adopters from having to know which parent's copy to import when the spec emits the same enum under multiple object schemas (e.g. `GetBrandIdentityRequest_FieldsValues` ≡ `GetBrandIdentitySuccess_AvailableFieldsValues`). Aliases re-export the canonical's array reference so identity holds; a new test asserts no two distinct array references share a literal set. Closes #941.
