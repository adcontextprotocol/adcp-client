---
'@adcp/sdk': minor
---

feat(wire-version): release-precision pin support + wire validator + namespace

Three follow-ups surfaced during the expert review of #1807. Each is
small and additive; bundled here because they share the wire-version
helper surface.

**1. `resolveBundleKey` accepts release-precision pins** (e.g.
`'3.1-beta'`, `'3.1-beta.0'`). AdCP 3.1's `supported_versions`
capability field advertises versions in release-precision shape
(`["3.1-beta"]`), and a buyer reading that off the wire should be able
to construct a client pinned to it. Before this change,
`new AdcpClient({ adcpVersion: '3.1-beta' })` threw a
`ConfigurationError`. The fix extends the regex to accept
`MAJOR.MINOR-PRE` and updates `resolveSchemaRoot` to fuzzy-resolve
those keys to the highest cached prerelease directory whose own
release-precision form matches (so `'3.1-beta'` finds
`schemas/cache/3.1.0-beta.0/`, `'3.1-beta.0'` matches it exactly).

**2. `validateAdcpVersionWire(value)` — public wire-shape assertion.**
When you're constructing a request envelope by hand (storyboard
fixtures, conformance harnesses, custom transports) and want a clear
error rather than a downstream AJV pattern-mismatch from the seller.
The error message names `toReleasePrecisionWire` so the developer
knows which helper to call. Also wired as a defensive postcondition
in `buildVersionEnvelope` — should never throw in well-formed SDK
code, but if a future refactor breaks the normalization the assertion
fires with a helpful message.

**3. `wireVersion` namespace.** Groups the three helpers
(`isSupported`, `normalize`, `validate`) under a single barrel
export. As more wire-version helpers land they go here without
churning the top-level barrel. Top-level exports
(`bundleSupportsAdcpVersionField`, `toReleasePrecisionWire`,
`validateAdcpVersionWire`) are kept for back-compat — not deprecated,
just no longer the recommended entry point.

```ts
// New preferred API:
import { wireVersion } from '@adcp/sdk';
const bundle = wireVersion.isSupported('3.1') ? '3.1' : '3.0';
const wire = wireVersion.normalize('3.1.0-beta.0'); // '3.1-beta.0'
wireVersion.validate(wire); // throws on non-spec shape, error names normalize()

// Still works:
import { bundleSupportsAdcpVersionField } from '@adcp/sdk';
```
