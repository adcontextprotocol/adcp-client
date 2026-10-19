# SDK 17 beta preparation

SDK 16 GA is the stable AdCP 3.2 checkpoint. SDK 17 beta adopts the published AdCP 3.3 beta protocol bundle and publishes under `beta`, leaving `latest` on SDK 16.

This preparation is a draft until the protocol bundle is available. The checkout still pins AdCP 3.2.5; entering Changesets pre-mode reserves the next SDK major without claiming that AdCP 3.3 has been integrated. Do not merge this preparation or publish SDK 17 until the adoption work below is complete.

## Complete the protocol adoption

1. Verify that SDK 16.0.0 is published on `latest` and preserve its release commit on a stable maintenance branch.
2. Select the exact published AdCP 3.3 beta bundle. Record its version in `ADCP_VERSION`; for an immutable protocol PR bundle, follow [protocol PR bundle provenance](./PROTOCOL-PR-BUNDLES.md).
3. Extend `scripts/sync-version.ts` for the 3.3 prerelease compatibility policy. Preserve maintained AdCP 3.0, 3.1 and 3.2 stable versions, and advertise only the selected 3.3 prerelease and its release-precision alias. Superseded previews and a moving `3.3-beta` alias must not imply compatibility.
4. Retain the AdCP 3.2 schema and compliance side bundle in `sync-schemas:all`, `schemas-ensure.ts`, and the publish-artifact check when 3.3 becomes the primary pin. Update [wire compatibility](./WIRE-VERSION-COMPAT.md).
5. Sync signed bundles, regenerate public types, Zod schemas, tool metadata and documentation, and implement the required adapters and backwards-compatible request normalization. Replace the experimental 3.3 overlays where the official schema now defines those fields; document any remaining experimental surfaces.
6. Resolve upstream Web Bot Auth interoperability work and run the applicable protocol and security reviews for the actual identity changes. Run build, typecheck, unit/protocol tests, packed-artifact checks and reference-seller interoperability against maintained releases.
7. Rewrite the pending major changeset and migration notes to describe the completed integration, then run `npm run version` and verify it produces `17.0.0-beta.0`. Confirm `npm run release -- --dry-run` selects `beta` before merging the release PR.

## Channels and maintenance

- `latest`: SDK 16.x, AdCP 3.2, while SDK 17 is in beta.
- `beta`: SDK 17.0.0-beta.N, pinned to the selected AdCP 3.3 beta.
- SDK 16 fixes: a stable maintenance branch, published with `ADCP_NPM_TAG=latest` through the trusted release workflow.

SDK 17 GA follows upstream AdCP 3.3 GA and successful SDK validation. The storage package retains its own experimental policy and version line; an SDK major alone does not graduate storage APIs.
