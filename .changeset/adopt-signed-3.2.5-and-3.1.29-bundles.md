---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.2.5 primary and 3.1.29 maintained protocol bundles, replacing the previously packaged 3.2.4 and 3.1.24 caches.

`ADCP_VERSION` moves to 3.2.5 and the maintained 3.1 line moves to 3.1.29. Historical wire and schema aliases are preserved: 3.2.3, 3.2.4 and 3.1.24 all remain accepted on the wire. The intermediate 3.1.25–3.1.28 GA releases are newly advertised as accepted — they were not in the compatible list before — because the maintained line now enumerates through 3.1.29. The reporting interop Python artifact pins are untouched; that record describes the protocol an independently verified Python wheel was validated against and is not this SDK's pin.

3.1.29 corrects the request-signing vectors that 3.1.28 shipped with padded standard Base64 `Signature` tokens. The maintained 3.1 profile requires unpadded Base64URL, so an explicitly pinned 3.1 verifier correctly rejected them. The SDK parser is unchanged and was not relaxed: `positive/002` now verifies and `negative/018` reaches its expected `components_unexpected` step under both omitted and explicit 3.1.29 pins.

**Breaking for the compliance cache only.** The previous exact compliance caches are no longer packaged. If you pass `--compliance-version 3.1.24` / `3.2.4` (or the equivalent `complianceDir`), repin to `3.1.29` / `3.2.5`. The compliance cache requires an exact version — there is no minor alias, so a removed version now errors and the error lists the versions your install actually packages.

**Schema bundles are unaffected and behave differently.** They are minor-keyed, so `adcpVersion: '3.1.24'` continues to resolve through the `3.1` bundle without error — it now returns 3.1.29 content, which includes the new `core/macro-bearing-url.json`. That is the long-standing newest-patch-wins behaviour, not a change here, but it does mean the two mechanisms differ: the cache fails loudly on a removed exact version while the schema path silently moves forward. If you depend on 3.1.24 schema bytes specifically, vendor your own copy rather than relying on the version string.

Shipped as a `patch` on the 15.9.x maintenance line deliberately: the published API surface is unchanged and this is a protocol-bundle refresh, so maintenance consumers get it without a manual bump. The compliance-cache repin above is the one action required.
