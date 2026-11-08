---
'@adcp/sdk': minor
---

Legacy format projection now says when it guessed a seller id's meaning, lets a caller turn the guessing off, and no longer lets a guess contradict a seller's own `format_options[]` (#3634).

`projectV1ProductToV2`, `toAdditiveCanonicalProduct` and the other v1 → v2 helpers read a legacy id under any agent URL by the AAO naming conventions, so a seller's own `display_300x250` came back as `image` even when the seller sells it as a third-party tag. Sellers whose legacy ids look like `display_WxH` or `video_WxH` were reported as contradicting themselves by consumers that compared that projection with the seller's declared options.

- **Marked guesses.** A route for an option guessed from the id's name (an AAO id alias or registry id glob at an agent URL other than the AAO reference creative agent) carries `inferred_from_id: true`. The routes are JSON-safe, so the marker persists. Declarations and default results are otherwise unchanged.
- **Opt-out.** `V1ToV2ProjectionOptions.authoritativeOnly: true` resolves refs only from catalog snapshots, exact AAO catalog entries and `legacyFormatConverter`. A ref only a guess could resolve gets a `FORMAT_PROJECTION_FAILED` diagnostic instead of a declaration. `isAaoAgentUrl` is exported from `@adcp/sdk/v2/projection`.
- **Fix.** When a seller dual-emits `format_ids[]` and `format_options[]`, a guess from an id's name no longer vetoes the index pairing of that id with the seller's own option. Only the AAO's own mapping of an id at the AAO reference creative agent can; `legacyFormatConverter` is not consulted for this check. A `display_tag` option paired with a seller's `display_300x250` id now gets its route instead of a `LEGACY_FORMAT_ID_DROPPED_UNMAPPED` diagnostic.
