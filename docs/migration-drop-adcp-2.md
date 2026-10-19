# Removing AdCP 2 compatibility

AdCP 2.5 reached end of life on August 1, 2026. The SDK now supports AdCP 3 agents only. This is an SDK major release change; older SDK releases remain available for integrations that still require AdCP 2.

Upgrade agents to AdCP 3 before upgrading the SDK. An agent must expose `get_adcp_capabilities`. Its `adcp.supported_versions` determines its supported majors; `adcp.major_versions` is the legacy fallback. Omitting both fields no longer selects AdCP 2.

Agents that declare only AdCP 2 and agents missing capability discovery fail with `VersionUnsupportedError` (`code: 'VERSION_UNSUPPORTED'`) before a business tool is dispatched. AdCP 2 constructor pins fail with `ConfigurationError`, even if an old schema cache remains on disk.

The release removes:

- `allowV2`, `ADCP_ALLOW_V2`, and the CLI `--allow-v2` flag.
- `SingleAgentClient.isSyntheticV2()` and the v2 `buildSyntheticCapabilities()` helper.
- The `@adcp/sdk/types/v2-5` export and AdCP 2 schema bundles.
- AdCP 2 request adapters and creative/format/preview conversion helpers.
- The `sync-schemas:v2.5` and `generate-types:v2.5` scripts.

AdCP 3.0 and 3.1 compatibility remains available. Creative-model v2 projections and MCP v2 transport names refer to separate version schemes and remain supported.

See the protocol's [v2 sunset policy](https://github.com/adcontextprotocol/adcp/issues/2220) and [FAQ](https://github.com/adcontextprotocol/adcp/blob/main/docs/faq.mdx).
