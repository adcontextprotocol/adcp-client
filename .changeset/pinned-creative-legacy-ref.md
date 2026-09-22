---
'@adcp/sdk': patch
---

Match a creative pinned to a `format_option_ref` against the legacy ref its option was minted from, and use a single narrowed legacy candidate.

A pinned creative facing a legacy-only container (bare `format_ids`, no `format_options`) lost every candidate in `selectLegacyRef`, because candidates derived from `format_ids` carry no option ref to compare against; the fallthrough then discarded the single candidate left after narrowing and threw `did not provide one unambiguous legacy format reference`. The pin is now matched exactly by re-deriving the synthetic option id from each legacy ref (`migratedFormatOptionId`, exported from `v1-to-v2`), a single remaining candidate is returned for an unpinned creative, and a pin that names none of the product's legacy refs still fails closed with a reason that names the pin.
