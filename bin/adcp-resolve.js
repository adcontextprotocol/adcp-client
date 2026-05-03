'use strict';

/**
 * `adcp resolve <agent-url>` — runs the brand_json_url discovery chain
 * (security.mdx §"Discovering an agent's signing keys via `brand_json_url`")
 * and prints the trace + resolved chain. Pairs with the SDK's `resolveAgent()`
 * for dev-loop debugging when an operator hits a `request_signature_brand_*`
 * rejection in production and needs to see exactly which step rejected.
 *
 * Flags:
 *   --json     emit machine-readable JSON instead of the default text trace
 *   --fresh    bypass any caches the SDK might add later (no-op today)
 *   --quiet    suppress per-step lines, only print the final summary
 *   --protocol mcp|a2a   default mcp; only used when calling get_adcp_capabilities
 *   --allow-private-ip   permit http:// + private-IP targets (dev only)
 *   --auth-token TOKEN   bearer token for the capabilities call (rare)
 */

const { resolveAgent, AgentResolverError } = require('../dist/lib/signing/server');
const { createMCPClient, createA2AClient } = require('../dist/lib/protocols');

function parseArgs(argv) {
  const opts = { json: false, fresh: false, quiet: false, protocol: 'mcp', allowPrivateIp: false };
  let agentUrl;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fresh') opts.fresh = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--allow-private-ip') opts.allowPrivateIp = true;
    else if (a === '--protocol') {
      opts.protocol = argv[++i];
      if (opts.protocol !== 'mcp' && opts.protocol !== 'a2a') throw new Error(`--protocol must be mcp or a2a`);
    } else if (a === '--auth-token') {
      opts.authToken = argv[++i];
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (!agentUrl) {
      agentUrl = a;
    } else {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
  }
  return { agentUrl, opts };
}

function printHelp() {
  process.stdout.write(`Usage: adcp resolve <agent-url> [--json] [--fresh] [--quiet]
                          [--protocol mcp|a2a] [--allow-private-ip]
                          [--auth-token TOKEN]

Resolve an AdCP agent's signing keys by walking the 8-step brand_json_url
discovery chain (capabilities -> identity.brand_json_url -> brand.json ->
agents[] -> jwks_uri -> JWKS).

Useful for triaging \`request_signature_brand_*\` rejections in production —
prints which step rejected and why.

Flags:
  --json                Emit JSON to stdout instead of the default text trace.
  --fresh               Bypass any SDK-side caches (reserved; no-op today).
  --quiet               Print only the final summary, suppress per-step lines.
  --protocol mcp|a2a    Protocol the agent speaks. Default: mcp.
  --allow-private-ip    Permit http:// and private-IP targets (dev/test only).
  --auth-token TOKEN    Bearer token for the capabilities call (rare).
`);
}

async function handleResolveCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`adcp resolve: ${err.message}\n`);
    process.exit(2);
  }
  if (parsed.opts.help || !parsed.agentUrl) {
    printHelp();
    process.exit(parsed.agentUrl ? 0 : 2);
  }

  const { agentUrl, opts } = parsed;
  const fetchCapabilities = async () => {
    const client =
      opts.protocol === 'a2a' ? createA2AClient(agentUrl, opts.authToken) : createMCPClient(agentUrl, opts.authToken);
    return client.callTool('get_adcp_capabilities', {});
  };

  try {
    const resolution = await resolveAgent(agentUrl, {
      protocol: opts.protocol,
      allowPrivateIp: opts.allowPrivateIp,
      fetchCapabilities,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(serialize(resolution), null, 2) + '\n');
    } else {
      printText(resolution, { quiet: opts.quiet });
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof AgentResolverError) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: false,
              code: err.code,
              message: err.message,
              detail: err.detail,
            },
            null,
            2
          ) + '\n'
        );
      } else {
        process.stderr.write(`✖ ${err.code}\n  ${err.message}\n`);
        for (const [k, v] of Object.entries(err.detail)) {
          process.stderr.write(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
        }
      }
      process.exit(1);
    }
    process.stderr.write(`✖ ${err.message ?? err}\n`);
    process.exit(1);
  }
}

function serialize(resolution) {
  return {
    ok: true,
    agent_url: resolution.agentUrl,
    brand_json_url: resolution.brandJsonUrl,
    jwks_uri: resolution.jwksUri,
    jwks_kids: resolution.jwks.keys.map(k => k.kid),
    identity_posture: resolution.identityPosture,
    consistency: resolution.consistency,
    freshness: resolution.freshness,
    jwks_cache_control: resolution.jwksCacheControl,
    trace: resolution.trace,
  };
}

function printText(resolution, { quiet }) {
  if (!quiet) {
    process.stdout.write(`✓ resolved ${resolution.agentUrl}\n\n`);
    for (const step of resolution.trace) {
      const mark = step.ok ? '✓' : '✗';
      const url = step.url ? ` (${step.url})` : '';
      const age = step.ageSeconds !== undefined ? ` [${step.ageSeconds}s ago]` : '';
      process.stdout.write(`  ${mark} step ${step.step}: ${step.name}${url}${age}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`agent_url:       ${resolution.agentUrl}\n`);
  process.stdout.write(`brand_json_url:  ${resolution.brandJsonUrl}\n`);
  process.stdout.write(`jwks_uri:        ${resolution.jwksUri}\n`);
  process.stdout.write(`kids:            ${resolution.jwks.keys.map(k => k.kid).join(', ')}\n`);
  if (resolution.jwksCacheControl) {
    process.stdout.write(`jwks_cache:      ${resolution.jwksCacheControl}\n`);
  }
}

module.exports = { handleResolveCommand };
