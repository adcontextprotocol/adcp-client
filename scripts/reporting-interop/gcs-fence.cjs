'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
const sha = body => createHash('sha256').update(body).digest('hex');
const [inputFile, packageRoot, fixtures, output, mode] = process.argv.slice(2);

async function main() {
  assert.ok(process.argv.length === 6 || process.argv.length === 7);
  assert.equal(require('node:fs').statSync(inputFile).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(inputFile));
  const req = createRequire(path.resolve(packageRoot, 'package.json'));
  const { Storage } = req('@google-cloud/storage');
  const { Pool } = req('pg');
  const sdk = req('@adcp/sdk/reporting/gcs');
  const ledger = req('@adcp/sdk/reporting/ledger');
  const storage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
  const schema = config.schema;
  assert.match(schema, /^adcp_gcs_fence_[a-f0-9]+$/);
  const bootstrap = new Pool({ connectionString: config.database_url });
  const pool = new Pool({ connectionString: config.database_url, options: `-c search_path="${schema}"` });
  const scope = id => ({ account_id: id, destination_ref: 'owned-gcs-destination', generation: 1 });
  const store = new ledger.PostgresReportingManagedDeliveryStore(pool);
  const namespace = config.namespace;
  const make = (client = storage, authority = store, deadline) =>
    sdk.createGcsReportingObjectFenceV1({
      storage: client,
      store: authority,
      bucket: config.bucket,
      namespace,
      operationDeadlineMilliseconds: deadline,
    });
  const signal = () => new AbortController().signal;
  const revoke = id => store.revokeDestination({ ...scope(id), revoked_at: new Date().toISOString() });
  const authorize = id => store.authorizeDestination({ ...scope(id), authorized_at: new Date().toISOString() });
  let created = false;
  try {
    if (mode === 'recover') {
      const result = await make().revoke(scope('crash'), { signal: signal() });
      assert.equal(result.complete, true);
      process.stdout.write(JSON.stringify({ fresh_process_recovered: true, fenced: result.fenced }));
      return;
    }
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    for (const migration of [
      ledger.REPORTING_LEDGER_MIGRATION,
      ledger.REPORTING_MANAGED_DELIVERY_MIGRATION,
      ledger.REPORTING_OBJECT_WRITE_MIGRATION,
    ])
      await pool.query(migration);
    const rows = readFileSync(path.join(fixtures, 'reporting-interop/resources/rows.jsonl'));
    const manifest = readFileSync(path.join(fixtures, 'reporting-interop/resources/manifest.json'));
    const bodies = [rows, manifest];
    const checks = [];
    const [policy] = await storage.bucket(config.bucket).getMetadata();
    const safePolicy = Object.fromEntries(
      [
        'versioning',
        'softDeletePolicy',
        'retentionPolicy',
        'defaultEventBasedHold',
        'objectRetention',
        'lifecycle',
        'iamConfiguration',
      ]
        .filter(key => policy[key] !== undefined)
        .map(key => [key, policy[key]])
    );
    const fence = make();
    await fence.probe();

    await authorize('before-write');
    const latePlan = await fence.register(scope('before-write'), 'late-session', bodies);
    // Timing instrumentation only: actual official client and real resumable session.
    const delayedStorage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
    const delayedBucket = delayedStorage.bucket(config.bucket);
    const originalFile = delayedBucket.file.bind(delayedBucket);
    delayedStorage.bucket = name => {
      assert.equal(name, config.bucket);
      return delayedBucket;
    };
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    let sessionReady;
    const ready = new Promise(resolve => {
      sessionReady = resolve;
    });
    let requestFinished;
    const finished = new Promise(resolve => {
      requestFinished = resolve;
    });
    delayedBucket.file = (name, options) => {
      const file = originalFile(name, options);
      if (name === latePlan.objects[0].object_name) {
        const save = file.save.bind(file);
        file.save = async bytes => {
          const [uri] = await file.createResumableUpload({ preconditionOpts: { ifGenerationMatch: 0 } });
          assert.equal(new URL(uri).origin, 'https://storage.googleapis.com');
          sessionReady();
          await gate;
          try {
            await save(bytes, { resumable: true, uri, preconditionOpts: { ifGenerationMatch: 0 } });
            requestFinished({ unexpected_write: true });
          } catch (error) {
            requestFinished({ provider_code: Number(error.code) });
            throw error;
          }
        };
      }
      return file;
    };
    // Handler attached immediately; no unhandled rejection if initialization is slow.
    const expired = make(delayedStorage, store, 5000)
      .write(latePlan, 0, rows, { signal: signal() })
      .then(
        () => ({ unexpected_success: true }),
        error => ({ code: error.code })
      );
    await ready;
    assert.equal((await expired).code, 'DEADLINE_EXCEEDED');
    await revoke('before-write');
    assert.equal((await fence.revoke(scope('before-write'), { signal: signal() })).complete, true);
    release();
    assert.equal((await finished).provider_code, 412);
    const [lateMetadata] = await storage.bucket(config.bucket).file(latePlan.objects[0].object_name).getMetadata();
    assert.equal(String(lateMetadata.size), '0');
    assert.ok(lateMetadata.metadata.adcp_reporting_tombstone);
    await assert.rejects(fence.register(scope('before-write'), 'after-revoke', bodies), e => e.code === 'REVOKED');
    checks.push({
      name: 'resumable_session_after_sdk_deadline_and_revocation',
      real_provider_code: 412,
      no_readable_rows_resurrected: true,
    });

    await authorize('write-first');
    const firstPlan = await fence.register(scope('write-first'), 'committed-first', bodies);
    await fence.write(firstPlan, 0, rows, { signal: signal() });
    await fence.write(firstPlan, 0, rows, { signal: signal() });
    const firstFile = storage.bucket(config.bucket).file(firstPlan.objects[0].object_name);
    const [before] = await firstFile.getMetadata();
    assert.equal(sha((await firstFile.download())[0]), sha(rows));
    await revoke('write-first');
    const partial = await fence.revoke(scope('write-first'), { signal: signal(), maxObjects: 1 });
    assert.equal(partial.complete, false);
    assert.equal((await make().revoke(scope('write-first'), { signal: signal(), maxObjects: 1 })).complete, true);
    await assert.rejects(
      storage
        .bucket(config.bucket)
        .file(firstPlan.objects[0].object_name, { generation: before.generation })
        .download(),
      e => Number(e.code) === 404
    );
    await assert.rejects(
      firstFile.save(rows, { resumable: false, preconditionOpts: { ifGenerationMatch: before.generation } }),
      e => Number(e.code) === 412
    );
    checks.push({
      name: 'committed_before_revocation',
      exact_retry_verified: true,
      old_generation_read_denied_404: true,
      stale_generation_write_denied_412: true,
      bounded_cleanup_progress_recovered: true,
    });

    await authorize('replay-race');
    const replayPlan = await fence.register(scope('replay-race'), 'replay-read-after-revocation', bodies);
    await fence.write(replayPlan, 0, rows, { signal: signal() });
    const replayStorage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
    const replayBucket = replayStorage.bucket(config.bucket);
    replayStorage.bucket = name => {
      assert.equal(name, config.bucket);
      return replayBucket;
    };
    const replayFile = replayBucket.file.bind(replayBucket);
    let raced = false;
    replayBucket.file = (name, options) => {
      const file = replayFile(name, options);
      if (name === replayPlan.objects[0].object_name && !options?.generation) {
        const getMetadata = file.getMetadata.bind(file);
        file.getMetadata = async () => {
          const result = await getMetadata();
          if (!raced) {
            raced = true;
            await revoke('replay-race');
            assert.equal((await fence.revoke(scope('replay-race'), { signal: signal() })).complete, true);
          }
          return result;
        };
      }
      return file;
    };
    await assert.rejects(
      make(replayStorage).write(replayPlan, 0, rows, { signal: signal() }),
      error => error.code === 'REVOKED'
    );
    assert.equal(raced, true);
    checks.push({ name: 'revocation_during_exact_replay_read', old_generation_read_fails_and_returns_revoked: true });

    for (const variant of ['different', 'oversized']) {
      await authorize('conflict-' + variant);
      const conflictPlan = await fence.register(scope('conflict-' + variant), 'conflicting-object', bodies);
      const conflicting = Buffer.from(rows);
      conflicting[0] = conflicting[0] === 32 ? 33 : 32;
      // Deliberate provider corruption is a negative control, not an SDK fallback.
      await storage
        .bucket(config.bucket)
        .file(conflictPlan.objects[0].object_name)
        .save(variant === 'oversized' ? Buffer.concat([conflicting, Buffer.from('extra')]) : conflicting, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      await assert.rejects(
        fence.write(conflictPlan, 0, rows, { signal: signal() }),
        error => error.code === 'CONTENT_CONFLICT'
      );
      await revoke('conflict-' + variant);
      assert.equal((await fence.revoke(scope('conflict-' + variant), { signal: signal() })).complete, true);
    }
    checks.push({
      name: 'conflicting_and_oversized_provider_content',
      exact_replay_refused: true,
      bounded_read_overflow_refused: true,
    });

    await authorize('crash');
    const crashPlan = await fence.register(scope('crash'), 'provider-committed-sql-lost', bodies);
    await revoke('crash');
    const interruptedStore = {
      getObjectWriteBinding: store.getObjectWriteBinding.bind(store),
      registerObjectWritePlan: store.registerObjectWritePlan.bind(store),
      listRevokedObjectWrites: store.listRevokedObjectWrites.bind(store),
      async markObjectWriteFenced() {
        throw new Error('Injected interruption before SQL completion');
      },
    };
    await assert.rejects(make(storage, interruptedStore).revoke(scope('crash'), { signal: signal() }));
    const [crashMetadata] = await storage.bucket(config.bucket).file(crashPlan.objects[0].object_name).getMetadata();
    assert.ok(crashMetadata.metadata.adcp_reporting_tombstone);
    assert.equal((await store.listRevokedObjectWrites(scope('crash'))).length, 2);
    const child = await run(process.execPath, [__filename, inputFile, packageRoot, fixtures, output, 'recover'], {
      timeout: 120000,
      maxBuffer: 65536,
    });
    assert.equal(JSON.parse(child.stdout).fresh_process_recovered, true);
    assert.equal((await store.listRevokedObjectWrites(scope('crash'))).length, 0);
    checks.push({ name: 'provider_tombstone_before_sql_completion', fresh_process_recovered: true });

    await authorize('isolated');
    const isolated = await fence.register(scope('isolated'), 'live-other-account', bodies);
    await fence.write(isolated, 0, rows, { signal: signal() });
    assert.equal(
      sha((await storage.bucket(config.bucket).file(isolated.objects[0].object_name).download())[0]),
      sha(rows)
    );
    await assert.rejects(fence.revoke(scope('isolated'), { signal: signal() }), e => e.code === 'NOT_REVOKED');
    const anotherNamespace = sdk.createGcsReportingObjectFenceV1({
      storage,
      store,
      bucket: config.bucket,
      namespace: namespace + '/other',
    });
    await assert.rejects(
      anotherNamespace.write(isolated, 0, rows, { signal: signal() }),
      e => e.code === 'INVALID_INPUT'
    );
    await assert.rejects(
      anotherNamespace.register(scope('isolated'), 'changed-binding', bodies),
      e => e.code === 'CONTENT_CONFLICT'
    );
    const esm = await import(path.resolve(packageRoot, 'node_modules/@adcp/sdk/dist/lib/reporting/gcs/index.mjs'));
    const mixed = esm.createGcsReportingObjectFenceV1({
      storage,
      store,
      bucket: config.bucket,
      namespace: namespace + '/mixed-format',
    });
    await assert.rejects(
      mixed.register(scope('isolated'), 'mixed-binding', bodies),
      e => e.code === 'CONTENT_CONFLICT'
    );
    await assert.rejects(mixed.revoke(scope('isolated'), { signal: signal() }), e => e.code === 'NOT_REVOKED');
    await revoke('isolated');
    assert.equal((await anotherNamespace.revoke(scope('isolated'), { signal: signal() })).complete, true);
    checks.push({
      name: 'account_and_namespace_isolation',
      other_account_rows_retained_until_own_revocation: true,
      authoritative_binding_survives_namespace_rotation: true,
      mixed_cjs_store_esm_fence_errors_verified: true,
    });

    // Real request held after provider response: deadline must prevent follow-on I/O.
    await authorize('deadline-cleanup');
    await fence.register(scope('deadline-cleanup'), 'held-probe', bodies);
    await revoke('deadline-cleanup');
    const delayedProbeStorage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
    const probeBucket = delayedProbeStorage.bucket(config.bucket);
    delayedProbeStorage.bucket = name => {
      assert.equal(name, config.bucket);
      return probeBucket;
    };
    const metadataCall = probeBucket.getMetadata.bind(probeBucket);
    let probeRelease, probeReady;
    const probeGate = new Promise(resolve => {
      probeRelease = resolve;
    });
    const probeStarted = new Promise(resolve => {
      probeReady = resolve;
    });
    probeBucket.getMetadata = async () => {
      const result = await metadataCall();
      probeReady();
      await probeGate;
      return result;
    };
    let followOnCalls = 0;
    const probeFile = probeBucket.file.bind(probeBucket);
    probeBucket.file = (...args) => {
      followOnCalls++;
      return probeFile(...args);
    };
    const stopped = make(delayedProbeStorage, store, 1000).revoke(scope('deadline-cleanup'), { signal: signal() });
    const stoppedResult = stopped.then(
      () => ({ unexpected_success: true }),
      error => ({ code: error.code })
    );
    await probeStarted;
    assert.equal((await stoppedResult).code, 'DEADLINE_EXCEEDED');
    probeRelease();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(followOnCalls, 0);
    assert.equal((await store.listRevokedObjectWrites(scope('deadline-cleanup'))).length, 2);
    assert.equal((await fence.revoke(scope('deadline-cleanup'), { signal: signal() })).complete, true);
    checks.push({
      name: 'deadline_stops_follow_on_cleanup',
      follow_on_provider_calls: 0,
      resumable_from_inventory: true,
    });

    const privateFailure = 'private-state-input-do-not-expose';
    const unavailableStore = {
      ...interruptedStore,
      getObjectWriteBinding: async () => {
        throw new Error(privateFailure);
      },
    };
    await assert.rejects(
      make(storage, unavailableStore).revoke(scope('deadline-cleanup'), { signal: signal() }),
      error => {
        assert.equal(error.code, 'STATE_UNAVAILABLE');
        assert.equal(error.cause, undefined);
        assert.equal(String(error).includes(privateFailure), false);
        return true;
      }
    );
    checks.push({ name: 'state_error_privacy', sanitized_without_raw_cause: true });

    const result = {
      status: 'passed',
      scope: 'GCS write-fence primitive with real PostgreSQL; not full managed delivery or least-privilege deployment',
      node: process.version,
      verified_bucket_policy: safePolicy,
      official_google_storage_version: JSON.parse(
        readFileSync(path.resolve(path.dirname(req.resolve('@google-cloud/storage')), '../../../package.json'))
      ).version,
      typescript_sdk_version: JSON.parse(readFileSync(path.join(packageRoot, 'node_modules/@adcp/sdk/package.json')))
        .version,
      fixture_rows_sha256: sha(rows),
      fixture_manifest_sha256: sha(manifest),
      checks,
    };
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ status: 'passed', checks: checks.length, node: process.version }));
  } finally {
    await pool.end();
    if (created) await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await bootstrap.end();
  }
}
main().catch(error => {
  // Raw provider errors, resumable-session URIs and private inputs must not escape.
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      error_type: error.name,
      code: typeof error.code === 'string' && /^[A-Z][A-Z_0-9]{0,80}$/.test(error.code) ? error.code : undefined,
    }) + '\n'
  );
  process.exitCode = 1;
});
