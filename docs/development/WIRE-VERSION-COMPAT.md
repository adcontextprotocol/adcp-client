# Wire version compatibility

The SDK supports AdCP 3. Its primary schema pin lives in `ADCP_VERSION`; maintained schema and compliance side bundles cover AdCP 3.0 and 3.1. AdCP 2.5 reached end of life on August 1, 2026, and its compatibility layer has been removed. See [migration guidance](../migration-drop-adcp-2.md).

## Discovery and negotiation

`SingleAgentClient.getCapabilities()` requires `get_adcp_capabilities` or the official A2A framework lifecycle that makes that discovery call routable. An agent that lacks discovery receives `VersionUnsupportedError` before a business tool is sent.

`parseCapabilitiesResponse()` derives major versions from `adcp.supported_versions`, falling back to `adcp.major_versions`. A capability response without either declaration defaults to AdCP 3, because discovery was introduced in AdCP 3. An explicit AdCP 2-only declaration is rejected by client discovery. A failed capability call on an agent advertising the tool can still produce conservative synthetic v3 evidence; it never selects AdCP 2 adapters.

SDK-hosted sellers must advertise only implemented AdCP 3 releases. Server startup rejects any AdCP 2 declaration, including `major_versions: [2, 3]`; external sellers advertising both majors remain callable through AdCP 3. See the [seller migration steps](../migration-drop-adcp-2.md).

`resolveAdcpVersion()` rejects configured AdCP 2 pins, and `resolveBundleKey()` prevents stale local AdCP 2 caches from re-enabling validation support. The protocol dispatch and task executor also reject explicit v2 dispatch requests.

## AdCP 3 compatibility

The public API uses the primary pin. Application code builds requests and reads responses in that release's shape, and the client translates for older sellers (adcp-client#3370):

1. **Negotiate.** `negotiateAdcpRelease()` (`src/lib/adapters/version/negotiate.ts`) picks the highest release on or below the client's line from the seller's `supported_versions`. It falls back to the served `adcp_version`. A same-line match keeps the client's exact pin. Sellers with no release metadata (AdCP 3.1 does not require `supported_versions`), synthetic capabilities, an explicit `wireAdcpVersion`, governed payloads and the identity 3.3 experiment skip negotiation; the first two keep the 3.0 request adapters via `resolveAdapterKey`.
2. **Convert the request down** one minor at a time (`translate.ts`). Each step runs the hand-written `adaptRequest` adapters registered under the older release's key (`version/3.1/` for 3.2 → 3.1, `version/3.0/` for 3.1 → 3.0), then `projectToolPayload()` (`schema-projection.ts`). The projection diffs the two releases' tool schemas and removes properties, enum values and union variants only the newer one defines. Fields neither release declares, and free-form maps, are left alone.
3. **Guard account identity.** Removed account-key fields (`operator_unit`, `currency`, `timezone` and `brand.countries` on any account reference) are refused by default. `accountIdentityDowngrade: 'reduce'` sends the older key and reports `account_identity_reduced`. The account registry binds each reduced key to one buyer key (`claimReduction`), refuses collisions, keeps sending the reduced key after the seller upgrades (`account_identity_migration_pending`) and forgets it on `clearReduction` (`src/lib/core/account-reduction.ts`, `buyer-account-registry.ts`).
4. **Validate** the converted request, and the response, against the negotiated release.
5. **Convert the response up** through each step's `adaptResponse`. Upward steps never remove fields.

Every change is a `debug_logs` drift entry with `fromVersion` / `toVersion`. Tasks the negotiated release does not define are refused with `ProtocolFeatureUnsupportedError` unless the seller lists them.

To add a version pair (e.g. 3.3 ↔ 3.2), ship the older bundle, create `version/<older>/` with adapters for renames and moves only, and register it in `version/index.ts`. Additions need no code: the projection removes and reports them.

Capability discovery can validate against the seller-served release echoed in `adcp_version`.

Established media-buy tools remain available for AdCP 3.0/3.1 sellers. Their compact-lifecycle projections and durable purchase continuations remain scoped to the negotiated AdCP 3 release. Creative-model v1/v2 projections under `src/lib/v2/projection/` are independent of AdCP protocol majors.

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
