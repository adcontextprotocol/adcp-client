/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-only tests for the AdcpServer brand. The brand makes the type
// nominal — structurally-similar plain objects must NOT be assignable to
// AdcpServer because they lack the phantom symbol property.
//
// Run with `npm run typecheck`.

import type { AdcpServer } from './adcp-server';

// ── Plain object with same structural shape isn't an AdcpServer ──────────

interface PlainImitation {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchTestRequest(request: unknown): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(options: unknown): Promise<any>;
}

declare const _imitation: PlainImitation;

function _imitationCannotBeAdcpServer(): AdcpServer {
  // @ts-expect-error — PlainImitation lacks the phantom brand symbol.
  return _imitation;
}

// ── (server as AdcpServer).registerTool isn't on the public surface ─────

declare const _server: AdcpServer;

function _registerToolNotOnAdcpServer(): void {
  // @ts-expect-error — registerTool is intentionally not exposed by AdcpServer.
  _server.registerTool('foo', {}, async () => ({ content: [] }));
}

// ── A typed AdcpServer can pass through normal SDK call sites ───────────

async function _adcpServerCallSitesStillWork(s: AdcpServer): Promise<void> {
  await s.close();
  await s.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
}

export const _references = [
  _imitationCannotBeAdcpServer,
  _registerToolNotOnAdcpServer,
  _adcpServerCallSitesStillWork,
] as const;
