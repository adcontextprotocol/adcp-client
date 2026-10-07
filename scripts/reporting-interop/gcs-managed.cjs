'use strict';
// Installed candidate only; controlled pinned reporting facts, real PostgreSQL and GCS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
let stage = 'initialization';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [inputFile, packageRoot, output] = process.argv.slice(2);

async function main() {
  assert.equal(process.argv.length, 5);
  assert.equal(fs.statSync(inputFile).mode & 0o777, 0o600);
  const config = JSON.parse(fs.readFileSync(inputFile));
  const req = createRequire(path.resolve(packageRoot, 'package.json'));
  const installed = fs.realpathSync(path.join(packageRoot, 'node_modules/@adcp/sdk'));
  assert.ok(fs.realpathSync(req.resolve('@adcp/sdk')).startsWith(installed + path.sep));
  const api = { ledger: req('@adcp/sdk/reporting/ledger'), jcs: req(path.join(installed, 'dist/lib/utils/jcs.js')) };
  const gcs = req('@adcp/sdk/reporting/gcs');
  const reporting = req('@adcp/sdk');
  const { Storage } = req('@google-cloud/storage');
  const { Pool } = req('pg');
  const storage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
  const root = new Pool({ connectionString: config.database_url });
  assert.match(config.schema, /^adcp_gcs_managed_[a-f0-9]+$/);
  const checks = [];
  try {
    for (const { mode, zeroRows } of [
      { mode: 'managed', zeroRows: false },
      { mode: 'billing', zeroRows: false },
      { mode: 'managed', zeroRows: true },
      { mode: 'billing', zeroRows: true },
    ]) {
      const label = mode + (zeroRows ? '_empty' : '');
      const schema = config.schema + '_' + label;
      await root.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString: config.database_url, options: `-c search_path="${schema}"` });
      const destination = path.join(path.dirname(output), config.schema + '-' + label + '-destination');
      fs.mkdirSync(destination, { recursive: true });
      process.env.REPORTING_INTEROP_DESTINATION = destination;
      try {
        stage = mode + ':fixture';
        let observedInput, factoryOptions;
        const fixture = await require('./managed-seller.cjs').createFixture(api, pool, {
          mode,
          zeroRows,
          gcs: {
            observeFactory: options => {
              factoryOptions = options;
            },
            observeDelivery: input => {
              observedInput = input;
            },
            api: gcs,
            storage,
            bucket: config.bucket,
            namespace: config.namespace,
            contractPrefix: `${config.namespace}/contracts/${label}/`,
          },
        });
        stage = mode + ':controller';
        await fixture.controller(
          `reliable_reporting_${mode === 'billing' ? 'reconciled_billing' : 'managed_delivery'}_probe`,
          'prepare'
        );
        stage = mode + ':callback';
        const brokenHost = await gcs.createGcsReportingManagedDeliveryAdapterV1({
          ...factoryOptions,
          resolveExpectedPeriod: async () => {
            throw new Error('SECRET_SENTINEL');
          },
        });
        await assert.rejects(brokenHost.deliver(observedInput, { signal: new AbortController().signal }), {
          code: 'HOST_CALLBACK_FAILED',
        });
        const malformedExpected = await gcs.createGcsReportingManagedDeliveryAdapterV1({
          ...factoryOptions,
          resolveExpectedPeriod: async () => null,
        });
        await assert.rejects(malformedExpected.deliver(observedInput, { signal: new AbortController().signal }), {
          code: 'HOST_CALLBACK_FAILED',
        });
        const malformedHost = await gcs.createGcsReportingManagedDeliveryAdapterV1({
          ...factoryOptions,
          resolveContractReader: async () => null,
        });
        await assert.rejects(malformedHost.deliver(observedInput, { signal: new AbortController().signal }), {
          code: 'HOST_CALLBACK_FAILED',
        });
        checks.push(`${label}:host_callback_failures_fail_closed`);
        stage = mode + ':duplicate';
        const duplicate = await Promise.all([
          fixture.adapter.deliver(observedInput, { signal: new AbortController().signal }),
          fixture.adapter.deliver(observedInput, { signal: new AbortController().signal }),
        ]);
        assert.equal(duplicate[0].resource.native_version_ref, duplicate[1].resource.native_version_ref);
        assert.equal(duplicate[0].resource.manifest_sha256, duplicate[1].resource.manifest_sha256);
        checks.push(`${label}:concurrent_exact_delivery_replay_after_discarded_response`);
        stage = mode + ':status';
        const status = await fixture.status();
        const context = {
          obligation: status.periods[0],
          revision: status.revisions[0],
          materialization: status.materializations[0],
          expected: fixture.savedExpected,
        };
        const materialization = context.materialization;
        assert.equal(materialization.verification.verification_path, 'producer');
        const resource = materialization.resource;
        const bytes = await fixture.runtime.readResource({
          account_id: context.obligation.account_id,
          resource_ref: resource.resource_ref,
        });
        assert.equal(sha(bytes), resource.manifest_sha256);
        checks.push(`${label}:managed_worker_available_actual_provider_manifest`);
        const scope = {
          account_id: context.obligation.account_id,
          destination_ref: materialization.destination_ref,
          generation: 1,
          principal_id: 'independent-reader',
        };
        await assert.rejects(
          fixture.adapter.revoke({ authorization: scope }, { signal: new AbortController().signal }),
          { code: 'NOT_REVOKED' }
        );
        for (const changed of [
          { resource_ref: 'outside' },
          { location: resource.location.replace(config.bucket, 'outside-bucket') },
          { manifest_sha256: '0'.repeat(64) },
          { native_version_ref: 'invalid-generation' },
        ]) {
          await assert.rejects(
            fixture.adapter.read(
              {
                binding: observedInput.binding,
                materialization,
                resource: { ...resource, ...changed },
                maxBytes: 65536,
              },
              { signal: new AbortController().signal }
            ),
            { code: 'INVALID_INPUT' }
          );
        }
        checks.push(`${label}:forged_descriptors_and_open_cleanup_refused`);
        const provider = await fixture.managed.getAuthorizedObjectWriteBinding(scope);
        const prefix = `adcp-reporting/${provider.namespace_key}/${api.ledger.reportingObjectWriteScopeKey(scope)}/`;
        let reads = 0;
        const authorize = async request =>
          request.scope.principal_id === 'independent-reader' &&
          request.scope.account_id === scope.account_id &&
          request.scope.destination_ref === scope.destination_ref &&
          request.scope.generation === 1 &&
          request.bucket === config.bucket &&
          request.objectPrefix === prefix &&
          (await fixture.managed.isAuthorizationCurrent(request.scope));
        const options = {
          scope,
          bucket: config.bucket,
          objectPrefix: prefix,
          authorize,
          getStorage: async () => {
            reads++;
            return storage;
          },
        };
        const reader = gcs.createGcsReportingResourceReaderV1(options);
        const resolver = gcs.createGcsReportingReferenceResolverV1({
          ...options,
          authorize: async request =>
            request.objectPrefix === `${config.namespace}/contracts/${label}/` &&
            (await authorize({ ...request, objectPrefix: prefix })),
          objectPrefix: `${config.namespace}/contracts/${label}/`,
        });
        const inspector = reporting.createReportingManifestInspector({
          reader,
          referenceResolver: resolver,
          referenceAllowedOrigins: ['https://storage.googleapis.com'],
        });
        stage = mode + ':inspection';
        const observation = await inspector(context);
        assert.equal(observation.rowCount, zeroRows ? 0 : 2);
        assert.deepEqual(observation.controlTotals, context.revision.control_totals);
        if (mode === 'billing')
          assert.equal(observation.canonicalContentDigest.value, context.revision.canonical_content_digest.value);
        checks.push(`${label}:first_class_private_contract_inspection`);
        stage = mode + ':receipt';
        const receipt = req('@adcp/sdk/reporting/consumer').buildReportingReceipt(
          context,
          observation,
          'gcs-buyer-receipt-' + mode,
          new Date().toISOString()
        );
        assert.equal(receipt.status, 'accepted');
        if (mode === 'billing') {
          const response = await fixture.runtime.syncReportingReceipts(
            {
              account: { account_id: scope.account_id },
              receipts: [receipt],
              idempotency_key: 'gcs-buyer-receipt-batch-0001',
            },
            { account: { account_id: scope.account_id }, consumer_id: 'https://buyer.example.test/adcp' }
          );
          assert.equal(response.results[0].result, 'recorded');
        }
        checks.push(`${label}:receipt_built_from_actual_provider_bytes`);
        stage = mode + ':isolation';
        const count = reads;
        const wrong = gcs.createGcsReportingReferenceResolverV1({
          ...options,
          scope: { ...scope, principal_id: 'other-principal' },
          objectPrefix: `${config.namespace}/contracts/${label}/`,
        });
        assert.equal(
          (
            await wrong.resolve({
              uri: context.revision.schema_uri,
              digest: 'sha256:' + context.revision.schema_sha256,
            })
          ).error.code,
          'access_denied'
        );
        assert.equal(reads, count);
        const outside = await resolver.resolve({
          uri: context.revision.schema_uri.replace('/contracts/', '/outside/'),
          digest: 'sha256:' + context.revision.schema_sha256,
        });
        assert.equal(outside.ok, false);
        assert.equal(reads, count);
        checks.push(`${label}:principal_and_prefix_denied_before_provider_io`);
        stage = mode + ':corruption';
        const rowsUri = new URL('0', resource.location);
        const objectName = rowsUri.pathname.slice(('/' + config.bucket + '/').length);
        const [originalRows] = await storage.bucket(config.bucket).file(objectName).download();
        const corruptRows = originalRows.length ? Buffer.from(originalRows) : Buffer.from('x');
        corruptRows[0] ^= 1;
        await storage.bucket(config.bucket).file(objectName).save(corruptRows, { resumable: false });
        await assert.rejects(inspector(context), {
          code: zeroRows ? 'OBJECT_SIZE_MISMATCH' : 'OBJECT_DIGEST_MISMATCH',
        });
        checks.push(`${label}:actual_provider_corruption_rejected`);
        await fixture.controller(
          `reliable_reporting_${mode === 'billing' ? 'reconciled_billing' : 'managed_delivery'}_probe`,
          'revoke_access'
        );
        stage = mode + ':revocation';
        const denied = await resolver.resolve({
          uri: context.revision.schema_uri,
          digest: 'sha256:' + context.revision.schema_sha256,
        });
        assert.equal(denied.error.code, 'access_denied');
        await assert.rejects(reader.read({ role: 'manifest', location: resource.location, maxBytes: 65536, context }), {
          code: 'REVOKED',
        });
        await assert.rejects(
          storage
            .bucket(config.bucket)
            .file(new URL(resource.location).pathname.slice(('/' + config.bucket + '/').length), {
              generation: resource.native_version_ref,
            })
            .getMetadata(),
          { code: 404 }
        );
        checks.push(`${label}:revoked_warm_contract_and_native_manifest_denied`);
      } finally {
        await pool.end();
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    }
  } finally {
    await root.end();
  }
  return { status: 'passed', node: process.version, checks };
}
main()
  .then(result => fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n'))
  .catch(error => {
    const code = typeof error.code === 'string' && /^[A-Z_0-9]{1,80}$/.test(error.code) ? error.code : undefined;
    process.stderr.write(
      JSON.stringify({
        status: 'failed',
        stage,
        worker: (() => {
          try {
            return JSON.parse(error.message).worker;
          } catch {
            return undefined;
          }
        })(),
        scalar_actual: typeof error.actual === 'number' ? error.actual : undefined,
        local_frame: error.stack
          ?.split('\n')
          .find(line => line.includes('/scripts/reporting-interop/'))
          ?.replace(/.*\/scripts\/reporting-interop\//, '')
          .replace(/\).*/, ''),
        error_type: error.name,
        code,
        assertion: typeof error.operator === 'string' ? error.operator : undefined,
      }) + '\n'
    );
    process.exitCode = 1;
  });
