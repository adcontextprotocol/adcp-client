#!/usr/bin/env tsx
/**
 * Agent-skill compliance harness.
 *
 * Spins up a non-interactive Claude Code instance in a scratch workspace,
 * hands it a `build-*-agent` skill + a target storyboard, and grades
 * whatever server Claude produces. The question this answers is "can an
 * agent with our SDK + skill build something that passes the conformance
 * storyboards?" — the capstone dogfood test for the publisher stack.
 *
 * Boundaries:
 *   - Harness pre-populates `package.json` with `"@adcp/sdk": "file:<repo>"`
 *     and runs `npm install` upfront, so Claude never touches deps.
 *   - Claude writes `server.ts` + `start.sh` + any helpers. That's it.
 *   - Harness runs `start.sh`, waits for the port, invokes the existing
 *     `bin/adcp.js storyboard run` grader, and reports pass/fail.
 *
 * Requires:
 *   - `claude` CLI on PATH (Claude Code installed).
 *   - This repo built (`npm run build`) so `file:<repo>` resolves.
 *
 * Usage:
 *   tsx scripts/manual-testing/agent-skill-storyboard.ts \
 *     --skill skills/build-seller-agent/SKILL.md \
 *     --storyboard universal/idempotency \
 *     [--port 4200] \
 *     [--work-dir <path>] \
 *     [--timeout-ms 600000] \
 *     [--keep]   # leave the workspace around for post-mortem
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { connect } from 'node:net';

interface Args {
  skill: string;
  storyboard: string;
  port: number;
  workDir?: string;
  timeoutMs: number;
  keep: boolean;
  /** Lifecycle stage. `run` (default) does build → claude → verify in one
   * process — the matrix-driver path. `build` writes the workspace +
   * prompt and (unless `--no-claude`) invokes claude, then exits before
   * the agent ever boots. `verify` requires `--work-dir` pointing at an
   * already-built workspace and runs only `start.sh` → grader → traffic
   * check. Splitting these makes harness iteration cheap: one slow build
   * pass produces a workspace; subsequent verify passes are ~30s each. */
  mode: 'run' | 'build' | 'verify';
  /** Build-mode only: skip the `claude -p` invocation and print the
   * recommended command instead. Use this when running claude yourself
   * top-level (interactive Claude Code session) so you avoid the
   * subprocess/pty quirks of nesting claude inside `tsx`. */
  noClaude: boolean;
  /** When set, skip `npm install` and symlink `node_modules` from this path
   * instead. Matrix driver uses this to amortize the ~15-30s per-workspace
   * install across many pairs — the template's node_modules is valid for
   * every harness run since the deps are fixed (@adcp/sdk + tsx). */
  sharedNodeModules?: string;
  /** When set, capture Claude's full stream-json transcript (thinking,
   * tool calls, partial messages) to this path. Used for diagnostic
   * reruns when a pair times out or fails — lets us read what the LLM
   * was producing when the wall hit. Switches the `claude` invocation
   * to `--output-format stream-json --verbose` and tees stdout to the
   * file (also still inherits to terminal so live watchers see it). */
  transcriptPath?: string;
  /** When set, boot a mock upstream platform of this specialism flavor
   * before handing the workspace to Claude. Claude wraps the upstream as
   * an AdCP agent rather than inventing the platform layer from scratch.
   * Currently supported: `signal-marketplace`, `creative-template`. */
  upstream?: string;
  /** Port for the mock upstream server; defaults to `port + 100`. */
  upstreamPort?: number;
}

const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { port: 4200, timeoutMs: 600_000, keep: false, mode: 'run', noClaude: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skill') out.skill = argv[++i];
    else if (a === '--storyboard') out.storyboard = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--work-dir') out.workDir = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--keep') out.keep = true;
    else if (a === '--shared-node-modules') out.sharedNodeModules = argv[++i];
    else if (a === '--transcript') out.transcriptPath = resolve(argv[++i]);
    else if (a === '--upstream') out.upstream = argv[++i];
    else if (a === '--upstream-port') out.upstreamPort = Number(argv[++i]);
    else if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'run' && m !== 'build' && m !== 'verify') {
        console.error(`--mode must be one of: run, build, verify (got: ${m})`);
        process.exit(2);
      }
      out.mode = m;
    } else if (a === '--no-claude') out.noClaude = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!out.skill || !out.storyboard) {
    printUsage();
    process.exit(2);
  }
  if (out.mode === 'verify' && !out.workDir) {
    console.error(`--mode verify requires --work-dir <path to existing workspace>`);
    process.exit(2);
  }
  return out as Args;
}

function printUsage(): void {
  console.error(
    `Usage: agent-skill-storyboard \\
  --skill <path to SKILL.md> \\
  --storyboard <id, e.g. universal/idempotency> \\
  [--port 4200] \\
  [--work-dir <path>] \\
  [--timeout-ms 600000] \\
  [--keep] \\
  [--shared-node-modules <path>] \\
  [--transcript <path>] \\
  [--upstream <specialism>] \\
  [--upstream-port 4300] \\
  [--mode run|build|verify] \\
  [--no-claude]

Modes:
  run     (default) build workspace, invoke claude, run grader + traffic.
  build   build workspace + prompt, optionally invoke claude, exit.
          Use --no-claude to skip the claude subprocess; the harness will
          print the recommended \`claude -p ...\` command for you to run
          top-level instead.
  verify  --work-dir is mandatory; skip claude and bootstrap, run grader
          + traffic against an already-built workspace.`
  );
}

type UpstreamAuth =
  | { kind: 'static_bearer'; apiKey: string }
  | { kind: 'oauth_client_credentials'; clientId: string; clientSecret: string; tokenPath: string };

function buildPrompt(
  skill: string,
  storyboardId: string,
  port: number,
  skillAbsDir: string,
  upstream?: {
    specialism: string;
    url: string;
    auth: UpstreamAuth;
    openapiPath: string;
    principalScope: string;
    /** AdCP-side principal field name(s) the agent will receive — e.g.
     * `account.advertiser`, `account.operator`. Listed without specific
     * values so the agent can't hardcode the mapping (issue #1225). */
    principalAdcpFields: string[];
  }
): string {
  const authSection = upstream
    ? upstream.auth.kind === 'static_bearer'
      ? `\n- \`Authorization: Bearer ${upstream.auth.apiKey}\` — the customer-level API key`
      : `\n- **OAuth 2.0 client_credentials grant.** Exchange these credentials at the token endpoint, then attach the issued \`access_token\` as Bearer on every API call. Refresh on 401 using \`grant_type=refresh_token\`.\n  - Token endpoint: \`POST ${upstream.url}${upstream.auth.tokenPath}\`\n  - \`client_id: "${upstream.auth.clientId}"\`\n  - \`client_secret: "${upstream.auth.clientSecret}"\``
    : '';
  const upstreamSection = upstream
    ? `

## The upstream platform you're wrapping

You are NOT inventing a decisioning/signal/creative platform from scratch. The adopter brings an existing upstream platform and you are writing the AdCP wrapper around it.

The upstream platform is running locally as a fixture. Treat it exactly as you would the adopter's real platform — call its HTTP API to fetch state and post mutations. **Do NOT mock or stub the upstream calls in your handlers.** Every AdCP handler must execute at least one real HTTP request against the upstream as part of its work; the harness checks endpoint hit-counts after the storyboard run and fails the test if expected upstream calls were skipped (façade detection per adcontextprotocol/adcp-client#1225).

**Base URL**: ${upstream.url}
**OpenAPI spec** (read this first): ${upstream.openapiPath}

**Authentication**:${authSection}
- Per-tenant scope: ${upstream.principalScope}

**Runtime principal resolution.** The AdCP request you receive will carry one or more identifiers (${upstream.principalAdcpFields.map(f => `\`${f}\``).join(', ')}) — domain strings or operator names from the buyer's perspective. You do NOT know what specific values the storyboard will send; you MUST resolve them at runtime by calling the upstream's lookup endpoint:

\`\`\`
GET ${upstream.url}/_lookup/<resource>?<adcp_field>=<value>
\`\`\`

For example, given AdCP \`account.advertiser: <some-domain>\`, your adapter might call \`GET ${upstream.url}/_lookup/advertiser?adcp_advertiser=<some-domain>\` and use the returned upstream id for subsequent calls. Hardcoding a mapping table will not work — the harness uses values your prompt does not contain.

If a buyer's principal value isn't found by the lookup endpoint (404), return an appropriate AdCP error rather than calling upstream with no/wrong tenant scope.
`
    : '';

  return `You are building a minimal AdCP agent that will be graded by the compliance storyboard \`${storyboardId}\`.${upstreamSection}

## The skill you're following

The skill content is inlined below. Some skills reference companion files by relative path (e.g. \`./specialisms/sales-guaranteed.md\`, \`./deployment.md\`) or repo-rooted paths (\`docs/llms.txt\`). When you need to follow those links:
- Skill companion files are under: **${skillAbsDir}**
- Repo root (for \`docs/llms.txt\`, schemas/, etc.) is: **${REPO_ROOT}**

Read them with absolute paths.

${skill}

## Task

The current working directory already has a \`package.json\` with \`@adcp/sdk\` installed via \`npm install\`. Do NOT touch package.json or run npm install — deps are ready.

1. Write \`server.ts\` that:
   - Builds an AdCP server using whichever entry point the skill above prescribes. The two valid choices in v6.0:
     * **\`createAdcpServerFromPlatform\` from \`@adcp/sdk/server\`** — the v6 typed-platform path. Preferred when the skill shows a \`class implements DecisioningPlatform\` example.
     * **\`createAdcpServer\` from \`@adcp/sdk/server/legacy/v5\`** — the v5 escape hatch (handler-bag config). Use this when the skill explicitly imports from \`@adcp/sdk/server/legacy/v5\` (SI agent, brand-rights, etc.) or when no v6 specialism exists for the surface you're building.
     * Do NOT import \`createAdcpServer\` from \`@adcp/sdk\` or \`@adcp/sdk/server\` — it was removed from those paths in v6.0.
   - Implements handlers minimally sufficient to pass \`${storyboardId}\`.
   - If the storyboard grades outbound webhooks, generate an Ed25519 keypair at startup and pass \`webhooks: { signerKey }\` through to the constructor. Call \`ctx.emitWebhook\` on completion.
   - Binds MCP over HTTP on port **${port}** exactly (the harness connects to \`http://127.0.0.1:${port}/mcp\`).
   - Uses \`serve()\` and wires authentication with the harness key below.

**Authentication (non-negotiable, overrides any conflicting guidance from the skill above).** The harness grader authenticates with a static API key. The auth wiring is identical for v5 and v6 paths — pick the matching import path:

\`\`\`ts
// v6 path (createAdcpServerFromPlatform):
import { serve, verifyApiKey } from '@adcp/sdk/server';

// v5 escape hatch (createAdcpServer):
// import { serve, verifyApiKey } from '@adcp/sdk/server/legacy/v5';

serve(() => /* createAdcpServerFromPlatform(platform, opts) OR createAdcpServer(config) */, {
  authenticate: verifyApiKey({
    keys: { 'sk_harness_do_not_use_in_prod': { principal: 'compliance-runner' } },
  }),
});
\`\`\`

The harness grader sends \`Authorization: Bearer sk_harness_do_not_use_in_prod\`. This is the compliance-test equivalent of a registered counterparty with a static API key — it satisfies the universal \`security_baseline\` storyboard (authentication is mandatory) while letting the grader get past auth. Do not copy this key/principal pair into production docs or examples; the scary token name exists to make accidental copy-paste obvious.

2. Write \`start.sh\`:
   \`\`\`bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec npx tsx server.ts
   \`\`\`
   and make it executable (\`chmod +x start.sh\`).

3. **Do NOT run server.ts, start.sh, or npm start yourself — not even to verify.** The harness will run start.sh after you exit and binds port ${port}; if you leave a process running on that port, the harness fails with EADDRINUSE. Trust the SDK — if it compiles, the harness will exercise it. Your only job is to write the files and exit.

4. Typecheck with \`npx tsc --noEmit server.ts\` (optional) to catch compile errors. Do NOT run the server. Exit cleanly when the files are written.

## Constraints

- TypeScript is fine; use \`tsx\` via \`npx tsx\`.
- Port: **${port}** — exact.
- No external network calls beyond what the handler itself generates (webhooks to push_notification_config.url are the only outbound traffic).
- Keep it minimal. This is a conformance test, not a feature demo.
`;
}

async function bootstrapWorkspace(dir: string, port: number, sharedNodeModules?: string): Promise<void> {
  const pkgPath = join(dir, 'package.json');
  const pkg = {
    name: 'adcp-agent-skill-harness-workspace',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'tsx server.ts' },
    dependencies: {
      '@adcp/sdk': `file:${REPO_ROOT}`,
      tsx: '^4.7.0',
    },
  };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // Also drop a README with the port expectation so Claude has it visible
  // in listings without reading the prompt twice.
  await writeFile(
    join(dir, 'README.md'),
    `Port: ${port}\nAgent URL after start.sh: http://127.0.0.1:${port}/mcp\n`,
    'utf8'
  );

  if (sharedNodeModules) {
    // Matrix mode: symlink to a prepared node_modules so we skip the 15-30s
    // `npm install` per pair. The shared dir was built from the same
    // package.json shape above, so resolution is valid.
    log(`linking node_modules from ${sharedNodeModules}`);
    await symlink(sharedNodeModules, join(dir, 'node_modules'), 'dir');
    return;
  }

  log(`bootstrapping deps via npm install (this takes a minute)`);
  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (npm.status !== 0) throw new Error(`npm install failed in ${dir}`);
}

async function runClaude(prompt: string, cwd: string, timeoutMs: number, transcriptPath?: string): Promise<void> {
  log(`invoking claude in ${cwd}`);
  const promptPath = join(cwd, '.harness-prompt.md');
  await writeFile(promptPath, prompt, 'utf8');
  await new Promise<void>((resolveFn, reject) => {
    // `--dangerously-skip-permissions` is required for unattended runs —
    // the alternative is the harness pausing on every tool call.
    //
    // Transcript mode: when `transcriptPath` is set, switch to
    // `--output-format stream-json --verbose --include-partial-messages`
    // and tee Claude's stdout (one JSON event per line) to the file
    // while still inheriting to the terminal so a live watcher can
    // follow along. Used for diagnostic reruns of pairs that timed out
    // in the matrix — lets us read what the LLM was producing when the
    // wall hit.
    const args = [
      '-p',
      `Follow the instructions in ${promptPath}.`,
      '--dangerously-skip-permissions',
      ...(transcriptPath ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : []),
    ];
    const stdio: ('ignore' | 'inherit' | 'pipe')[] = transcriptPath
      ? ['ignore', 'pipe', 'inherit']
      : ['ignore', 'inherit', 'inherit'];
    const p = spawn('claude', args, { cwd, stdio });
    if (transcriptPath && p.stdout) {
      // Tee: write each chunk to the transcript file AND to the parent
      // stdout so the terminal still shows progress live. Append-mode so
      // a single transcriptPath can capture multiple invocations.
      const file = createWriteStream(transcriptPath, { flags: 'a' });
      p.stdout.on('data', chunk => {
        file.write(chunk);
        process.stdout.write(chunk);
      });
      p.on('exit', () => file.end());
    }
    const t = setTimeout(() => {
      p.kill('SIGTERM');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.on('exit', code => {
      clearTimeout(t);
      if (code === 0) resolveFn();
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

async function startAgent(cwd: string, port: number): Promise<ChildProcess> {
  const startSh = join(cwd, 'start.sh');
  const s = await stat(startSh).catch(() => null);
  if (!s) throw new Error(`claude did not produce start.sh in ${cwd}`);
  await chmod(startSh, 0o755);
  // Defense-in-depth: Claude sometimes starts a verification server despite
  // the prompt. Kill anything listening on the target port before we start
  // ours — otherwise bash start.sh crashes EADDRINUSE.
  await killPort(port);
  // `NODE_ENV=development` is mandatory for v6 agents — `createAdcpServerFromPlatform`
  // refuses to mint a default in-memory task registry outside `{test,development}`
  // (see `from-platform.ts:buildDefaultTaskRegistry`). Without this, every v6
  // agent crashes at boot with a TaskRegistry error, `serve()` returns 500
  // from the factory-throw branch, and the grader maps the non-200 to
  // `auth_required` — empirically flagged by matrix v2/v3 where the SI agent
  // (v5 path, no TaskRegistry) passed but every v6 agent reported as auth.
  // `validation: 'strict'` for both sides also matches the harness's intent.
  const child = spawn('bash', [startSh], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  child.on('error', err => log(`[agent] spawn error: ${err.message}`));
  return child;
}

async function killPort(port: number): Promise<void> {
  // Two-stage cleanup. (1) Kill anything `lsof` says is listening — the
  // direct case. (2) Kill any orphaned `npm exec tsx server.ts` whose cwd
  // is a stale `adcp-agent-*` workspace, since those routinely hold
  // harness ports across matrix runs and a parent `pkill` against
  // `compliance:skill-matrix` doesn't propagate to grandchild tsx
  // processes. Without (2), the next matrix pair binds an already-held
  // port → crash at startup → harness's `waitForPort` succeeds against
  // the OLD agent → grader gets misleading 401/timeout from the wrong
  // process. We hit this empirically running v2 of the post-ship matrix.
  // `lsof -ti` + kill -9 is the portable-enough approach on macOS + Linux.
  // On Windows this would be different; the harness is macOS/Linux-only.
  spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  // Stage 2: sweep any zombie tsx running an `adcp-agent-*` workspace.
  // pgrep matches on cmdline; xargs -r is GNU-specific but BSD pgrep on
  // macOS supports `-f` (full cmdline match). The harness is mac+linux-only
  // so we accept the BSD/GNU split here.
  spawnSync('bash', ['-c', `pgrep -f 'tsx.*adcp-agent-[A-Za-z0-9]+' | xargs kill -9 2>/dev/null || true`], {
    stdio: 'ignore',
  });
  // Brief wait so the kernel reaps the socket before we try to bind.
  await new Promise(r => setTimeout(r, 500));
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(r => {
      const s = connect(port, host, () => {
        s.end();
        r(true);
      });
      s.on('error', () => r(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${host}:${port}`);
}

async function runGrader(url: string, storyboardId: string): Promise<{ passed: boolean; raw: string }> {
  const cliPath = join(REPO_ROOT, 'bin', 'adcp.js');
  // Async `spawn` (not `spawnSync`) is mandatory: the harness boots the mock
  // upstream HTTP server in the same Node process. `spawnSync` blocks the
  // event loop, so while the grader runs, the in-process upstream can't
  // respond to requests from the agent — agent's upstream calls hang, grader
  // times out waiting on agent, full deadlock at the 120s mark. Async spawn
  // keeps the loop alive so the upstream serves alongside the grader.
  // (Original symptom thread: #1237 / #1241.)
  //
  // `--allow-http` is mandatory — the grader hard-refuses plain-http URLs
  // otherwise (production agents MUST terminate TLS). Harness-tested agents
  // bind on loopback, so we opt in explicitly. The harness key in `--auth`
  // is symmetric with the `verifyApiKey` block in buildPrompt(); the scary
  // token name makes accidental copy-paste obvious.
  const args = [
    cliPath,
    'storyboard',
    'run',
    url,
    storyboardId,
    '--json',
    '--allow-http',
    '--auth',
    'sk_harness_do_not_use_in_prod',
    // Host a loopback webhook receiver so storyboards that assert outbound
    // webhook conformance (webhook_emission, idempotency) can grade instead
    // of skipping with "Test-kit contract 'webhook_receiver_runner' is not
    // configured on this runner". Storyboards that don't need it ignore the
    // receiver.
    '--webhook-receiver',
  ];

  const child = spawn('node', args, {
    // Close stdin (legacy of #1237 — some library on the CLI side stalled on
    // an open never-written stdin pipe). stdout/stderr piped so we can
    // capture and parse.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', c => stdoutChunks.push(c));
  child.stderr.on('data', c => stderrChunks.push(c));

  let timedOut = false;
  // Wrap in an object so TS doesn't narrow the closure-assigned `let` to
  // `null` at the read site (control-flow analysis can't see across async
  // boundaries on `let` reassignment).
  const spawnFailure: { error: NodeJS.ErrnoException | null } = { error: null };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 120_000);

  // Wire `'error'` (spawn-fail: ENOENT, EACCES, …) and `'close'` (normal
  // exit, after stdio drain) together. Without an `'error'` listener Node
  // throws on emit; without resolving the awaiter on `'error'`, a failed
  // spawn could hang the harness. `'close'` always fires after `'error'`
  // for processes that started, so we settle on whichever comes first.
  const exitCode: number | null = await new Promise<number | null>(resolveFn => {
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolveFn(code);
    };
    child.on('error', err => {
      spawnFailure.error = err;
      settle(null);
    });
    child.on('close', code => settle(code));
  });
  clearTimeout(timer);

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const raw = stdout + stderr + (spawnFailure.error ? `\n[spawn error] ${spawnFailure.error.message}` : '');

  if (spawnFailure.error) {
    log(`grader: spawn failed — ${spawnFailure.error.code ?? '?'}: ${spawnFailure.error.message}`);
  } else if (timedOut) {
    // Reconstruct the direct-invocation command from the actual args array
    // so this hint can't drift from the spawn call above. The operator's
    // recovery loop is `--mode build --keep` then `--mode verify` — flagged
    // here so the hint is actionable without re-reading the file header.
    log(
      `grader: subprocess timed out after 120s (storyboard=${storyboardId}). ` +
        `This is a harness-level kill, not an agent conformance failure. ` +
        `To debug, run the grader directly (workspace must still be up — ` +
        `re-run with --keep + --mode verify if the agent was torn down):\n  ` +
        `node ${args.join(' ')}`
    );
  } else if (exitCode !== 0) {
    log(`grader: exited with code ${exitCode} (storyboard=${storyboardId})`);
  }

  let passed = false;
  try {
    const parsed = JSON.parse(stdout);
    // Pass criteria, in order:
    //   1. `overall_status === 'passing'` — explicit pass from the grader
    //   2. `overall_status === 'partial'` AND zero step/track failures — all
    //      observed assertions passed but the runner classified the track as
    //      'silent' (no specialism-level criteria definitively scored).
    //      Treating this as fail produces false negatives when the agent is
    //      actually conformant (issue #1209).
    //   3. Legacy fallback when overall_status is absent — relies on summary
    //      counts.
    const summary = parsed.summary as
      | { tracks_passed?: number; tracks_failed?: number; steps_passed?: number; steps_failed?: number }
      | undefined;
    const stepsFailed = summary?.steps_failed ?? 0;
    const tracksFailed = summary?.tracks_failed ?? 0;
    if (typeof parsed.overall_status === 'string') {
      if (parsed.overall_status === 'passing') {
        passed = true;
      } else if (parsed.overall_status === 'partial' && stepsFailed === 0 && tracksFailed === 0) {
        passed = true;
        log(`grader returned overall_status=partial with no failed steps/tracks — treating as pass (issue #1209)`);
      } else {
        passed = false;
      }
    } else if (summary) {
      passed = tracksFailed === 0 && (summary.tracks_passed ?? 0) > 0;
    }
  } catch {
    // stdout wasn't clean JSON — the CLI printed an error to stderr and
    // exited non-zero. Treat as fail.
    passed = false;
  }
  return { passed, raw };
}

function log(msg: string): void {
  process.stderr.write(`[harness] ${msg}\n`);
}

interface UpstreamHandle {
  url: string;
  auth: UpstreamAuth;
  openapiPath: string;
  principalScope: string;
  /** AdCP-side principal fields the agent will receive (e.g.
   * `account.advertiser`). The harness no longer leaks specific value
   * mappings to Claude — only the field names. Issue #1225. */
  principalAdcpFields: string[];
  /** Endpoint paths the harness expects to see hit at least once during a
   * storyboard run. After the agent finishes, the harness queries
   * `GET <url>/_debug/traffic` and asserts each of these has count ≥ 1. */
  expectedEndpointHits: string[];
  close: () => Promise<void>;
}

async function bootUpstreamForHarness(specialism: string, port: number): Promise<UpstreamHandle | undefined> {
  // Use the compiled dist/ entry point so the harness doesn't depend on tsx
  // resolution from a child process. Same path the CLI uses. If dist/ is
  // missing (contributor forgot `npm run build`), surface the same friendly
  // hint the CLI gives at bin/adcp.js — `MODULE_NOT_FOUND` straight from
  // require() is unhelpful and makes contributors think the harness is
  // broken instead of just unbuilt.
  let bootMockServer: (opts: { specialism: string; port: number }) => Promise<{
    url: string;
    auth: UpstreamAuth;
    principalScope: string;
    principalMapping: Array<{ adcpField: string }>;
    close: () => Promise<void>;
  }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ bootMockServer } = require(resolve(REPO_ROOT, 'dist/lib/mock-server/index.js')));
  } catch (err) {
    log(
      `mock-server module not found in dist/. Run \`npm run build\` first.\n` +
        `  underlying: ${(err as Error)?.message ?? err}`
    );
    throw new Error(`mock-server (${specialism}) not built; run \`npm run build\``);
  }
  const handle = await bootMockServer({ specialism, port });
  const openapiPath = resolve(REPO_ROOT, `src/lib/mock-server/${specialism}/openapi.yaml`);
  log(`upstream mock-server (${specialism}) up on ${handle.url}`);
  // Distinct AdCP field names from the principal-mapping table (deduped) —
  // no specific values, just the field names the agent will receive.
  const principalAdcpFields = Array.from(new Set(handle.principalMapping.map(m => m.adcpField)));
  return {
    url: handle.url,
    auth: handle.auth,
    openapiPath,
    principalScope: handle.principalScope,
    principalAdcpFields,
    expectedEndpointHits: expectedHitsForSpecialism(specialism),
    close: handle.close,
  };
}

/** Per-specialism list of upstream endpoints the harness expects the agent
 * to call at least once during a storyboard run. Façade adapters that
 * return shape-valid AdCP responses without calling these endpoints fail
 * the post-run traffic assertion. Issue #1225. */
function expectedHitsForSpecialism(specialism: string): string[] {
  switch (specialism) {
    case 'sales-social':
      return [
        'POST /oauth/token',
        'GET /_lookup/advertiser',
        'POST /v1.3/advertiser/{id}/custom_audience/upload',
        'POST /v1.3/advertiser/{id}/event/track',
      ];
    case 'signal-marketplace':
      return ['GET /_lookup/operator', 'GET /v2/cohorts', 'POST /v2/activations'];
    case 'creative-template':
      return ['GET /_lookup/workspace', 'GET /v3/workspaces/{ws}/templates', 'POST /v3/workspaces/{ws}/renders'];
    case 'sales-guaranteed':
      return ['GET /_lookup/network', 'GET /v1/products', 'POST /v1/orders', 'GET /v1/tasks/{id}'];
    default:
      // Other specialisms haven't been instrumented yet — no traffic check.
      return [];
  }
}

/** Default workspace location: `.context/matrix/<slug>-<ts>/` under repo
 * root. We deliberately avoid `os.tmpdir()` because (a) macOS sandboxed
 * tools can't read `/var/folders` so `--keep` is unhelpful for inspection,
 * and (b) `pgrep -f 'adcp-agent-...'` zombie cleanup needs a stable name
 * pattern. Slug includes the skill+storyboard so concurrent matrix workers
 * don't collide and `ls .context/matrix/` is browsable. */
function defaultWorkspaceDir(skill: string, storyboard: string): string {
  const slug = `${basename(dirname(skill))}-${storyboard.replace(/[^A-Za-z0-9]+/g, '-')}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(REPO_ROOT, `.context/matrix/adcp-agent-${slug}-${ts}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillPath = resolve(args.skill);
  const skillContent = await readFile(skillPath, 'utf8');
  const skillDir = dirname(skillPath);
  const workDir = args.workDir ? resolve(args.workDir) : defaultWorkspaceDir(args.skill, args.storyboard);
  await mkdir(workDir, { recursive: true });

  log(`mode: ${args.mode}`);
  log(`workspace: ${workDir}`);
  log(`skill: ${args.skill}`);
  log(`storyboard: ${args.storyboard}`);
  log(`port: ${args.port}`);
  if (args.upstream) log(`upstream: ${args.upstream}`);

  let agent: ChildProcess | undefined;
  let upstream: Awaited<ReturnType<typeof bootUpstreamForHarness>>;
  try {
    if (args.upstream) {
      const upstreamPort = args.upstreamPort ?? args.port + 100;
      upstream = await bootUpstreamForHarness(args.upstream, upstreamPort);
    }

    // Build phase — bootstrap workspace + write prompt + (optionally)
    // invoke claude. Skipped in verify mode.
    if (args.mode !== 'verify') {
      await bootstrapWorkspace(workDir, args.port, args.sharedNodeModules);
      const prompt = buildPrompt(
        skillContent,
        args.storyboard,
        args.port,
        skillDir,
        upstream
          ? {
              specialism: args.upstream!,
              url: upstream.url,
              auth: upstream.auth,
              openapiPath: upstream.openapiPath,
              principalScope: upstream.principalScope,
              principalAdcpFields: upstream.principalAdcpFields,
            }
          : undefined
      );
      const promptPath = join(workDir, '.harness-prompt.md');
      await writeFile(promptPath, prompt, 'utf8');

      if (args.mode === 'build' && args.noClaude) {
        // Print the recommended top-level claude invocation so the
        // operator can run it themselves without nesting claude inside
        // tsx — sidesteps the subprocess-pty quirks that flake the
        // matrix runner.
        process.stdout.write(
          `\nWorkspace ready. Run claude top-level:\n\n` +
            `  cd ${workDir}\n` +
            `  claude -p "Follow the instructions in ${promptPath}." --dangerously-skip-permissions\n\n` +
            `Then verify with:\n\n` +
            `  tsx ${join(REPO_ROOT, 'scripts/manual-testing/agent-skill-storyboard.ts')} \\\n` +
            `    --mode verify --work-dir ${workDir} \\\n` +
            `    --skill ${args.skill} --storyboard ${args.storyboard} \\\n` +
            `    --port ${args.port}` +
            (args.upstream ? ` \\\n    --upstream ${args.upstream}` : '') +
            `\n\n`
        );
      } else {
        await runClaude(prompt, workDir, args.timeoutMs, args.transcriptPath);
      }

      if (args.mode === 'build') {
        log(`build complete; workspace at ${workDir}`);
        process.exit(0);
      }
    }

    // Verify phase — boot the agent, run grader, run traffic check.
    log(`starting agent`);
    agent = await startAgent(workDir, args.port);
    await waitForPort('127.0.0.1', args.port, 30_000);
    log(`agent up on http://127.0.0.1:${args.port}/mcp`);

    const url = `http://127.0.0.1:${args.port}/mcp`;
    log(`grading storyboard ${args.storyboard}`);
    const { passed: storyboardPassed, raw } = await runGrader(url, args.storyboard);
    process.stdout.write(raw);

    // Façade-detection check (issue #1225). Even if the storyboard passes,
    // we assert the agent actually called the upstream's headline endpoints.
    // Adapters that return shape-valid AdCP responses without integrating
    // with the upstream pass the storyboard but fail this check.
    let trafficOk = true;
    if (upstream && upstream.expectedEndpointHits.length > 0) {
      try {
        const trafficRes = await fetch(`${upstream.url}/_debug/traffic`);
        const trafficBody = (await trafficRes.json()) as { traffic: Record<string, number> };
        const missing: string[] = [];
        for (const route of upstream.expectedEndpointHits) {
          const hits = trafficBody.traffic[route] ?? 0;
          if (hits < 1) missing.push(route);
        }
        if (missing.length > 0) {
          trafficOk = false;
          log(`FAÇADE DETECTED — agent passed storyboard shape checks but never called these upstream endpoints:`);
          for (const m of missing) log(`  ✗ ${m}`);
          log(`Full upstream traffic: ${JSON.stringify(trafficBody.traffic, null, 2)}`);
        } else {
          log(`upstream traffic verified — agent called all expected endpoints`);
        }
      } catch (err) {
        log(`upstream traffic check skipped: ${(err as Error)?.message ?? err}`);
      }
    }

    const passed = storyboardPassed && trafficOk;
    log(
      passed
        ? `PASS — storyboard ${args.storyboard} + upstream traffic verified`
        : `FAIL — storyboard=${storyboardPassed ? 'pass' : 'fail'}, traffic=${trafficOk ? 'ok' : 'façade'}`
    );
    process.exit(passed ? 0 : 1);
  } finally {
    if (agent) {
      agent.kill('SIGTERM');
      // Give it 2s to shut down cleanly.
      await new Promise(r => setTimeout(r, 2000));
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    if (upstream) {
      try {
        await upstream.close();
      } catch (err) {
        log(`upstream close error: ${(err as Error)?.message ?? err}`);
      }
    }
    // Don't auto-cleanup verify-mode workspaces (operator owns them) or
    // explicitly --keep workspaces. In run mode, default-named workspaces
    // under `.context/matrix/` are cheap to leave around — `--keep` is
    // now effectively the default. Operator cleans `.context/matrix/`
    // when they want to.
    if (!args.keep && !args.workDir && args.mode === 'run') {
      log(`keeping workspace at ${workDir} (under .context/matrix/; clean manually)`);
    } else {
      log(`keeping workspace at ${workDir}`);
    }
  }
}

main().catch(err => {
  process.stderr.write(`[harness] ${err?.stack ?? err}\n`);
  process.exit(1);
});
