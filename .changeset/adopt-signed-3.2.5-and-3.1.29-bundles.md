---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.2.5 primary and 3.1.29 maintained protocol bundles, replacing the previously packaged 3.2.4 and 3.1.24 caches.

`ADCP_VERSION` moves to 3.2.5 and the maintained 3.1 line moves to 3.1.29. Historical wire and schema aliases are unchanged — 3.2.3, 3.2.4, 3.1.24 and the intermediate 3.1.25–3.1.28 releases all remain accepted on the wire, and the reporting interop Python artifact pins are untouched.

3.1.29 corrects the request-signing vectors that 3.1.28 shipped with padded standard Base64 `Signature` tokens. The maintained 3.1 profile requires unpadded Base64URL, so an explicitly pinned 3.1 verifier correctly rejected them. The SDK parser is unchanged and was not relaxed: `positive/002` now verifies and `negative/018` reaches its expected `components_unexpected` step under both omitted and explicit 3.1.29 pins.

**Breaking for explicit pins:** the previous exact compliance caches are no longer packaged. If you pass `--compliance-version 3.1.24` or `--compliance-version 3.2.4` (or the equivalent `complianceDir`), repin to `3.1.29` or `3.2.5`. There is no minor-version alias — exact versions are required, and a removed exact version now errors rather than silently resolving to different bytes.
