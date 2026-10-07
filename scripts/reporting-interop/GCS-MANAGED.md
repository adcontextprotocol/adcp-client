# Installed seller and published Python buyer on private GCS

The [retained qualification record](../../docs/development/reporting-gcs-interop-qualification.json) binds the candidate archive, installed SDKs, runtime lanes and final cleanup.

This optional qualification uses the actual managed runtime, PostgreSQL, Google's
Storage clients and the pinned official MCP wrapper. It runs both reporting modes
against an independently installed published `adcp==8.0.0` wheel. It is a controlled
fixture, not a deployable seller or destination-provisioning endpoint.

## Prepare the operator-owned fixture

Use a dedicated fresh bucket satisfying [the adapter policy](../../docs/guides/REPORTING-GCS-MANAGED.md),
a separate temporary keyless reader service account, owner ADC and a short-lived
reader token. This controlled fixture uses privileged owner ADC for producer writes; it does not prove least-privilege seller deployment. Bucket IAM changes occur only in the explicit operator hook; the
reader gets only conditional `roles/storage.objectViewer` on the exact report and
contract prefixes for each run. Keep all cloud credentials and input JSON mode
`0600` outside tracked files. Never grant a project-wide storage role or create a
service-account key for this gate.

A private input JSON contains `project_id`, `bucket`, `adc_path`,
`reader_token_path`, `typescript_archive_path`, `reader_principal` and a unique stable `namespace` for this
run. The token JSON contains `token` and `expires_at`. Use absolute paths. The
bucket, identity and credentials must already belong to this operator's isolated
qualification fixture. The runner does not create or delete them.

The operator supplies a trusted Python grant hook. It receives the saved
`gcs-grant.json` path as its only argument and must validate its bucket, principal,
account, destination and generation against the operator's fixture before granting
access. Grant only its exact trailing-slash `objectPrefix` and `contractPrefix`;
wait for the reader to access `row-schema.json` before returning JSON success.
The seller derives these prefixes from its authoritative destination binding,
not a returned resource URI. The hook's stdout is retained as evidence; never
print credentials. The hook is explicit operator code, not buyer-controlled code.

Install the candidate archive into an isolated npm directory with `pg` and the
chosen optional Google Storage peer. Do not update this directory during a run.
Install the wheel from `pins.json` into an isolated Python environment with
`psycopg[binary]` and `google-cloud-storage`. Check the wheel SHA before installing.
Check out the exact `python_harness_commit` from `pins.json` in a clean upstream
Python SDK checkout. The gate checks the pin, wheel hash, all installed SDK files against the pinned wheel, package-lock integrity and MCP readiness identity.

## Run each mode and Node lane

```sh
REPORTING_INTEROP_PG_URL='postgresql://fixture-admin@127.0.0.1:5432/postgres' \
  VENV/bin/python -I scripts/reporting-interop/gcs-managed.py \
  PINNED_PYTHON_CHECKOUT TS_INSTALL NODE_EXECUTABLE FRESH_OUTPUT managed \
  PRIVATE_GCS_INPUT PINNED_PYTHON_WHEEL TRUSTED_GRANT_HOOK
```

Repeat with `billing`, and with Node 20.19 plus Storage 7.22 and Node 24 plus
Storage 8.2. Each invocation creates and drops one randomly named database and
stops its owned seller process group even on failure. Use a fresh output directory
and namespace for each invocation. Refresh the reader token before starting a run. Keep input paths and the trusted grant hook unchanged during execution. The buyer bounds raw provider downloads with a range and checks the returned byte count. Its 30-second asynchronous wait cannot cancel an already-issued provider thread; native 15-second request limits and the runner's 180-second buyer subprocess timeout bound that work.
Cloud fixture cleanup remains the operator's responsibility on success or failure:
revoke temporary reader grants, delete the owned service account and token, then
delete the owned bucket and verify 404. Retain credential-free evidence only.

The buyer independently verifies exact revision JCS, manifest and object hashes,
private contract pins, row counts and the billing canonical digest. Real provider
controls require anonymous access, sibling-prefix reads and reader writes to return authorization errors (anonymous 401 or 403, authenticated controls 403). A tampered downloaded row must be rejected. Billing discards one committed
receipt response and reconnects using a new official client; PostgreSQL must retain
exactly one accepted receipt with the same ID. Both modes revoke the destination,
require provider 404 for both old manifest and row-object native generations and retain historical revision metadata.

This proves reconnect repair, not seller process crash recovery. The separate
[fence qualification](../../docs/development/reporting-gcs-fence-qualification.json)
covers delayed and resumable provider writes, revocation ordering and durable
cleanup restart. Host power loss, production webhook deployment and automatic
Python adjustment-facade integration remain separate qualification work.

Merge and publish the reviewed stack, then repeat against the exact published
archive before advertising production readiness. An unpublished archive stamped
`14.4.0` is a different artifact from the already published `14.4.0` release.

The operator, Python environment, transitive dependencies and upstream checkout
are trusted fixture inputs. The SDK file comparisons do not attest a hostile
host or arbitrary interpreter startup hooks. Logs are intentionally redacted,
including broad bearer patterns that can remove benign prose; use the parsed
credential-free result flags and source/artifact hashes as evidence.

The revocation probe checks the last-observed generation of each of the two
report objects. This fixture keeps those objects immutable before revocation;
it does not enumerate arbitrary historical generations. The manifest-pin guard
is specific to this fixture's current two-object layout.
