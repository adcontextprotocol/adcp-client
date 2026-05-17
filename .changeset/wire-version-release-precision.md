---
'@adcp/sdk': patch
---

fix(protocols): normalize `adcp_version` to release-precision on the wire

The `adcp_version` envelope field added in AdCP 3.1 (spec PR
adcontextprotocol/adcp#3493) is constrained to release-precision strings
by `core/version-envelope.json`'s pattern `^\d+\.\d+(-[a-zA-Z0-9.-]+)?$`.
Full-semver bundle keys (`'3.1.0-beta.0'`) are explicitly NOT valid wire
values per the envelope schema's own normalization rule:

> SDKs that read full-semver values from bundle metadata MUST normalize
> to release-precision before emitting on the wire — meta-field values
> are NOT valid wire values.

Before this fix, `buildVersionEnvelope` emitted the bundle key verbatim
for prerelease pins. A 3.1.0-beta-pinned client would send
`adcp_version: "3.1.0-beta.0"`, which sellers AJV-reject with a pattern
mismatch. The bug was latent: today's `COMPATIBLE_ADCP_VERSIONS` doesn't
include any 3.1.x release, so no public-pin path could hit it — but a
caller manually overriding `adcpVersion` past the compat gate (or the
SDK's eventual 3.1 enablement) would silently break.

This change introduces `toReleasePrecisionWire(bundleKeyOrVersion)`:

- Stable bundle keys (`'3.0'`, `'3.1'`) pass through unchanged.
- Prerelease semver collapses the PATCH segment, preserving the
  prerelease tag: `'3.1.0-beta.0'` → `'3.1-beta.0'`.
- Full stable semver collapses to minor: `'3.0.11'` → `'3.0'`.
- Legacy aliases (`'v3'`) pass through (they're gated out of the wire
  field by `bundleSupportsAdcpVersionField` anyway).

`buildVersionEnvelope` now applies the normalizer at the single emit
site. The function is also exported publicly so adopters that hand-roll
their own wire envelopes (storyboard fixtures, conformance harnesses)
get the same shape the SDK emits.

Added `test/lib/adcp-version-release-precision.test.js` covering the
seven shape cases plus a cross-check that every non-legacy output
matches the spec's wire pattern.
