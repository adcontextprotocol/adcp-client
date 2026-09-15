const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('yaml');

const root = path.resolve(__dirname, '..');
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const { jobs } = workflow;
const consumers = [
  'library-checks',
  'adopter-typechecks',
  'example-typechecks',
  'unit-tests-fast',
  'unit-tests-slow',
  'webhook-delivery-backends',
  'eslint-plugin-tests',
  'node-undici-network-matrix',
];
const download = jobs['library-checks'].steps.find(step => step.name === 'Download library output');
const verify = jobs['library-checks'].steps.find(step => step.name === 'Verify and extract library output');
const archive = jobs['library-build'].steps.find(step => step.id === 'archive');

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
function shell(script, cwd, env) {
  // Match the explicit shell: bash invocation on GitHub-hosted Linux runners.
  return run('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], cwd, env);
}
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-ci-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  succeeds(run('git', ['init', '-q'], cwd));
  fs.copyFileSync(path.join(root, 'README.md'), path.join(cwd, 'README.md'));
  succeeds(run('git', ['add', '.'], cwd));
  succeeds(
    run('git', ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'test: fixture'], cwd)
  );
  const sha = succeeds(run('git', ['rev-parse', 'HEAD'], cwd));
  const temp = path.join(cwd, 'runner temp');
  fs.mkdirSync(temp);
  return { cwd, env: { GITHUB_SHA: sha, RUNNER_TEMP: temp, GITHUB_OUTPUT: path.join(temp, 'outputs') } };
}

test('artifact identity and digest are bound to the producing job and this workflow run', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(jobs['library-build'].outputs, {
    sha256: '${{ steps.archive.outputs.sha256 }}',
    commit: '${{ steps.archive.outputs.commit }}',
  });
  const upload = jobs['library-build'].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'library-dist-${{ github.run_id }}');
  assert.equal(upload.with.path, '${{ runner.temp }}/library-dist.tar.gz');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with.overwrite, true); // Full reruns replace the previous attempt.
  assert.deepEqual(download.with, {
    name: upload.with.name,
    path: '${{ runner.temp }}/library-artifact',
  }); // No alternate token/repository/run, pattern or continue-on-error fallback.
  assert.deepEqual(verify.env, {
    LIBRARY_SHA256: '${{ needs.library-build.outputs.sha256 }}',
    LIBRARY_COMMIT: '${{ needs.library-build.outputs.commit }}',
  });
  assert.ok(jobs['library-build'].steps.indexOf(archive) < jobs['library-build'].steps.indexOf(upload));
});

test('all consumers verify before use, without rebuilding or waiting for package checks', () => {
  for (const name of consumers) {
    const job = jobs[name];
    assert.equal(job.needs, 'library-build', name);
    assert.equal(job.if, undefined, name); // Default success gating; no always() consumers.
    assert.ok(!job.steps.some(step => /npm (run build|test$)/m.test(step.run ?? '')), name);
    const index = job.steps.findIndex(step => step.name === download.name);
    assert.ok(index >= 0, name);
    assert.deepEqual(job.steps[index], download, name);
    assert.deepEqual(job.steps[index + 1], verify, name);
    assert.equal(download.if, undefined);
    assert.equal(download['continue-on-error'], undefined);
    assert.equal(verify.if, undefined);
    assert.equal(verify['continue-on-error'], undefined);
  }
  assert.deepEqual(jobs['unit-tests-fast'].strategy.matrix.shard, ['1/3', '2/3', '3/3']);
  for (const name of [
    'generated-checks',
    'typescript-typecheck',
    'package-smoke',
    'node-undici-runtime-matrix',
    'example-integration-tests',
  ]) {
    assert.equal(jobs[name].needs, undefined, `${name} must remain an independent early lane`);
  }
  assert.ok(jobs['typecheck-build'].needs.includes('library-checks'));
  assert.ok(jobs.test.needs.includes('node-undici-runtime-matrix'));
  assert.ok(jobs.test.needs.includes('node-undici-network-matrix'));
});

test('Node floor rebuilds and external runtime compatibility retain every matrix cell', () => {
  const packageJob = jobs['node-undici-runtime-matrix'];
  const networkJob = jobs['node-undici-network-matrix'];
  assert.deepEqual(packageJob.strategy.matrix.include, [
    { node: '20.19.0', undici: '6.28.0', mode: 'package' },
    { node: '22.12.0', undici: '6.28.0', mode: 'package' },
  ]);
  assert.deepEqual(networkJob.strategy.matrix.include, [
    { node: '20.19.0', undici: '7.29.0', mode: 'network' },
    { node: '24.x', undici: '6.28.0', mode: 'network' },
  ]);
  assert.ok(packageJob.steps.some(step => step.run === 'npm run build:lib'));
  assert.ok(!packageJob.steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
  assert.equal(packageJob.steps.find(step => step.run === 'npm run verify:package').if, "matrix.mode == 'package'");
  const override = networkJob.steps.find(step => step.run === 'npm run verify:package');
  assert.equal(override.if, "matrix.undici == '7.29.0'");
  assert.deepEqual(override.env, { ADCP_UNDICI_OVERRIDE: '7.29.0' });
  assert.equal(
    networkJob.steps.find(step => step.name === 'Network-sensitive SDK suites').if,
    "matrix.mode == 'network'"
  );
  for (const job of [packageJob, networkJob]) {
    assert.ok(
      job.steps.some(step =>
        step.run?.includes('npm install --no-save --package-lock=false "undici@${{ matrix.undici }}"')
      )
    );
    assert.ok(job.steps.some(step => step.run === 'npm run check:runtime-compat'));
  }
});

test('the actual archive/verification scripts round-trip output and reject stale, missing or tampered inputs', t => {
  const { cwd, env } = fixture(t);
  fs.mkdirSync(path.join(cwd, 'dist'));
  const content = fs.readFileSync(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(cwd, 'dist/package.json'), content);
  succeeds(shell(archive.run, cwd, env));
  const outputs = Object.fromEntries(
    fs
      .readFileSync(env.GITHUB_OUTPUT, 'utf8')
      .trim()
      .split('\n')
      .map(line => line.split('='))
  );
  const bytes = fs.readFileSync(path.join(env.RUNNER_TEMP, 'library-dist.tar.gz'));
  assert.equal(outputs.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(outputs.commit, env.GITHUB_SHA);
  const artifactDir = path.join(env.RUNNER_TEMP, 'library-artifact');
  fs.mkdirSync(artifactDir);
  const artifactPath = path.join(artifactDir, 'library-dist.tar.gz');
  fs.writeFileSync(artifactPath, bytes);
  fs.writeFileSync(path.join(cwd, 'dist/stale'), 'must not survive extraction');
  const consumerEnv = { ...env, LIBRARY_SHA256: outputs.sha256, LIBRARY_COMMIT: outputs.commit };
  succeeds(shell(verify.run, cwd, consumerEnv));
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'dist/package.json')), content);
  assert.equal(fs.existsSync(path.join(cwd, 'dist/stale')), false);

  for (const badEnv of [{ LIBRARY_SHA256: '' }, { LIBRARY_SHA256: 'invalid' }, { LIBRARY_COMMIT: '0'.repeat(40) }]) {
    const result = shell(verify.run, cwd, { ...consumerEnv, ...badEnv });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::Missing library-build digest or checkout identity mismatch/);
  }
  fs.appendFileSync(artifactPath, 'corrupt');
  let result = shell(verify.run, cwd, consumerEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::Library artifact SHA-256 mismatch/);
  fs.unlinkSync(artifactPath);
  result = shell(verify.run, cwd, consumerEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::Missing library-build artifact/);
  // Existing dist never makes a failed verification succeed.
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'dist/package.json')), content);
  assert.notEqual(shell(archive.run, cwd, { ...env, GITHUB_SHA: '0'.repeat(40) }).status, 0);
});

test('package smoke still skips doc-only changes and rebuilds for workflow changes or an unavailable base', t => {
  const { cwd, env } = fixture(t);
  const job = jobs['package-smoke'];
  assert.ok(job.steps.some(step => step.run === 'npm run build:lib'));
  assert.ok(!job.steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
  const detect = job.steps.find(step => step.id === 'detect');
  for (const step of job.steps.slice(job.steps.indexOf(detect) + 1)) {
    assert.equal(step.if, "steps.detect.outputs.changed == 'true'", step.name);
  }
  function changed(base) {
    fs.writeFileSync(env.GITHUB_OUTPUT, '');
    succeeds(
      shell(detect.run.replace('${{ github.event.pull_request.base.sha || github.event.before }}', base), cwd, env)
    );
    return fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim();
  }
  function commit() {
    succeeds(run('git', ['add', '.'], cwd));
    succeeds(
      run('git', ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'test: change'], cwd)
    );
  }
  fs.appendFileSync(path.join(cwd, 'README.md'), '\nDocumentation-only change.\n');
  commit();
  assert.equal(changed(env.GITHUB_SHA), 'changed=false');
  assert.equal(changed(''), 'changed=true');
  assert.equal(changed('0'.repeat(40)), 'changed=true');
  fs.mkdirSync(path.join(cwd, '.github/workflows'), { recursive: true });
  fs.copyFileSync(path.join(root, '.github/workflows/ci.yml'), path.join(cwd, '.github/workflows/ci.yml'));
  commit();
  assert.equal(changed(env.GITHUB_SHA), 'changed=true');
});

test('required aggregators reject failed, skipped and cancelled dependencies', () => {
  for (const name of ['test', 'unit-tests', 'typecheck-build']) {
    const job = jobs[name];
    assert.equal(job.if, '${{ always() }}');
    const needs = Object.fromEntries(job.needs.map(dependency => [dependency, { result: 'success' }]));
    succeeds(shell(job.steps[0].run, root, { NEEDS_JSON: JSON.stringify(needs) }));
    for (const result of ['failure', 'skipped', 'cancelled']) {
      for (const dependency of job.needs) {
        const failed = { ...needs, [dependency]: { result } };
        assert.notEqual(
          shell(job.steps[0].run, root, { NEEDS_JSON: JSON.stringify(failed) }).status,
          0,
          `${name}: ${dependency} ${result}`
        );
      }
    }
  }
});
