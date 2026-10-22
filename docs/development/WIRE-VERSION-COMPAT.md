# Wire version compatibility

The SDK supports AdCP 3. Its primary schema pin lives in `ADCP_VERSION`; maintained schema and compliance side bundles cover AdCP 3.0 and 3.1. AdCP 2.5 reached end of life on August 1, 2026, and its compatibility layer has been removed. See [migration guidance](../migration-drop-adcp-2.md).

## Discovery and negotiation

`SingleAgentClient.getCapabilities()` requires `get_adcp_capabilities` or the official A2A framework lifecycle that makes that discovery call routable. An agent that lacks discovery receives `VersionUnsupportedError` before a business tool is sent.

`parseCapabilitiesResponse()` derives major versions from `adcp.supported_versions`, falling back to `adcp.major_versions`. A capability response without either declaration defaults to AdCP 3, because discovery was introduced in AdCP 3. An explicit AdCP 2-only declaration is rejected by client discovery. A failed capability call on an agent advertising the tool can still produce conservative synthetic v3 evidence; it never selects AdCP 2 adapters.

SDK-hosted sellers must advertise only implemented AdCP 3 releases. Server startup rejects any AdCP 2 declaration, including `major_versions: [2, 3]`; external sellers advertising both majors remain callable through AdCP 3. See the [seller migration steps](../migration-drop-adcp-2.md).

`resolveAdcpVersion()` rejects configured AdCP 2 pins, and `resolveBundleKey()` prevents stale local AdCP 2 caches from re-enabling validation support. The protocol dispatch and task executor also reject explicit v2 dispatch requests.

## AdCP 3 compatibility

The public API uses the primary pin. `src/lib/adapters/version/` holds version-specific request adaptation for maintained AdCP 3 releases. Seller capability evidence and release negotiation determine the effective target. Response validation uses the selected AdCP 3 release; capability discovery can validate against the seller-served release echoed in `adcp_version`.

Established media-buy tools remain available for AdCP 3.0/3.1 sellers. Their compact-lifecycle projections and durable purchase continuations remain scoped to the negotiated AdCP 3 release. Creative-model v1/v2 projections under `src/lib/v2/projection/` are independent of AdCP protocol majors.

An explicitly repinned candidate checkout can build against `3.3.0-beta.N` or `3.3.0-rc.N`. Version synchronization retains maintained AdCP 3.0/3.1 releases and AdCP 3.2.1 through 3.2.5, then advertises only the exact preview pin and its release-precision wire alias (for example, `3.3.0-beta.0` and `3.3-beta.0`). It does not advertise moving `3.3-beta`/`3.3-rc` aliases or AdCP 3.3 GA. The SDK's default pin remains AdCP 3.2.5.

Canonical schema routes determine `MediaBuyTask` and the task used for each action. The `update_media_buy` compatibility facade retains canonical control, refinement, and creative mutations, including existing field mappings maintained by the mutation decomposer. A separately routed action such as issue reporting cannot use that facade. `STRUCTURED_ONLY_MEDIA_BUY_ACTIONS` lists structured actions with update-field bindings; canonical routing retains separately routed actions in the wider `MediaBuyActionId` vocabulary.

Generic change-right assessment retains its accepted-term preconditions. Issue-reporting capability checks and lifecycle processing belong to the seller implementation.

## Bundled artifacts

```text
schemas/cache/
├── 3.2.5/       # primary SDK pin
├── 3.1.29/      # maintained stable release
├── 3.0.25/      # maintained stable release
└── latest/      # symlink to the primary pin
```

Run `npm run sync-schemas:all` to refresh the primary and maintained bundles. Run `npm run generate-types:all` to regenerate public types, then `npm run build:lib` to build and copy supported schemas into the package. `copy-schemas-to-dist.ts` excludes retired AdCP 2 caches even when present locally. `check-publish-protocol-artifacts.mjs` checks the published schema inventory and rejects retired type exports.

## Future major-version support

Adding another protocol major requires an explicit support decision and a reviewed wire translation layer. Keep translation, request/response schemas, and tests tied to the selected release. Validate responses against the version actually negotiated, preserve unsupported-field errors, and never silently downgrade to an end-of-life protocol.

Removing a supported protocol version is an SDK breaking change. Use a major changeset and document the last SDK release that still supports it. Do not edit the package version manually.
