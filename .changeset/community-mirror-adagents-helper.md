---
'@adcp/sdk': minor
---

Add typed registry helpers for community mirror adagents catalogs. `buildCommunityMirrorAdagents()` and `RegistryClient.createCommunityMirrorAdagents()` emit catalog-only descriptors with `authorized_agents: []`, while `CreateAdagentsRequest` now exposes typed `formats`, `placements`, and `placement_tags` shapes for local adopter code.
