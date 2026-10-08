---
'@adcp/sdk': minor
---

Add the `@adcp/sdk/reporting/s3` subpath with `createS3ReportingRowObjectProviderV1({ client, clients })`, an Amazon S3 (and S3-compatible) provider for object-kind reporting row bindings, backed by the new optional peer `@aws-sdk/client-s3`. Bindings use `location: { bucket, region? }`; endpoint, credentials and region come only from host-injected clients selected by `credentialRef`. Writes are `PutObject` with `If-None-Match: *` (412 adopts the existing version, 409 is retried once); the native version is the `VersionId` on versioned buckets, else the quoted ETag, and pins every read (`VersionId` / `If-Match`, ranged, byte-capped) and delete. The probe checks the bucket, region, public policy status and lifecycle expiration, and empirically proves that the store enforces create-only writes before a binding is used.
