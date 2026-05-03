/**
 * hello-cluster — boot every hello-* adapter on its declared port and emit
 * a routing manifest the storyboard runner (#1066) can consume.
 *
 * Run:
 *   npx @adcp/sdk@latest mock-server signal-marketplace --port 4150 &
 *   npm run hello-cluster
 *   # → prints YAML manifest, stays alive until SIGINT
 *
 * Pipe the manifest into the storyboard runner once #1066 lands:
 *   npm run hello-cluster --silent > /tmp/agents.yaml
 *   adcp storyboard run --agents-map /tmp/agents.yaml signal_marketplace/...
 *
 * Adapters whose entrypoint file does not yet exist are skipped and listed
 * in a structured `pending:` block at the bottom of the manifest. Drop the
 * file in at the documented path and the cluster picks it up next run.
 *
 * Before booting, the cluster preflights each adapter's upstream backend
 * (the env var declared on AdapterConfig.upstream) and exits non-zero with
 * a copy-pasteable hint when the upstream isn't reachable — so first-run
 * adopters get "run mock-server first" instead of a confusing storyboard
 * failure on first tool call.
 *
 * Set `HELLO_CLUSTER_PORT_BASE=40000` to shift every adapter into the
 * 43001–43006 range — useful when running multiple clusters or when 3001
 * is busy.
 *
 * Out of scope: TLS termination, production process supervision, booting
 * the upstream mock-server (we PROBE it, but adopters start it themselves).
 * Adopters wanting the full stack run docker-compose or foreman; this
 * script is the minimal one-command demo.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface AdapterConfig {
  /** Manifest key — what storyboards reference (`task: get_signals` → `signals`). */
  name: string;
  /** AdCP specialism the adapter claims, surfaced in the manifest comment. */
  specialism: string;
  /** Port the adapter binds; reserved range 3001–3006. */
  port: number;
  /** Path to the adapter source, relative to repo root. Skipped if missing. */
  entrypoint: string;
  /** GitHub issue tracking the entrypoint's creation. */
  tracking?: string;
  /** Upstream platform the adapter proxies. Set when the adapter calls a
   *  mock-server / upstream backend that must be reachable BEFORE the
   *  cluster declares readiness — otherwise the cluster reports "ready"
   *  while storyboards fail with cryptic ECONNREFUSED on first tool call. */
  upstream?: {
    /** Env var read by the adapter to find its upstream (matches the var
     *  the adapter's source file consults — e.g. `UPSTREAM_URL`). */
    envVar: string;
    /** Default URL when the env var is unset (mirrors the adapter's default). */
    defaultUrl: string;
    /** GET path used to probe reachability. Should respond 2xx/4xx (any
     *  HTTP response proves the listener is up); 5xx or network refusal fail. */
    probePath: string;
  };
}

const HARNESS_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
/**
 * Shifts every adapter's listen port. Default 0 (use the canonical
 * 3001–3006 range). Override when running multiple clusters on the same
 * host or to dodge stale processes from sibling workspaces.
 */
const PORT_BASE = Number(process.env['HELLO_CLUSTER_PORT_BASE'] ?? 0);
const HEALTH_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 3_000;
const REPO_ROOT = resolvePath(__dirname, '..');

/** Every mock-server exposes auth-free `GET /_debug/traffic` returning a
 *  JSON object — used as the universal liveness probe across the cluster.
 *  Matches what the mock-servers ship today; if a future mock drops this
 *  surface, swap to a specialism-specific lookup path here. */
const UNIVERSAL_PROBE_PATH = '/_debug/traffic';

const ADAPTERS: AdapterConfig[] = [
  {
    name: 'signals',
    specialism: 'signal-marketplace',
    port: 3001,
    entrypoint: 'examples/hello_signals_adapter_marketplace.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4150', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'creative-template',
    specialism: 'creative-template',
    port: 3002,
    entrypoint: 'examples/hello_creative_adapter_template.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4250', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'sales-social',
    specialism: 'sales-social',
    port: 3003,
    entrypoint: 'examples/hello_seller_adapter_social.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4350', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'sales-guaranteed',
    specialism: 'sales-guaranteed',
    port: 3004,
    entrypoint: 'examples/hello_seller_adapter_guaranteed.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4450', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'sales-non-guaranteed',
    specialism: 'sales-non-guaranteed',
    port: 3005,
    entrypoint: 'examples/hello_seller_adapter_non_guaranteed.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4451', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'creative-ad-server',
    specialism: 'creative-ad-server',
    port: 3006,
    entrypoint: 'examples/hello_creative_adapter_ad_server.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4452', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    name: 'sponsored-intelligence',
    specialism: 'sponsored-intelligence',
    port: 3007,
    entrypoint: 'examples/hello_si_adapter_brand.ts',
    upstream: { envVar: 'UPSTREAM_URL', defaultUrl: 'http://127.0.0.1:4504', probePath: UNIVERSAL_PROBE_PATH },
  },
  {
    // The multi-tenant adapter claims governance-spend-authority +
    // property-lists + brand-rights against in-memory state — no upstream
    // mock to probe. Useful as the agency / holdco worked example.
    name: 'multi-tenant',
    specialism: 'governance-spend-authority+property-lists+brand-rights',
    port: 3008,
    entrypoint: 'examples/hello_seller_adapter_multi_tenant.ts',
  },
  // ─── Pending-tracking entries — auto-skip until the example file lands.
  // The `pending:` block in the manifest surfaces them so adopters know
  // what's coming.
  {
    name: 'governance',
    specialism: 'governance-spend-authority',
    port: 3010,
    entrypoint: 'examples/hello_governance_adapter_spend_authority.ts',
    tracking: '#1332',
  },
  {
    name: 'brand-rights',
    specialism: 'brand-rights',
    port: 3011,
    entrypoint: 'examples/hello_brand_adapter_rights.ts',
    tracking: '#1334',
  },
  {
    // `sales-retail-media` is a preview specialism in 3.0 — claiming it
    // advertises intent; no storyboard backs it yet.
    name: 'retail-media',
    specialism: 'sales-retail-media',
    port: 3012,
    entrypoint: 'examples/hello_seller_adapter_retail_media.ts',
  },
];

const STDERR_TAIL_LINES = 10;

interface BootedAdapter {
  config: AdapterConfig;
  child: ChildProcess;
  /** Last few lines of child stderr — replayed on health-check failure so
   *  adopters see WHY the child didn't come up, not just "fetch failed". */
  stderrTail: string[];
}

let tearingDown = false;

/** Everything goes to stderr so stdout stays clean for the manifest
 *  (the run instructions pipe stdout to a YAML file). */
function logPrefixed(name: string, line: string): void {
  if (line.length === 0) return;
  process.stderr.write(`[${name}] ${line}\n`);
}

function attachLogger(b: BootedAdapter, stream: 'stdout' | 'stderr', src: NodeJS.ReadableStream | null): void {
  src?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      logPrefixed(b.config.name, line);
      if (stream === 'stderr' && line.length > 0) {
        b.stderrTail.push(line);
        if (b.stderrTail.length > STDERR_TAIL_LINES) b.stderrTail.shift();
      }
    }
  });
}

function portFor(config: AdapterConfig): number {
  return config.port + PORT_BASE;
}

interface UpstreamCheck {
  config: AdapterConfig;
  url: string;
}

/** Resolve the upstream base URL, treating empty-string env as unset. */
function resolveUpstreamBase(upstream: NonNullable<AdapterConfig['upstream']>): {
  base: string;
  userOverride: boolean;
} {
  const raw = process.env[upstream.envVar];
  if (raw && raw.length > 0) return { base: raw, userOverride: true };
  return { base: upstream.defaultUrl, userOverride: false };
}

async function preflightUpstreams(present: AdapterConfig[]): Promise<void> {
  // Probe every distinct upstream URL once. Adapters share an upstream when
  // they read the same env var with the same value, so we dedupe by URL.
  const checks = new Map<string, UpstreamCheck>();
  for (const c of present) {
    if (!c.upstream) continue;
    const { base } = resolveUpstreamBase(c.upstream);
    const url = base + c.upstream.probePath;
    if (!checks.has(url)) checks.set(url, { config: c, url });
  }
  if (checks.size === 0) return;

  const failures: string[] = [];
  await Promise.all(
    Array.from(checks.values()).map(async ({ config, url }) => {
      const upstream = config.upstream;
      if (!upstream) return;
      const { base, userOverride } = resolveUpstreamBase(upstream);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_500);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        // Any HTTP response (incl. 4xx) means the listener is up; 5xx is iffy
        // but still proves a reachable process. Network failure / abort is the
        // only thing we treat as fatal.
        if (res.status >= 500) failures.push(`${config.name}: upstream at ${base} returned HTTP ${res.status}`);
      } catch (err) {
        // Suppress the mock-server hint when the user has explicitly pointed
        // at a non-default upstream — they're clearly not running mock-server,
        // and suggesting an unrelated port number is more confusing than
        // helpful.
        let hint: string;
        if (userOverride) {
          hint = `set ${upstream.envVar} to a reachable URL or start the upstream service`;
        } else {
          const port = new URL(base).port || '4150';
          hint = `run 'npx @adcp/sdk@latest mock-server ${config.specialism} --port ${port}' first, or set ${upstream.envVar} to your real backend`;
        }
        failures.push(`${config.name}: upstream not reachable at ${base} (${String(err)}) — ${hint}`);
      } finally {
        clearTimeout(t);
      }
    })
  );

  if (failures.length > 0) {
    process.stderr.write('hello-cluster: upstream preflight failed:\n');
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    process.exit(1);
  }
}

function bootAdapter(config: AdapterConfig): BootedAdapter {
  const abs = resolvePath(REPO_ROOT, config.entrypoint);
  const child = spawn('npx', ['tsx', abs], {
    env: {
      // hello adapters use createInMemoryTaskRegistry by default, which
      // refuses to boot under NODE_ENV=production. The cluster is a
      // local-dev / CI demo, so default to development unless the caller
      // explicitly overrode (e.g. NODE_ENV=test inside CI).
      NODE_ENV: process.env['NODE_ENV'] ?? 'development',
      ...process.env,
      PORT: String(portFor(config)),
      ADCP_AUTH_TOKEN: HARNESS_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const booted: BootedAdapter = { config, child, stderrTail: [] };
  attachLogger(booted, 'stdout', child.stdout);
  attachLogger(booted, 'stderr', child.stderr);
  return booted;
}

async function healthCheck(b: BootedAdapter, deadline: number): Promise<void> {
  const port = portFor(b.config);
  const url = `http://127.0.0.1:${port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'hello-cluster-health', method: 'tools/list' });
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (b.child.exitCode !== null) {
      throw new Error(
        `${b.config.name} died during boot (exit ${b.child.exitCode}) — last stderr:\n${b.stderrTail.join('\n')}`
      );
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${HARNESS_TOKEN}`,
        },
        body,
      });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(100);
  }
  const tail =
    b.stderrTail.length > 0 ? `\n  last stderr from [${b.config.name}]:\n  ${b.stderrTail.join('\n  ')}` : '';
  throw new Error(`health check failed for ${b.config.name} on :${port} — ${String(lastErr)}${tail}`);
}

function emitManifest(booted: BootedAdapter[], pending: AdapterConfig[]): void {
  const lines: string[] = [];
  lines.push('# Routing manifest for the storyboard runner (#1066).');
  lines.push('# Each agent key (signals / sales / …) is the routing discriminator');
  lines.push('# storyboards reference in step.agent; the runner resolves it to `url`.');
  lines.push('# Specialisms are discovered via per-agent get_adcp_capabilities at run');
  lines.push('# start; the `specialism` field below is documentation only.');
  lines.push('');
  // Only emit `default_agent` when its target actually booted. Fall back to
  // the first booted adapter alphabetically — but if `sales` was expected
  // and is pending, omit the key so storyboards expecting `sales` fail
  // loudly instead of silently retargeting.
  const sales = booted.find(b => b.config.name === 'sales');
  const salesPending = pending.some(p => p.name === 'sales');
  const fallback = booted[0];
  if (sales) {
    lines.push(`default_agent: ${sales.config.name}`);
  } else if (!salesPending && fallback) {
    lines.push(`default_agent: ${fallback.config.name}`);
  } else {
    lines.push("# default_agent omitted: 'sales' adapter is pending. Storyboards");
    lines.push('# expecting a default must specify step.agent explicitly until it lands.');
  }
  lines.push('agents:');
  for (const b of booted) {
    lines.push(`  ${b.config.name}:`);
    lines.push(`    url: http://127.0.0.1:${portFor(b.config)}/mcp`);
    lines.push(`    specialism: ${b.config.specialism}`);
    lines.push(`    auth: { type: bearer, token: ${HARNESS_TOKEN} }`);
  }
  // Structured pending list — a top-level sibling of `agents`, ignored by
  // the runner (it only reads `parsed.agents`) but consumable by tooling
  // that wants to surface "agent X expected but not present, see <issue>".
  if (pending.length > 0) {
    lines.push('pending:');
    for (const p of pending) {
      lines.push(`  - name: ${p.name}`);
      lines.push(`    specialism: ${p.specialism}`);
      lines.push(`    entrypoint: ${p.entrypoint}`);
      if (p.tracking) lines.push(`    tracking: '${p.tracking}'`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function reap(booted: BootedAdapter[]): Promise<void> {
  return new Promise(resolveReap => {
    let remaining = booted.length;
    if (remaining === 0) return resolveReap();
    const onExit = (): void => {
      remaining -= 1;
      if (remaining === 0) resolveReap();
    };
    for (const b of booted) {
      if (b.child.exitCode !== null) {
        onExit();
        continue;
      }
      b.child.once('exit', onExit);
      b.child.kill('SIGTERM');
    }
    setTimeout(() => {
      for (const b of booted) {
        if (b.child.exitCode === null) b.child.kill('SIGKILL');
      }
    }, SHUTDOWN_GRACE_MS).unref();
  });
}

async function teardownAndExit(booted: BootedAdapter[], code: number, msg: string): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  process.stderr.write(`hello-cluster: ${msg}\n`);
  await reap(booted);
  process.exit(code);
}

async function main(): Promise<void> {
  // Defense in depth — the cluster is a local-dev/CI demo. Refuse to boot
  // under a production parent so an LLM scaffolding from this file or an
  // adopter copy-pasting into staging can't accidentally rewrite the
  // child's NODE_ENV to 'development' on a real deployment.
  if (process.env['NODE_ENV'] === 'production' && process.env['HELLO_CLUSTER_I_KNOW_NOT_PROD'] !== '1') {
    process.stderr.write(
      'hello-cluster: refusing to boot under NODE_ENV=production — this script is for local dev / CI ' +
        'and rewrites NODE_ENV=development for spawned children. Set NODE_ENV=development|test (preferred) ' +
        'or HELLO_CLUSTER_I_KNOW_NOT_PROD=1 to override explicitly.\n'
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const present = ADAPTERS.filter(a => existsSync(resolvePath(REPO_ROOT, a.entrypoint)));
  const pending = ADAPTERS.filter(a => !existsSync(resolvePath(REPO_ROOT, a.entrypoint)));

  if (present.length === 0) {
    process.stderr.write('hello-cluster: no adapter entrypoints found — nothing to boot\n');
    process.exit(1);
  }

  // Probe every adapter's upstream BEFORE spawning. The adapters bind their
  // own listener regardless of upstream reachability, so a missing mock
  // would surface only later as a confusing storyboard failure on first
  // tool call. Catching it here turns "30-min head-scratch" into "exit 1
  // with a copy-pasteable command."
  await preflightUpstreams(present);

  const booted: BootedAdapter[] = present.map(config => bootAdapter(config));

  process.once('SIGINT', () => void teardownAndExit(booted, 0, 'received SIGINT, reaping adapters'));
  process.once('SIGTERM', () => void teardownAndExit(booted, 0, 'received SIGTERM, reaping adapters'));

  // Surface child crashes. The teardown guard ensures one crash doesn't
  // cascade-trigger N independent reap cycles when sibling exit handlers
  // fire during the first reap.
  for (const b of booted) {
    b.child.once('exit', code => {
      if (code === 0 || tearingDown) return;
      const tail = b.stderrTail.length > 0 ? `\n  last stderr:\n  ${b.stderrTail.join('\n  ')}` : '';
      void teardownAndExit(booted, 1, `${b.config.name} exited with code ${code}${tail}`);
    });
  }

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  try {
    await Promise.all(booted.map(b => healthCheck(b, deadline)));
  } catch (err) {
    await teardownAndExit(booted, 1, String(err));
    return;
  }

  emitManifest(booted, pending);
  process.stderr.write(`hello-cluster: ${booted.length} adapter(s) ready in ${Date.now() - t0}ms · Ctrl+C to stop\n`);
}

void main();
