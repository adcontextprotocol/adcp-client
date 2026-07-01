---
'@adcp/sdk': minor
---

Allow registry saveProperty/saveProperties writes to include full property identity facts: property_type, identifiers, and tags.

The registry CLI `save-property` positional now accepts optional payload JSON instead of the old `[agent-url]` authorization positional. That old argument had already stopped producing authorization after the registry began forcing community writes to `authorized_agents: []`, so scripts that still pass an agent URL now fail fast with exit code 2 instead of silently writing a stripped authorization claim.
