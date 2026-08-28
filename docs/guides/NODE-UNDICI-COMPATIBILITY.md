# Node and Undici compatibility

`@adcp/sdk` intentionally depends on `undici@^6.28.0` while its Node engine is
`^20.19.0 || >=22.12.0`. Undici 6 supports that complete engine range and is
the stock, fully supported runtime configuration. Node 20.19 and Node 22.12 are
the first releases on their respective lines to enable `require(esm)` by
default, which the SDK's CommonJS server entry needs through its required A2A
dependency. Node 21 and Node 22.0–22.11 are therefore outside the engine range.
CI installs the packed SDK on both boundary releases with exactly Undici
6.28.0, rather than only testing whichever newer 6.x release the package
manager selects.

Undici 7 itself requires Node 20.18.1 or newer. Because the SDK requires Node
20.19.0 on the Node 20 line for both ESM and CommonJS consumers, a consumer
override to `undici@>=7.29.0 <8` is supported on a best-effort compatibility
basis: CI uses a real packed-package consumer override and runs the
network-sensitive SDK suites on Node 20.19.0. It covers pin-and-bind SSRF
fetches, redirects, aborts, response body limits, webhook delivery, and
MCP/OAuth discovery. This does not extend the SDK's Node engine floor or change
the declared `^6.28.0` dependency.

Do not force Undici 7 below 7.29.0. The reviewed security floors are 6.28.0 and
7.29.0. `npm run check:runtime-compat` prevents the package's Node engine floor,
selected Undici major, and reviewed security floor from drifting into an
incompatible combination.

The release runtime is also tested on Node 24 with the stock Undici 6 range.
When the release runtime or Node engine promise changes, update both boundary
lanes in the CI matrix, this document, and the executable runtime policy in the
same change.
