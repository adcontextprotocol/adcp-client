---
'@adcp/sdk': patch
---

Fix canonical-format storyboard grading so a selector that omits a product constraint other than fixed size or duration inherits it instead of being graded under-specified (#3470). The AdCP product-satisfaction rule requires a selector to declare only a product's fixed `width`, `height`, `duration_ms_exact` or `duration_ms_range`. Under the normative "narrows" definition, an omitted parameter inherits the declared value and adds no constraint of its own.

Since #3454 graded every selector route independently, the published `media_buy_seller/canonical_formats/create_media_buy_with_equivalent_direct_legacy_emission` positive (AdCP 3.2.7 and current) failed for every seller. Its direct route omits `max_file_size_kb` and `image_formats`. That step and the three stateful negatives after it now grade normally. Fixed dimensions and duration stay mandatory. Any parameter a selector states must still be contained, so a conflicting `max_file_size_kb`, `image_formats` or `video_codecs` still fails. This replaces the five-field omission allowlist from #3414. The fixture-discovery predicate uses the same rule.
