---
'@adcp/sdk': minor
---

Update the SDK schema pin and generated surfaces to AdCP 3.1.0-beta.5.

The 3.1 beta write-side media-buy helpers now emit `format_option_refs` /
`format_option_id` instead of the removed `capability_ids` path, while keeping
the old capability-named helper exports as beta.3 compatibility aliases.
`packageRefsForCapabilities()` is now documented as beta.3-only and emits a
one-time warning because beta.5 sellers reject `capability_ids` on
`PackageRequest`.

`PROPOSAL_NOT_FOUND` recovery is aligned to beta5 as `correctable`, and the
projection diagnostic detail name follows the beta5 `format_option_id` field
instead of the beta.3 `capability_id` name. Regenerated types, Zod schemas,
docs, schema caches, conformance arbitraries, retry policy, and compliance
controller support are aligned with the beta5 protocol bundle.
