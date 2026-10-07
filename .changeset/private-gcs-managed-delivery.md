---
'@adcp/sdk': minor
---

Add an optional GCS managed reporting delivery adapter with durable per-schema namespace identity, deterministic uploads and actual provider readback verification. Add destination-bound private resource and canonical-document readers that reauthorize every read and bypass private caches.

The canonical-reference error-code union gains `access_denied`, `invalid_options` and `aborted`; adopters using exhaustive switches should handle these private-transport failures.

The new managed adapter reports host contract failures through `HOST_CALLBACK_FAILED`. Use the exported `isReportingGcsFenceError` guard across mixed CJS/ESM imports.
