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
3. **Guard account identity.** Removed account-key fields (`operator_unit`, `currency`, `timezone` and `brand.countries` on any account reference) are refused by default. `accountIdentityDowngrade: 'reduce'` sends the older key and reports `account_identity_reduced`. The account registry (which needs `accountStorage` with `compareAndSet`) binds each reduced key to one buyer key, with unreduced keys claiming themselves (`claimReductions`, all-or-nothing per request), refuses collisions in either order, keeps sending the reduced key after the seller upgrades (`account_identity_migration_pending`) and forgets it on `clearReduction` (`src/lib/core/account-reduction.ts`, `buyer-account-registry.ts`).
4. **Validate** the converted request, and the response, against the negotiated release.
5. **Convert the response up** through each step's `adaptResponse`. Upward steps never remove fields.

Every change is a `debug_logs` drift entry with `fromVersion` / `toVersion`. Tasks the negotiated release does not define are refused with `ProtocolFeatureUnsupportedError` unless the seller lists them.

To add a version pair (e.g. 3.3 ↔ 3.2), ship the older bundle, create `version/<older>/` with adapters for renames and moves only, and register it in `version/index.ts`. Additions need no code: the projection removes and reports them.

On the server, `createAdcpServer` does the reverse. Handlers are written against the server's `adcpVersion`. When a buyer is served an older release, the request runs through each step's `upgradeRequest` adapters before the handler. The handler's response then runs through `downgradeResponse` adapters and the response-schema projection before it is validated against the served release (`downgradeResponse` / `upgradeRequest` in `src/lib/adapters/version/`, wired in the tool handler of `create-adcp-server.ts`). `get_adcp_capabilities` keeps its own projection. `get_task_status` results are converted by their `task_type`. Every conversion is reported to the `onVersionTranslation` callback.

Capability discovery can validate against the seller-served release echoed in `adcp_version`.

Established media-buy tools remain available for AdCP 3.0/3.1 sellers. Their compact-lifecycle projections and durable purchase continuations remain scoped to the negotiated AdCP 3 release. Creative-model v1/v2 projections under `src/lib/v2/projection/` are independent of AdCP protocol majors.

### Primary media facts narrow legacy format choices

When a seller offers several legacy references for an image, hosted video or hosted
audio creative, projection can use the one primary asset's positive, finite width,
height or duration to select a reference. Explicit creative `format_parameters`
remain authoritative; media facts do not fill partially specified parameters.
Multiple assets of the same media type remain ambiguous. A single legacy reference
keeps its existing seller-scaling behavior.

Reference and catalog constraints take precedence. Seller option `params` fill
missing reference facts, including one fixed size in `sizes` or an exact duration.
The selected wire reference is unchanged. Duration comparison remains exact.

## Bundled artifacts

```text
schemas/cache/
├── 3.2.7/       # primary SDK pin
├── 3.1.29/      # maintained stable release
├── 3.0.25/      # maintained stable release
└── latest/      # symlink to the primary pin
```

Run `npm run sync-schemas:all` to refresh the primary and maintained bundles. Run `npm run generate-types:all` to regenerate public types, then `npm run build:lib` to build and copy supported schemas into the package. `copy-schemas-to-dist.ts` excludes retired AdCP 2 caches even when present locally. `check-publish-protocol-artifacts.mjs` checks the published schema inventory and rejects retired type exports.

The v16 primary pin is AdCP 3.2.7, including its signed schema and compliance bundles. The patch refresh preserves the public request/response types and the existing pathways to AdCP 3.1 and 3.0.

Compliance pins select exact fixture bytes, unlike same-minor wire schema aliases. SDK 16.5.0 packages the 3.2.7 corpus; when upgrading from SDK 16.4.0, update explicit `--compliance-version 3.2.5` flags to `3.2.7`. A development pin of `3.2.6` must likewise advance. Retain the matching historical SDK if a run requires that older corpus. The maintained 3.1.29 and 3.0.25 corpora remain packaged.

Build tooling also understands exact AdCP 3.3.0 `beta.N` and `rc.N` pins. Such a build retains maintained AdCP 3.0, 3.1, and 3.2 GA aliases through 3.2.7 while advertising only the selected prerelease, without a moving beta/RC-family alias. This prepares the v17 integration; the stable v16 compatibility list continues to advertise only AdCP 3.2 and earlier.

Conformance validates current and unversioned response payloads without synthesizing task status. The existing status-optional compatibility shim applies only to explicitly declared AdCP 3.0 payloads, and never to status-free compact tools. Closed response schemas admit only the canonical version-envelope fields alongside their declared task fields; other root restrictions and nested-body constraints remain enforced.

## Future major-version support

Adding another protocol major requires an explicit support decision and a reviewed wire translation layer. Keep translation, request/response schemas, and tests tied to the selected release. Validate responses against the version actually negotiated, preserve unsupported-field errors, and never silently downgrade to an end-of-life protocol.

Removing a supported protocol version is an SDK breaking change. Use a major changeset and document the last SDK release that still supports it. Do not edit the package version manually.
