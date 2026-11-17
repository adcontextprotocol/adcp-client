# SDK 17 beta adoption

SDK 17 beta adopts the published AdCP `3.3.0-rc.0` protocol bundle and publishes under `beta`. SDK 16 remains the stable AdCP 3.2 line on npm `latest`.

## Selected protocol bundle

- Release: [AdCP v3.3.0-rc.0](https://github.com/adcontextprotocol/adcp/releases/tag/v3.3.0-rc.0), published November 17, 2026. It replaces [v3.3.0-beta.6](https://github.com/adcontextprotocol/adcp/releases/tag/v3.3.0-beta.6) (commit `bf4aa6dbb3b1c5b64a24cd378f702b24dc1ec545`), which SDK 17 no longer packages or advertises.
- Protocol commit: `b5ac0e1bf7330e4dc55bd8dea513968b453babec` (tag `v3.3.0-rc.0`).
- Bundle SHA-256: `bdcacb0bb54821bfcad7e64a47cd6446609500a86ba99032f51de5ba638a2055`.
- Source: the versioned protocol release tarball, verified by SHA-256 and the AdCP release workflow's cosign certificate. No moving branch or PR snapshot is used.

## SDK changes

The primary pin is `3.3.0-rc.0`, with generated public types, runtime validators, tool metadata and documentation from that bundle. The package retains stable 3.2.8, 3.1.31 and 3.0.25 schemas and compliance corpora. Preview compatibility is exact: `3.3.0-rc.0` and `3.3-rc.0`, without a moving family alias. Moving from beta.6 to rc.0 is a beta-channel break: a beta.6 peer no longer negotiates the preview with this SDK and falls back to a shared stable release. Buyer negotiation requires an exact advertised preview and otherwise uses an available stable release. The SDK packages one 3.3 preview at a time because betas are not additive over each other.

The HTML-markup `display_tag` mapping from [#3361](https://github.com/adcontextprotocol/adcp-client/pull/3361) is included as a major changeset. `display_html` and `display_WxH_html` project to inline-markup `display_tag`; actual `html5` zip creatives no longer match HTML-markup-only products. Delivery retains seller format identity, filters by delivery type and emits markup through the legacy HTML asset contract. SDK 16 keeps its previous mapping. See the [16 → 17 migration guide](../migration-16-to-17.md).

The SDK exposes the new `list_collections`, `list_proposals`, `request_account`, `report_media_buy_issue` and `get_media_buy_issue` tools on typed clients, server handlers, schema maps and completion callbacks. Served 3.3 requests refuse unresolved account references before dispatch. Existing identity/Web Bot Auth preview APIs remain explicitly experimental.

## Release checks

Before publishing:

1. Preserve the SDK 16 maintenance line and verify npm `latest` still selects SDK 16.
2. Run typecheck, build, unit/protocol tests, packed-artifact checks, the required expert reviews and maintained reference-seller interoperability.
3. Use Changesets to generate `17.0.0-beta.0` and dependent workspace prereleases. Verify `npm run release -- --dry-run` selects `beta`.
4. Merge only after required checks pass, publish through trusted GitHub Actions, then verify the npm tarball's protocol pin and compatibility bundle inventory.

SDK 17 GA follows upstream AdCP 3.3 GA and SDK validation. The storage package retains its own experimental policy and version line.
