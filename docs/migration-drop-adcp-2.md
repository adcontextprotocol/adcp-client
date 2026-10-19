# Removing AdCP 2 compatibility

AdCP 2.5 reached end of life on August 1, 2026. The SDK now supports AdCP 3 agents only. This is an SDK major release change. Integrations that still require AdCP 2 can pin the last supporting beta, `npm install @adcp/sdk@16.0.0-beta.8`, or stay on the stable SDK 15 line (`npm install @adcp/sdk@15.9.6`) while upgrading their agents.

Upgrade agents to AdCP 3 before upgrading the SDK. An agent must expose `get_adcp_capabilities`. Its `adcp.supported_versions` determines its supported majors; `adcp.major_versions` is the legacy fallback. Omitting both fields no longer selects AdCP 2.

Agents that declare only AdCP 2 and agents missing capability discovery fail with `VersionUnsupportedError` (`code: 'VERSION_UNSUPPORTED'`) before a business tool is dispatched. AdCP 2 constructor pins fail with `ConfigurationError`, even if an old schema cache remains on disk.

The release removes:

- `allowV2`, `ADCP_ALLOW_V2`, and the CLI `--allow-v2` flag.
- `SingleAgentClient.isSyntheticV2()` and the v2 `buildSyntheticCapabilities()` helper.
- The `2` argument to `SingleAgentClient.supportsVersion()` and `AgentClient.supportsVersion()`; the maintained query is `supportsVersion(3)`.
- The `@adcp/sdk/types/v2-5` export and AdCP 2 schema bundles.
- Outbound AdCP 2 adapters: `adaptGetProductsRequestForV2`, `adaptPricingOptionForV2`, `adaptProductPricingForV2`, `adaptSyncCreativesRequestForV2`, `adaptPackageRequestForV2`, `adaptCreateMediaBuyRequestForV2`, and `adaptUpdateMediaBuyRequestForV2`.
- AdCP 2 creative/format/preview detectors: `usesV2CreativeIds`, `usesV2Dimensions`, and `usesV2RenderFields`, plus their v2-only structural types (`PackageRequestV2`, `PackageResponseV2`, `PackageAdapterContext`, `FormatV2`, and `PreviewRenderV2`).
- The `sync-schemas:v2.5` and `generate-types:v2.5` scripts.

Submit canonical AdCP 3 `creative_assignments`, format `renders`, and preview `render_id` / `role` fields. The maintained read helpers (`getCreativeIds`, `getCreativeAssignments`, `getFormatRenders`, `getPrimaryRender`, `getFormatDimensions`, `getRenderId`, `getRenderRole`, and preview URL/HTML accessors) still inspect valid AdCP 3 data. Their normalizers preserve that data; they no longer promote `creative_ids`, top-level format dimensions, or `output_id` into AdCP 3 fields.

Seller applications using `createAdcpServer` or `createAdcpServerFromPlatform` must remove AdCP 2 from `capabilities.major_versions` and `capabilities.supported_versions`. Startup rejects a declaration such as `[2, 3]` because this SDK no longer implements the advertised AdCP 2 surface. A buyer can still call an external agent that genuinely implements both majors: when its discovery includes AdCP 3, the SDK negotiates AdCP 3.

AdCP 3.0 and 3.1 compatibility remains available. Creative-model v2 projections and MCP v2 transport names refer to separate version schemes and remain supported.

See the protocol's [v2 sunset policy](https://github.com/adcontextprotocol/adcp/issues/2220) and [FAQ](https://github.com/adcontextprotocol/adcp/blob/main/docs/faq.mdx).
