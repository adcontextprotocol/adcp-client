# Optional live GCS evidence inspection

These controls exercise the installed SDKs' native HTTPS reporting readers and
manifest inspectors against actual private Cloud Storage objects. They supplement
the local PostgreSQL/MCP runtime gates in `run.mjs`. They do not provision cloud
resources, create credentials, mutate objects, or change IAM.

The [2026-10-06 record](../../docs/development/reporting-gcs-qualification.json)
lists operator-verified archive, fixture, and worker source hashes for twelve
successful controls. It uses the same unpublished TypeScript archive as the earlier
local gate and the published Python SDK `adcp==8.0.0` wheel. It is not qualification of the
published TypeScript `14.1.0` package.

## Prepared inputs

Use an explicitly selected private test bucket with uniform bucket-level access
and public access prevention. Give a separate keyless reader service account
conditional `roles/storage.objectViewer` access only to the `qualified/` object
prefix. The fixture owner retains write access. Mint an unexpired reader access
token with Google's official authentication client. Keep the token file private
and outside the repository; never pass the token in a command argument or log it.

An operator-owned input directory contains:

- `reader-token.json`, mode `0600`, with `token` and `expires_at` (an ISO timestamp
  with a timezone). Keep these exact bytes unchanged between phases. The workers
  output a SHA-256 of those private input bytes, never the token itself.
- `evidence/node20-context.json` and `evidence/node24-context.json`, containing
  `obligation`, `revision`, `materialization`, and `expected` copied from
  `test/fixtures/reporting-interop/evidence-v1.json`. Change only the resource
  location and the three contract URIs to the real GCS objects in the respective
  `qualified/node20/` and `qualified/node24/` namespaces. Set `manifest_sha256` to
  the hash of the SDK-canonicalized uploaded manifest bytes.
- `evidence/expected.json`, copied from the `expected` member of
  `test/fixtures/reporting-interop/resources/fixture.json`.

Upload `manifest.json`, `rows.jsonl`, `row-schema.json`, `report-definition.json`,
and `canonicalization.json` to each namespace, preserving the pinned fixture
bytes except for SDK canonical encoding of the manifest. Use each contract's
declared content type. Upload the pinned rows to `outside/rows.jsonl` as the
sibling-prefix denial control. Verify owner access to this object before testing
reader denial. Generation preconditions prevent accidental overwrites during
initial setup.

## Controls and sequencing

Run the TypeScript worker with each actual Node executable and an isolated
installed SDK package; run the Python worker with the isolated installed wheel
interpreter against each namespace:

```sh
node scripts/reporting-interop/gcs-inspect.cjs PRIVATE_INPUT_ROOT TS_INSTALL_ROOT node20 positive
python -I scripts/reporting-interop/gcs-inspect.py PRIVATE_INPUT_ROOT node20 positive
```

Repeat for `node24` using the Node 24 executable. The workers retain only
credential-free result flags and sanitized error codes. Positive controls cover
authenticated inspection, canonical digest and accepted receipt, byte bounds,
anonymous 403, sibling-prefix 403, and the SDK's origin controls. TypeScript
checks credential origin binding; Python refuses an untrusted origin with
`UNSAFE_RESOURCE`. The worker flags name those distinct controls.

TypeScript private contract reads use a supplied resolver over the SDK HTTPS
reader, with contract hashes checked by the worker. The default SDK canonical
reference resolver cannot attach reporting credentials and is not exercised.
Python uses its inspector's built-in contract checking. Both SDK inspectors
verify manifest, physical row, and canonical row digests. Local HTTP 403 errors
are `RESOURCE_READ_FAILED` in TypeScript and `RESOURCE_UNAVAILABLE` in Python;
Python reports `UNSAFE_RESOURCE` for its untrusted-origin control.

For `tampered`, use the owner's official Cloud Storage client to change a byte
in each uploaded `rows.jsonl` with a generation precondition, leaving the
manifest's declared SHA-256 unchanged. Both inspectors must reject the actual returned
bytes with `OBJECT_DIGEST_MISMATCH`. Restore the original rows before revocation.

For `revoked`, remove the conditional reader IAM binding. Wait for provider
propagation using the same unexpired token, then run both workers for each
namespace with the `revoked` phase. Each worker checks all five objects in its
namespace. Confirm the owner still reads the original objects with their original
hashes; deleting objects is not this revocation
control. Record observed latency without treating it as an SLA. Separately
confirm the read-only identity cannot upload an object (403). Finally delete the
owned test objects, bucket, temporary identity, and retained reader token.

These controls do not exercise seller transfer adapters, write-generation
fencing, shared-database recovery, or public webhook deployment. Cloud management
and latency measurements are operator-owned steps, not assertions fabricated by
the inspection workers. The record's `provenance` identifies operator-attested
management, artifact-binding, and sequencing fields separately from the parsed
worker results. Ordinary CI requires no GCS credentials or resources.
