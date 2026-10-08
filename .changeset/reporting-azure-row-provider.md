---
'@adcp/sdk': minor
---

Add the `@adcp/sdk/reporting/azure` subpath with `createAzureBlobReportingRowObjectProviderV1({ client, clients })`, an Azure Blob Storage provider for object-kind reporting row bindings, backed by the new optional peer `@azure/storage-blob`. Bindings use `location: { account, container }`; host-injected `BlobServiceClient`s are selected by `credentialRef` and must belong to the bound account. Writes are block-blob uploads with `If-None-Match: *` (409 `BlobAlreadyExists` / 412 adopt the existing blob); the native version is the `versionId` when versioning is enabled, else the quoted ETag, and reads (ranged, byte-capped) and deletes pin it and require the response to echo it. The probe refuses missing, inaccessible or anonymously readable containers and empirically proves create-only writes.
