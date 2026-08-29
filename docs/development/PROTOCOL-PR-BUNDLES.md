# Generate from an unreleased protocol bundle

Use this workflow when an SDK change depends on schemas from an AdCP protocol
pull request that have not been published yet. The protocol repository builds a
complete bundle for every schema-changing PR and publishes it at a URL keyed by
the full protocol commit:

```text
https://adcontextprotocol.org/protocol/pr/<commit-sha>/latest.tgz
```

PR bundles are unsigned development artifacts. The SDK requires both the
expected commit and SHA-256, verifies the complete tarball before extraction,
and checks the same commit inside the bundle manifest. A mismatch never falls
back to the published protocol bundle.

## Generate a dependent SDK branch

Copy the protocol commit and bundle SHA-256 from the protocol PR workflow
summary, then run:

```sh
npm run sync-schemas -- \
  --bundle https://adcontextprotocol.org/protocol/pr/<commit-sha>/latest.tgz \
  --bundle-sha256 <64-character-sha256> \
  --protocol-commit <40-character-commit-sha>

npm run generate-types
npm run generate-wellknown-schemas
```

The sync writes `schemas/codegen-provenance.json`. Commit that file with the
generated output. It records the exact protocol commit, bundle digest,
published-version label, and immutable URL. `npm run sync-schemas:all` detects
the file automatically, so the normal generated-drift CI job consumes the same
bundle and reports its commit and digest in the workflow summary.

The equivalent environment variables are useful in scripts:

```sh
export ADCP_BUNDLE_URL=https://adcontextprotocol.org/protocol/pr/<commit-sha>/latest.tgz
export ADCP_BUNDLE_SHA256=<64-character-sha256>
export ADCP_PROTOCOL_COMMIT_SHA=<40-character-commit-sha>
npm run sync-schemas:all
```

The environment declaration applies to the primary `ADCP_VERSION`; maintained
side bundles in `sync-schemas:all` continue to use their published artifacts.
An explicit `--bundle` invocation rejects a positional side-bundle version
instead of silently ignoring the bundle.

All three inputs are required. Remote inputs must use the official HTTPS,
commit-addressed URL exactly; query strings, redirects to another hostname, and
moving URLs are rejected. For an unpublished local build, `--bundle` may be a
filesystem path, but its generated provenance has no reproducible `bundle_url`
and therefore cannot drive CI.

`ADCP_BUNDLE` is retained as a shorter alias for `ADCP_BUNDLE_URL`; do not set
both names to different values.

`ADCP_REQUIRE_SIGNATURE=1` deliberately rejects PR bundles because upstream
does not sign them. Published release bundles retain their existing Cosign
verification behavior.

## Refresh after an upstream rebase

Every protocol rebase or force-push produces a new commit and therefore a new
artifact tuple. Do not edit the provenance JSON by hand:

1. Wait for the protocol PR's bundle workflow to finish on the new head.
2. Copy the new commit, SHA-256, and commit-addressed URL.
3. Re-run the sync and generators with all three new values.
4. Confirm the old commit no longer appears in
   `schemas/codegen-provenance.json`, generated output, or the SDK PR body.
5. Commit the regenerated output and updated provenance together.

If the artifact has expired, rerun the protocol validation workflow for that
commit before refreshing the SDK branch.

## Return to a published bundle

Before merging an SDK change that no longer needs an unreleased protocol input,
delete `schemas/codegen-provenance.json`, run `npm run sync-schemas:all`, and
regenerate normally. With no provenance declaration present, schema sync keeps
its existing published-release and GitHub fallback behavior.
