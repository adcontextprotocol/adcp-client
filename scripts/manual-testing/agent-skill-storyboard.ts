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
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';

interface Args {
  skill: string;
  storyboard: string;
  port: number;
  workDir?: string;
  timeoutMs: number;
  keep: boolean;
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
   * Currently supported: `signal-marketplace`. */
  upstream?: string;
  /** Port for the mock upstream server; defaults to `port + 100`. */
  upstreamPort?: number;
}

const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { port: 4200, timeoutMs: 600_000, keep: false };
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
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!out.skill || !out.storyboard) {
    printUsage();
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
  [--upstream-port 4300]`
  );
}

function buildPrompt(
  skill: string,
  storyboardId: string,
  port: number,
  skillAbsDir: string,
  upstream?: { specialism: string; url: string; apiKey: string; openapiPath: string; operatorMapping: Array<{ adcp_operator: string; upstream_operator_id: string }> }
): string {
  const upstreamSection = upstream
    ? `

## The upstream platform you're wrapping

You are NOT inventing a decisioning/signal platform from scratch. The adopter brings an existing upstream platform and you are writing the AdCP wrapper around it.

The upstream platform is running locally as a fixture. Treat it exactly as you would the adopter's real platform — call its HTTP API to fetch state and post mutations.

**Base URL**: ${upstream.url}
**OpenAPI spec** (read this first): ${upstream.openapiPath}

**Authentication** (every outbound request must carry both):
- \`Authorization: Bearer ${upstream.apiKey}\` — the customer-level API key
- \`X-Operator-Id: <upstream operator id>\` — the operator seat. Different operators see different cohorts/destinations and have different rate cards. **Omitting this header returns 403.**

**Operator mapping**: the AdCP request you receive will carry \`account.operator: "<adcp-operator>"\`. You must translate that to the upstream operator id when calling the upstream API:

${upstream.operatorMapping.map(m => `- AdCP \`account.operator: "${m.adcp_operator}"\`  →  upstream \`X-Operator-Id: ${m.upstream_operator_id}\``).join('\n')}

The mapping table above is fixed seed data for this fixture; in production this would be a config file or DB lookup. Hard-code it for the test (a Map literal in your adapter is fine).

If a buyer's \`account.operator\` value isn't in your mapping, return an appropriate AdCP error rather than calling upstream with no/wrong operator.
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

function runGrader(url: string, storyboardId: string): { passed: boolean; raw: string } {
  const cliPath = join(REPO_ROOT, 'bin', 'adcp.js');
  // `--allow-http` is mandatory — the grader hard-refuses plain-http URLs
  // otherwise (production agents MUST terminate TLS). Harness-tested agents
  // bind on loopback, so we opt in explicitly.
  // Presents the harness key wired by the generated server — symmetric with
  // the `verifyApiKey` block in buildPrompt(). The scary token name exists so
  // anyone who encounters it in logs or --keep output workspaces recognizes
  // it's a harness-only credential, not a production pattern.
  const res = spawnSync(
    'node',
    [
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
    ],
    {
      encoding: 'utf8',
      timeout: 120_000,
    }
  );
  const raw = (res.stdout ?? '') + (res.stderr ?? '');
  let passed = false;
  try {
    const parsed = JSON.parse(res.stdout);
    if (typeof parsed.overall_status === 'string') {
      passed = parsed.overall_status === 'passing';
    } else if (parsed.summary && typeof parsed.summary === 'object') {
      const s = parsed.summary as { tracks_passed?: number; tracks_failed?: number };
      passed = (s.tracks_failed ?? 0) === 0 && (s.tracks_passed ?? 0) > 0;
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

async function bootUpstreamForHarness(
  specialism: string,
  port: number
): Promise<{
  url: string;
  apiKey: string;
  openapiPath: string;
  operatorMapping: Array<{ adcp_operator: string; upstream_operator_id: string }>;
  close: () => Promise<void>;
} | undefined> {
  // Use the compiled dist/ entry point so the harness doesn't depend on tsx
  // resolution from a child process. Same path the CLI uses.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { bootMockServer } = require(resolve(REPO_ROOT, 'dist/lib/mock-server/index.js')) as {
    bootMockServer: (opts: { specialism: string; port: number }) => Promise<{
      url: string;
      apiKey: string;
      close: () => Promise<void>;
    }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const seed = require(resolve(REPO_ROOT, `dist/lib/mock-server/${specialism}/seed-data.js`)) as {
    OPERATORS: Array<{ adcp_operator: string; operator_id: string }>;
  };
  const handle = await bootMockServer({ specialism, port });
  const openapiPath = resolve(REPO_ROOT, `src/lib/mock-server/${specialism}/openapi.yaml`);
  const operatorMapping = seed.OPERATORS.map(op => ({
    adcp_operator: op.adcp_operator,
    upstream_operator_id: op.operator_id,
  }));
  log(`upstream mock-server (${specialism}) up on ${handle.url}`);
  return {
    url: handle.url,
    apiKey: handle.apiKey,
    openapiPath,
    operatorMapping,
    close: handle.close,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillPath = resolve(args.skill);
  const skillContent = await readFile(skillPath, 'utf8');
  const skillDir = dirname(skillPath);
  const workDir = args.workDir ? resolve(args.workDir) : await mkdtemp(join(tmpdir(), 'adcp-agent-'));

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
    await bootstrapWorkspace(workDir, args.port, args.sharedNodeModules);
    await runClaude(
      buildPrompt(
        skillContent,
        args.storyboard,
        args.port,
        skillDir,
        upstream
          ? {
              specialism: args.upstream!,
              url: upstream.url,
              apiKey: upstream.apiKey,
              openapiPath: upstream.openapiPath,
              operatorMapping: upstream.operatorMapping,
            }
          : undefined
      ),
      workDir,
      args.timeoutMs,
      args.transcriptPath
    );

    log(`starting agent`);
    agent = await startAgent(workDir, args.port);
    await waitForPort('127.0.0.1', args.port, 30_000);
    log(`agent up on http://127.0.0.1:${args.port}/mcp`);

    const url = `http://127.0.0.1:${args.port}/mcp`;
    log(`grading storyboard ${args.storyboard}`);
    const { passed, raw } = runGrader(url, args.storyboard);
    process.stdout.write(raw);
    log(passed ? `PASS — storyboard ${args.storyboard}` : `FAIL — storyboard ${args.storyboard}`);
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
    if (!args.keep && !args.workDir) {
      await rm(workDir, { recursive: true, force: true });
    } else {
      log(`keeping workspace at ${workDir}`);
    }
  }
}

main().catch(err => {
  process.stderr.write(`[harness] ${err?.stack ?? err}\n`);
  process.exit(1);
});
