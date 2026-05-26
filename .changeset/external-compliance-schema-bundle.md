---
'@adcp/sdk': patch
---

fix: let external compliance dirs provide their matching schema bundle

When `--compliance-dir` points at another SDK package or checkout, the storyboard runner now registers the sibling schema bundle before constructing the test client. This allows a beta runner that ships only the 3.1 cache to execute a supplied 3.0 compliance bundle without failing the `adcpVersion` schema-bundle preflight.
