---
"@adcp/client": minor
---

Add creative library protocol support. `list_creatives` now available in both media-buy and creative domains for agents that host creative libraries. `build_creative` gains library retrieval mode via `creative_id`, `library_id`, and `macro_values` fields. New `CreativeVariable` type for DCO variable definitions. `CreativeFilters` extended with `format_ids`, `format_types`, `has_variables`, `has_served`, and `concept_ids`. `has_creative_library`, `supports_generation`, and `supports_transformation` capability flags added. `CreativeAgentClient` gains `listCreatives()` method.
