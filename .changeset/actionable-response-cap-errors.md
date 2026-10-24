---
'@adcp/sdk': patch
---

Make response-size errors name `transport.maxResponseBytes` and explain how to raise it on the client or call for large legitimate reads. Keep the existing 4 MiB default and document a 64 MiB configuration for catalog, signal, media-buy, and delivery readers.
