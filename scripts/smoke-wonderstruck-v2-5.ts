#!/usr/bin/env tsx
/**
 * Smoke test: call the live Wonderstruck v2 sales agent through the SDK
 * with the v2.5 validation surface enabled, and report any drift the
 * post-adapter pass observes via `result.debug_logs`.
 *
 * Read-only: only `get_products` (browse-tier call). No mutating tasks
 * here — those need product sign-off before we hit a real seller.
 *
 * Usage:
 *   npx tsx scripts/smoke-wonderstruck-v2-5.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import { ADCPMultiAgentClient } from '../src/lib';

interface ToolProbe {
  label: string;
  tool: string;
  call: (agent: any) => Promise<any>;
}

function summarizeDrift(result: any): { total: number; warnings: any[] } {
  const debugLogs = (result?.debug_logs as any[] | undefined) ?? [];
  const warnings = debugLogs.filter(
    e => e?.type === 'warning' && /Schema validation warning for /.test(e?.message ?? '')
  );
  return { total: debugLogs.length, warnings };
}

async function probeOne(label: string, fn: () => Promise<any>): Promise<void> {
  console.log(`\n📦 ${label}...`);
  const t0 = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - t0;
    const drift = summarizeDrift(result);
    console.log(`   status=${result.status} success=${result.success} elapsed=${elapsed}ms`);
    if (result.error) {
      // Cap to first line for readability — full error in result.error.
      const errLine = String(result.error).split('\n')[0];
      console.log(`   error: ${errLine}`);
    }
    console.log(`   debug_logs=${drift.total} drift_warnings=${drift.warnings.length}`);
    for (const w of drift.warnings.slice(0, 1)) {
      console.log(`   ⚠️  ${(w.message ?? '').slice(0, 220)}`);
      for (const i of (w.issues ?? []).slice(0, 4)) {
        console.log(`      • ${i.pointer ?? ''}  ${i.keyword ?? ''}  ${i.message ?? ''}`);
      }
    }
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.log(`   ❌ threw after ${elapsed}ms: ${err?.message ?? err}`);
  }
}

async function main(): Promise<void> {
  const client = ADCPMultiAgentClient.fromEnv();
  const wonderstruck = client.getAgentIds().find(id => {
    const agent = client.agent(id).getAgent();
    return /wonderstruck/i.test(agent.name) || /wonderstruck/i.test(agent.agent_uri);
  });
  if (!wonderstruck) {
    throw new Error('Wonderstruck agent not found in SALES_AGENTS_CONFIG. Set the env or pass the URI directly.');
  }
  const agent = client.agent(wonderstruck);
  const cfg = agent.getAgent();
  console.log(`🎯 Target: ${cfg.name} (${cfg.agent_uri})`);

  // Capabilities probe — surfaces what the agent declares (and whether the
  // SDK's detectServerVersion routes us through the v2 adapter path).
  const inner = (agent as any).client;
  const caps = await inner.getCapabilities();
  console.log(`   Detected version: ${caps.version} (majors: ${caps.majorVersions?.join(',')})`);

  // Read-only probes only — no mutating tasks against the live seller.
  await probeOne('get_products (no brand)', () =>
    agent.getProducts({
      brief: 'Premium contextual display inventory',
      buying_mode: 'brief',
    })
  );
  await probeOne('get_products (with v3 brand)', () =>
    agent.getProducts({
      brief: 'Premium contextual display inventory',
      buying_mode: 'brief',
      brand: { domain: 'wonderstruck.fm' },
    })
  );
  await probeOne('list_creative_formats', () => agent.listCreativeFormats({}));
  // list_authorized_properties was replaced by getCapabilities() in v3; the SDK
  // does not expose a high-level method. v2.5 sellers that still serve the
  // underlying tool need executeTask. Probe via the tool name to keep the v2.5
  // surface honest.
  await probeOne('list_authorized_properties (executeTask)', () =>
    (agent as any).client?.executeTask?.('list_authorized_properties', {})
  );
  await probeOne('list_creatives (read-only)', () => (agent as any).listCreatives?.({}));
  await probeOne('get_signals', () => (agent as any).getSignals?.({ description: 'test' }));

  console.log('\nDone.');
}

main().catch(err => {
  console.error('❌ smoke test failed:', err?.message ?? err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
