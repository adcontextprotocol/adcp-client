---
'@adcp/sdk': patch
---

fix(schemas): make schemas with non-empty arrays portable in adopter declaration emit

Emitting declarations for a schema that contains a non-empty array, such as `export const X = SyncCreativesResponseStrictSchema` or `SyncCreativesItemSchema.shape.account`, failed with TS2883 ("cannot be named without a reference to 'NonemptyArraySchema'") for ESM consumers. The generated schema declaration names `NonemptyArraySchema` through the CommonJS declaration, while ESM consumers saw a separate copy. The ESM declaration for `validation/nonempty-array` is now a re-export of the CommonJS one, so both module formats share one `NonemptyArraySchema`. It is also exported as a type from `@adcp/sdk/schemas` and `@adcp/sdk/schemas/browser`. Runtime JavaScript is unchanged. Fixes #3638.
