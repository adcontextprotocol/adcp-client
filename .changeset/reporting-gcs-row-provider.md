---
'@adcp/sdk': minor
---

Add `createGcsReportingRowObjectProviderV1({ storage, clients })` to `@adcp/sdk/reporting/gcs`: a Google Cloud Storage provider for object-kind reporting row bindings. Bindings use `location: { bucket }` and select an injected official `Storage` client by `credentialRef` from a closed map. Writes are create-only single-request uploads (`ifGenerationMatch: 0`, declared MD5, no `Content-Encoding`); the recorded native version is the generation, which pins every read and delete. Reads stream with a hard byte cap and support ranges without transcoding. The probe requires uniform bucket-level access and enforced public access prevention, allows versioning, soft delete and retention, and refuses lifecycle `Delete` rules that can match live objects under the binding prefix. Provider errors surface only as stable `ReportingRowStoreError` codes.
