---
'@adcp/sdk': patch
---

A `legacyFormatConverter` now outranks the SDK's guess about a seller's own legacy format id.

For a ref at an agent URL other than the AAO reference creative agent, the v1 → v2 projector consults `legacyFormatConverter` before it guesses the id's meaning from its name. Before, a registry id glob guess ran first, so a converter could not say that the seller's `display_300x250` is a third-party tag rather than an image. A converter that returns `undefined` still accepts the guess, which its route marks with `inferred_from_id: true`. A converter that throws or returns an invalid declaration still fails closed. Refs at the AAO agent are unchanged: the AAO's own mappings run first and the converter runs only after they fail.
