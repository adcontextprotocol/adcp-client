/**
 * CLI plumbing for `--auth-scheme bearer|basic` (HTTP Basic auth for gateways
 * fronting an AdCP agent — Apigee, Kong, AWS API GW with a BasicAuthentication
 * policy that rejects `Authorization: Bearer` outright).
 *
 * Asserts:
 *   - `--save-auth … --auth user:pass --auth-scheme basic` persists
 *     `auth_scheme: 'basic'` alongside the raw `user:pass` in
 *     `~/.adcp/config.json`. The scheme survives a round trip through the
 *     saved-agent path.
 *   - `--auth-scheme basic` requires `--auth` (no token = nothing to encode).
 *   - `--auth-scheme basic --auth <token-without-colon>` fails at register time
 *     so a typo doesn't surface as a confusing decode error on every later call.
 *   - `--auth-scheme bogus` is rejected at parse time.
 *   - `--list-agents` surfaces the scheme so operators can tell at a glance.
 *   - Wire test: a saved basic alias produces `Authorization: Basic <b64>` on
 *     the actual transport — no `Bearer` token leaks through.
 *
 * Isolated by pointing `HOME` at a temp dir so writes to `~/.adcp/config.json`
 * don't touch the user's real config.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpHome;

function runCli(args, extraEnv = {}, opts = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, ...extraEnv },
    timeout: opts.timeout ?? 10000,
  });
}

function configPath() {
  return path.join(tmpHome, '.adcp', 'config.json');
}

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-authscheme-'));
});

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('--save-auth persists auth_scheme=basic with user:pass credentials', () => {
  const result = runCli([
    '--save-auth',
    'gateway-basic',
    'https://agent.example.com/mcp',
    '--auth',
    'svc-user:s3cret-pa55',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-basic'].auth_token, 'svc-user:s3cret-pa55');
  assert.strictEqual(cfg.agents['gateway-basic'].auth_scheme, 'basic');
});

test('--save-auth omits auth_scheme when scheme is bearer (default)', () => {
  const result = runCli(['--save-auth', 'gateway-bearer', 'https://agent.example.com/mcp', '--auth', 'tok-abc']);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-bearer'].auth_token, 'tok-abc');
  assert.strictEqual(
    cfg.agents['gateway-bearer'].auth_scheme,
    undefined,
    'bearer is the default; the field is omitted to keep config files clean'
  );
});

test('--auth-scheme rejects values other than bearer|basic', () => {
  const result = runCli([
    '--save-auth',
    'bad-scheme',
    'https://agent.example.com/mcp',
    '--auth',
    'whatever',
    '--auth-scheme',
    'digest',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /--auth-scheme must be 'bearer' or 'basic'/);
});

test('--auth-scheme basic requires --auth (no token = nothing to encode)', () => {
  const result = runCli(['--save-auth', 'no-token', 'https://agent.example.com/mcp', '--auth-scheme', 'basic']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /--auth-scheme requires --auth/);
});

test('--auth-scheme basic rejects an --auth value missing the colon at register time', () => {
  const result = runCli([
    '--save-auth',
    'malformed',
    'https://agent.example.com/mcp',
    '--auth',
    'no-colon-here',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /must be in 'user:pass' form \(no ':' found\)/);
  // Config must not have been written.
  const cfg = fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : { agents: {} };
  assert.strictEqual(cfg.agents['malformed'], undefined);
});

test('--auth-scheme basic rejects empty username', () => {
  const result = runCli([
    '--save-auth',
    'empty-user',
    'https://agent.example.com/mcp',
    '--auth',
    ':only-password',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /username must not be empty/);
});

test('--auth-scheme basic rejects CR/LF in the credential (header-smuggling defense)', () => {
  const result = runCli([
    '--save-auth',
    'crlf',
    'https://agent.example.com/mcp',
    '--auth',
    'user:pass\r\nX-Smuggle: yes',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /CR, LF, NUL, or non-printable/);
});

test('--list-agents shows scheme + username for basic, bearer label for bearer (no nested parens)', () => {
  // Reuses 'gateway-basic' and 'gateway-bearer' from earlier tests. node:test
  // runs declared-order so we know they exist.
  const result = runCli(['--list-agents']);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  // Basic shows username — already on disk in cleartext, surfacing it makes
  // multi-tenant aliases immediately distinguishable. Password stays hidden.
  assert.match(result.stdout, /gateway-basic/);
  assert.match(result.stdout, /Auth: HTTP Basic \(user=svc-user\)/);
  assert.doesNotMatch(result.stdout, /s3cret-pa55/, 'password must NEVER appear in --list-agents output');
  // Bearer alias gets a plain label (no nested parens, no scheme noise).
  assert.match(result.stdout, /gateway-bearer/);
  assert.match(result.stdout, /Auth: bearer token configured/);
});

test('--auth-scheme=basic single-token form parses identically to --auth-scheme basic', () => {
  // Security-reviewer L3 from PR #1719: the long-form path treated
  // `--auth-scheme=basic` as an unknown arg and silently fell through to
  // env-var lookup. The equals form is now first-class.
  const result = runCli([
    '--save-auth',
    'gateway-eqform',
    'https://agent.example.com/mcp',
    '--auth',
    'svc-eq:passw0rd',
    '--auth-scheme=basic',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-eqform'].auth_scheme, 'basic');
});

test('ADCP_AUTH_SCHEME env var supplies the scheme when no flag is passed', () => {
  // Confirm the env var actually works on the save path (used by CI scripts
  // that set ADCP_AUTH_SCHEME globally instead of repeating the flag).
  const result = runCli(
    ['--save-auth', 'gateway-env', 'https://agent.example.com/mcp', '--auth', 'env-user:env-pass'],
    { ADCP_AUTH_SCHEME: 'basic' }
  );
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-env'].auth_scheme, 'basic');
});

test('invariant: a saved header bag with Authorization gets stripped — basic injection MUST run after mergeHeaders', () => {
  // Refactor-safety guard from the code-reviewer follow-up. Two facts the
  // CLI relies on:
  //   1. `mergeHeaders` strips reserved auth-class keys case-insensitively.
  //   2. `injectBasicAuthHeader` adds `Authorization: Basic …` AFTER step 1.
  // If a future refactor moves the injection inside or before mergeHeaders,
  // (1) silently drops the basic header — the wire test catches the symptom,
  // but this test catches the cause earlier. We exercise (1) end-to-end
  // through `--list-agents` after hand-editing a saved alias to smuggle an
  // `authorization` header — the merge filter MUST drop it on read.
  const cfgFile = configPath();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.agents['invariant-check'] = {
    url: 'https://agent.example.com/mcp',
    protocol: 'mcp',
    auth_token: 'tok-real',
    headers: {
      authorization: 'Bearer attacker',
      'x-adcp-tenant': 'real-tenant',
    },
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  // Invoke any command path that runs through mergeHeaders. `--list-agents`
  // just reads; we need a path that actually merges. Use the `tools/list`
  // invocation with --dry-run-equivalent (debug) — saves a network call.
  // But there's no global dry-run; instead use the `--list-agents` path,
  // which doesn't trigger mergeHeaders. Simpler: invoke any agent command
  // with --debug — the merge runs at agentConfig construction time, and the
  // warning emits from mergeHeaders if a reserved key was present.
  const result = runCli(['invariant-check', '--debug']);
  // The warning must fire — proves mergeHeaders' filter still strips
  // `authorization` keys from saved configs. A regression that moved basic
  // injection into mergeHeaders would also affect this path.
  assert.match(
    result.stderr,
    /ignoring saved authorization header/,
    `expected mergeHeaders to strip the smuggled authorization key. stderr was:\n${result.stderr}`
  );
});

test('ADCP_AUTH_SCHEME=basic without --auth produces a stderr warning on direct invocation', async t => {
  // The advisory: env-var set but no token resolved → the env is silently
  // shadowed (defaults to bearer with no token), and the caller's Basic
  // gateway would 401 with no indication why. Warn at the seam.
  // Spin up a real-ish 401 server so the CLI reaches `maybeWarnAuthSchemeIneffective`
  // and emits the warning before bouncing through error handling.
  const server = http.createServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });

  const run = await new Promise(resolve => {
    const child = spawn('node', [CLI, url, 'tools/list', '--protocol', 'mcp', '--allow-http'], {
      env: { ...process.env, HOME: tmpHome, ADCP_AUTH_SCHEME: 'basic' },
    });
    let stderr = '';
    child.stderr.on('data', d => (stderr += d.toString()));
    const killer = setTimeout(() => child.kill('SIGTERM'), 12000);
    child.on('exit', code => {
      clearTimeout(killer);
      resolve({ status: code, stderr });
    });
  });
  assert.match(
    run.stderr,
    /Warning: ADCP_AUTH_SCHEME=basic is set but did not apply/,
    `expected env-var ineffective warning, stderr was:\n${run.stderr}`
  );
});

test('runtime mutex: --auth-scheme basic + --oauth fails closed instead of silently dropping the credential', () => {
  // Save a bearer alias to the local config so the dispatcher resolves the
  // first positional. The actual URL is unreachable but we exit before the
  // network call thanks to the mutex.
  const save = runCli(['--save-auth', 'mutex-alias', 'https://agent.example.com/mcp', 'mcp', '--auth', 'tok-abc']);
  assert.strictEqual(save.status, 0, `setup save failed: ${save.stderr}`);

  const result = runCli([
    'mutex-alias',
    'get_products',
    '{}',
    '--auth',
    'user:pass',
    '--auth-scheme',
    'basic',
    '--oauth',
  ]);
  assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}; stderr was:\n${result.stderr}`);
  assert.match(result.stderr, /--auth-scheme basic cannot be combined with --oauth/);
});

test('401 path surfaces the --auth-scheme basic hint before bouncing to OAuth', async t => {
  // Spin up a local server that returns 401 to every probe. The CLI's 401
  // handler prints "Server requires authentication" and then the Basic-hint
  // line we want to assert, before attempting OAuth. We don't care that the
  // OAuth attempt then fails — we care that an Apigee-fronted adopter sees
  // the alternative routing path before they wait for a browser flow to load.
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });

  // No `--auth` at all — that's the entry point into the OAuth-bounce branch
  // we're hardening. Async spawn (not spawnSync) so the server can accept
  // probes on the same event loop. 12s cap is plenty — the SDK's discovery
  // walk against an instantly-401-ing server short-circuits in <1s; the
  // remaining budget is OAuth provider initialization before it errors out.
  const run = await new Promise(resolve => {
    const child = spawn('node', [CLI, url, 'tools/list', '--protocol', 'mcp', '--allow-http'], {
      env: { ...process.env, HOME: tmpHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    const killer = setTimeout(() => child.kill('SIGTERM'), 12000);
    child.on('exit', code => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr });
    });
  });

  // Hint must appear in the 401-handler output before the OAuth attempt
  // begins. We assert against stdout (where the CLI prints user-facing 401
  // messages); stderr would also work if the implementation moves.
  const combined = run.stdout + run.stderr;
  assert.match(
    combined,
    /If your agent is fronted by an HTTP-Basic gateway, retry with: --auth <user:pass> --auth-scheme basic/,
    `expected --auth-scheme basic hint in 401 path output, got:\n${combined}`
  );
});

test('storyboard run banner shows "Auth: basic" not "Auth: bearer" when --auth-scheme basic', async t => {
  // The banner at bin/adcp.js:4213 previously had no 'basic' branch and fell
  // through to 'bearer', misleading operators into thinking --auth-scheme
  // wasn't being picked up even though the wire auth was correct (issue #1865).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });

  const run = await new Promise(resolve => {
    const child = spawn(
      'node',
      [CLI, 'storyboard', 'run', url, '--auth', 'user:pass', '--auth-scheme', 'basic', '--allow-http'],
      { env: { ...process.env, HOME: tmpHome } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    // Kill after 8s — the banner appears immediately; we don't need a full run.
    const killer = setTimeout(() => child.kill('SIGTERM'), 8000);
    child.on('exit', code => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr });
    });
  });

  assert.match(run.stdout, /Auth: basic/, `banner must show 'Auth: basic'; stdout: ${run.stdout}`);
  assert.doesNotMatch(run.stdout, /Auth: bearer/, `banner must not say 'bearer'; stdout: ${run.stdout}`);
});

test('wire test: basic alias sends Authorization: Basic <b64(user:pass)>, not Bearer', async t => {
  // Spin up a tiny MCP-ish server that captures every Authorization header
  // it sees and returns 401 so the CLI exits quickly. The /mcp probe and the
  // RFC 9728 well-known probes both flow through here; we want the Authorization
  // header attached to the /mcp probe (the only path that actually carries
  // user-supplied auth — well-knowns are unauthenticated by spec).
  const seenAuthByPath = {};
  const server = http.createServer((req, res) => {
    seenAuthByPath[req.url] = req.headers.authorization ?? '';
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;

  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });

  // Save the alias pointing at the local server, then invoke it.
  const save = runCli([
    '--save-auth',
    'wire-basic',
    url,
    'mcp',
    '--auth',
    'inmobi:gateway-secret',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(save.status, 0, `save failed, stderr: ${save.stderr}`);

  // `adcp <alias> <tool>` resolves the alias and dispatches via MCP. The SDK
  // walks /mcp + /mcp/ + a couple of well-known probes when discovering an
  // unknown endpoint; we let that play out (up to ~15s) and then assert on
  // the first /mcp probe's Authorization header — the only header the SDK
  // attaches user-supplied auth to.
  //
  // CRITICAL: must use async `spawn`, not `spawnSync`. The local HTTP server
  // runs on the same Node event loop as the test runner; `spawnSync` blocks
  // the loop until the child exits, so the server never accepts the child's
  // requests and the test deadlocks until the timeout.
  const run = await new Promise(resolve => {
    const child = spawn('node', [CLI, 'wire-basic', 'get_products', '{"brief":"x"}', '--allow-http', '--debug'], {
      env: { ...process.env, HOME: tmpHome },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', d => (stderr += d.toString()));
    child.stdout.on('data', d => (stdout += d.toString()));
    const killer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.on('exit', code => {
      clearTimeout(killer);
      resolve({ status: code, stderr, stdout });
    });
  });

  const paths = Object.keys(seenAuthByPath);
  assert.ok(
    paths.length > 0,
    `expected the local server to receive at least one request — stderr was:\n${run.stderr}\nstdout was:\n${run.stdout}`
  );

  // The SDK walks /mcp + /mcp/ + a couple of well-knowns when discovering an
  // unknown MCP endpoint. We assert two things:
  //   1. At least one /mcp[/] probe carried the Basic header — proves the
  //      scheme switch actually reached the wire.
  //   2. No /mcp[/] probe ever sent `Authorization: Bearer …` — proves the
  //      CLI didn't leak the credential in the wrong scheme.
  // Well-known probes are unauthenticated by spec and intentionally excluded.
  const expected = 'Basic ' + Buffer.from('inmobi:gateway-secret').toString('base64');
  const mcpProbeAuths = Object.entries(seenAuthByPath)
    .filter(([p]) => !p.includes('/.well-known/'))
    .map(([, a]) => a);
  assert.ok(
    mcpProbeAuths.some(a => a === expected),
    `expected at least one /mcp probe to carry '${expected}'.\n` +
      `Headers by path: ${JSON.stringify(seenAuthByPath, null, 2)}\n` +
      `stderr was:\n${run.stderr}`
  );
  for (const auth of mcpProbeAuths) {
    assert.doesNotMatch(
      auth ?? '',
      /^Bearer /,
      `bearer prefix on an /mcp probe means --auth-scheme basic was ignored.\n` +
        `Headers by path: ${JSON.stringify(seenAuthByPath, null, 2)}`
    );
  }
});
