import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6, 'usage: run.mjs PYTHON PACKAGE_ROOT TS_ARCHIVE PY_WHEEL PY_HARNESS OUTPUT');
  const [python, packageRoot, archive, wheel, upstream, output] = args.map(value => path.resolve(value));
  const pins = JSON.parse(await readFile(path.join(here, 'pins.json')));
  assert.equal(digest(await readFile(wheel)), pins.python_wheel_sha256, 'Python wheel differs from pin');
  const identity = await exec('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { cwd: upstream, timeout: 30_000 });
  assert.equal(identity.stdout.trim(), pins.python_harness_commit, 'Python harness differs from pin');
  const status = await exec('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: upstream,
    timeout: 30_000,
  });
  assert.equal(status.stdout, '', 'Python harness has modified tracked files');
  // A fresh evidence directory prevents an old successful result from surviving
  // a failed run. The runner always executes both production and consumption.
  await mkdir(output);
  const report = {
    contract: 'reporting_evidence_interop_v1',
    fixture_version: 1,
    adcp_schema_version: pins.adcp_schema_version,
    fixture_adcp_schema_version: JSON.parse(
      await readFile(path.join(root, 'test/fixtures/reporting-interop/evidence-v1.json'))
    ).adcp_schema_version,
    node: process.version,
    python_version: pins.python_version,
    python_harness_commit: pins.python_harness_commit,
    python_wheel_sha256: pins.python_wheel_sha256,
    typescript_archive_sha256: digest(await readFile(archive)),
    typescript_package_lock_sha256: digest(await readFile(path.join(packageRoot, 'package-lock.json'))),
    fixture_sha256: digest(await readFile(path.join(root, 'test/fixtures/reporting-interop/evidence-v1.json'))),
    gate_entrypoints: Object.fromEntries(
      await Promise.all(
        (await readdir(here))
          .filter(name => /\.(py|cjs|mjs|json)$/.test(name))
          .sort()
          .map(async name => [name, digest(await readFile(path.join(here, name)))])
      )
    ),
    checks: [],
    status: 'failed',
  };
  const fixtureRoot = path.join(root, 'test/fixtures');
  const resources = path.join(fixtureRoot, 'reporting-interop/resources');
  report.fixture_inputs_sha256 = Object.fromEntries(
    await Promise.all(
      [
        'evidence-v1.json',
        'canonical-json-v1.json',
        ...(await readdir(resources)).sort().map(name => `resources/${name}`),
      ].map(async name => [name, digest(await readFile(path.join(fixtureRoot, 'reporting-interop', name)))])
    )
  );
  const tsScript = path.join(here, 'typescript.cjs');
  const pyScript = path.join(here, 'python.py');
  const run = async (name, executable, argv, timeout = 120_000) => {
    report.active_step = name;
    let result;
    try {
      result = await exec(executable, argv, { cwd: output, timeout, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      report.failed_step = name;
      report.failure = { code: error.code, signal: error.signal, name: error.name };
      // Fixture diagnostics contain only immutable public vectors. Runtime
      // owners emit safe stage metadata here and scrub their private logs.
      await writeFile(path.join(output, `${name}.stderr.log`), error.stderr ?? 'Child process failed before output');
      throw error;
    }
    const value = JSON.parse(result.stdout);
    const retained = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(output, `${name}.json`), retained);
    report.checks.push({ name, sha256: digest(Buffer.from(retained)) });
    delete report.active_step;
    return value;
  };
  try {
    report.active_step = 'export-pinned-harness';
    const exported = path.join(output, 'python-harness');
    const exportResult = await exec(
      python,
      [
        '-I',
        path.join(here, 'export.py'),
        upstream,
        path.join(output, 'python-harness.tar'),
        exported,
        pins.python_harness_commit,
      ],
      { timeout: 60_000 }
    );
    report.harness_export = JSON.parse(exportResult.stdout);
    // Verify actual installed package members against both archives before
    // attributing any result to a published wheel or packed checkout.
    report.active_step = 'verify-installed-artifacts';
    const installed = await exec(python, ['-I', path.join(here, 'verify.py'), packageRoot, archive, wheel], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    report.installed_artifacts = JSON.parse(installed.stdout);
    await writeFile(
      path.join(output, 'typescript-package-lock.json'),
      await readFile(path.join(packageRoot, 'package-lock.json'))
    );
    delete report.active_step;
    await run('typescript-producer', process.execPath, [tsScript, packageRoot, fixtureRoot]);
    await run('python-producer', python, ['-I', pyScript, fixtureRoot]);
    await run('python-consumes-typescript', python, [
      '-I',
      pyScript,
      fixtureRoot,
      path.join(output, 'typescript-producer.json'),
    ]);
    await run('typescript-consumes-python', process.execPath, [
      tsScript,
      packageRoot,
      fixtureRoot,
      path.join(output, 'python-producer.json'),
    ]);
    assert.ok(process.env.REPORTING_INTEROP_PG_URL, 'REPORTING_INTEROP_PG_URL is required');
    await run(
      'typescript-seller-python-buyer-core',
      python,
      ['-I', path.join(here, 'core.py'), exported, packageRoot, process.execPath, output],
      300_000
    );
    for (const mode of ['managed', 'billing']) {
      await run(
        `typescript-seller-python-buyer-${mode}`,
        python,
        ['-I', path.join(here, 'managed.py'), exported, packageRoot, process.execPath, path.join(output, mode), mode],
        300_000
      );
    }
    await run(
      'typescript-sender-python-verifier-notification',
      python,
      ['-I', path.join(here, 'notification.py'), packageRoot, process.execPath, path.join(output, 'notification')],
      240_000
    );
    await run(
      'typescript-reporting-activity-python-durable-verifier',
      python,
      [
        '-I',
        path.join(here, 'notification.py'),
        packageRoot,
        process.execPath,
        path.join(output, 'activity-notification'),
        'activity',
      ],
      240_000
    );
    await run(
      'typescript-seller-python-durable-adjustment-loop',
      python,
      ['-I', path.join(here, 'adjustment.py'), packageRoot, process.execPath, path.join(output, 'adjustment-loop')],
      660_000
    );
    await run(
      'python-durable-mixed-receipt-submissions',
      python,
      ['-I', path.join(here, 'buyer-submissions.py'), exported, path.join(output, 'buyer-submissions')],
      660_000
    );
    report.status = 'passed';
  } finally {
    if (report.status === 'failed' && report.active_step) report.failed_step = report.active_step;
    await writeFile(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    await rm(path.join(output, 'python-harness'), { recursive: true, force: true });
  }
  console.log(`Reporting interop passed: ${report.checks.length} checks; evidence at ${output}`);
}

main().catch(() => {
  // Child commands and environments can contain private operational inputs.
  // Detailed test evidence lives in the owned output directory, never here.
  console.error('Reporting interoperability gate failed. Inspect result.json and retained probe evidence.');
  process.exitCode = 1;
});
