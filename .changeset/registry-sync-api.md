---
"@adcp/client": minor
---

Align registry sync types with live server: FeedResponse uses `cursor` (not `next_cursor`), AgentSearchResponse uses `results` (not `agents`). Add auth requirement to `searchAgents()`. Add `lookupPropertiesAll()` for auto-paginated bulk domain resolution.
