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
 *   - Harness pre-populates `package.json` with `"@adcp/client": "file:<repo>"`
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
import { mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';

interface Args {
  skill: string;
  storyboard: string;
  port: number;
  workDir?: string;
  timeoutMs: number;
  keep: boolean;
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
  [--keep]`
  );
}

function buildPrompt(skill: string, storyboardId: string, port: number): string {
  return `You are building a minimal AdCP agent that will be graded by the compliance storyboard \`${storyboardId}\`.

## The skill you're following

${skill}

## Task

The current working directory already has a \`package.json\` with \`@adcp/client\` installed via \`npm install\`. Do NOT touch package.json or run npm install — deps are ready.

1. Write \`server.ts\` that:
   - Uses \`createAdcpServer\` from \`@adcp/client/server\`.
   - Implements handlers minimally sufficient to pass \`${storyboardId}\`.
   - If the storyboard grades outbound webhooks, generate an Ed25519 keypair at startup and pass \`webhooks: { signerKey }\` to \`createAdcpServer\`. Call \`ctx.emitWebhook\` on completion.
   - Binds MCP over HTTP on port **${port}** exactly (the harness connects to \`http://127.0.0.1:${port}/mcp\`).
   - Uses \`serve()\` from \`@adcp/client/server\` and wires authentication via:
     \`\`\`ts
     import { verifyApiKey } from '@adcp/client/server';
     serve(createAgent, {
       authenticate: verifyApiKey({
         keys: { 'compliance-runner': { principal: 'compliance-runner' } },
       }),
     });
     \`\`\`
     The harness grader sends \`Authorization: Bearer compliance-runner\`. This is the compliance-test equivalent of a registered counterparty with a static API key — it satisfies the universal \`security_baseline\` storyboard (authentication is mandatory) while letting the grader get past auth.

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

async function bootstrapWorkspace(dir: string, port: number): Promise<void> {
  const pkgPath = join(dir, 'package.json');
  const pkg = {
    name: 'adcp-agent-skill-harness-workspace',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'tsx server.ts' },
    dependencies: {
      '@adcp/client': `file:${REPO_ROOT}`,
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

  log(`bootstrapping deps via npm install (this takes a minute)`);
  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (npm.status !== 0) throw new Error(`npm install failed in ${dir}`);
}

async function runClaude(prompt: string, cwd: string, timeoutMs: number): Promise<void> {
  log(`invoking claude in ${cwd}`);
  const promptPath = join(cwd, '.harness-prompt.md');
  await writeFile(promptPath, prompt, 'utf8');
  await new Promise<void>((resolveFn, reject) => {
    // `--dangerously-skip-permissions` is required for unattended runs —
    // the alternative is the harness pausing on every tool call.
    const p = spawn('claude', ['-p', `Follow the instructions in ${promptPath}.`, '--dangerously-skip-permissions'], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
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
  const child = spawn('bash', [startSh], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', err => log(`[agent] spawn error: ${err.message}`));
  return child;
}

async function killPort(port: number): Promise<void> {
  // `lsof -ti` + kill -9 is the portable-enough approach on macOS + Linux.
  // On Windows this would be different; the harness is macOS/Linux-only.
  const res = spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  void res;
  // Brief wait so the kernel reaps the socket before we try to bind.
  await new Promise(r => setTimeout(r, 300));
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
  // The prompt instructs Claude to wire `verifyApiKey` with a static key of
  // `compliance-runner`, so the grader presents that key here. Keeping the
  // key/principal symmetrical lets the universal `security_baseline` probe
  // see auth wired AND lets the specialism storyboards run authenticated.
  const res = spawnSync(
    'node',
    [cliPath, 'storyboard', 'run', url, storyboardId, '--json', '--allow-http', '--auth', 'compliance-runner'],
    {
      encoding: 'utf8',
      timeout: 120_000,
    }
  );
  const raw = (res.stdout ?? '') + (res.stderr ?? '');
  let passed = false;
  try {
    const parsed = JSON.parse(res.stdout);
    if (typeof parsed.overall_passed === 'boolean') {
      passed = parsed.overall_passed;
    } else if (Array.isArray(parsed.results)) {
      passed = parsed.results.every((r: { overall_passed?: boolean }) => r.overall_passed);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillContent = await readFile(resolve(args.skill), 'utf8');
  const workDir = args.workDir ? resolve(args.workDir) : await mkdtemp(join(tmpdir(), 'adcp-agent-'));

  log(`workspace: ${workDir}`);
  log(`skill: ${args.skill}`);
  log(`storyboard: ${args.storyboard}`);
  log(`port: ${args.port}`);

  let agent: ChildProcess | undefined;
  try {
    await bootstrapWorkspace(workDir, args.port);
    await runClaude(buildPrompt(skillContent, args.storyboard, args.port), workDir, args.timeoutMs);

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
