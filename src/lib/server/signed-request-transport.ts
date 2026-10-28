import type { AdcpPreTransport } from './create-adcp-server';

// Share the state when CJS-created servers are passed to ESM adapters (or vice versa).
const GUARD = Symbol.for('@adcp/client.signedRequestTransportGuard');
interface Guard {
  preTransport: AdcpPreTransport;
  transports: WeakSet<object>;
}

function guardFor(server: object): Guard | undefined {
  return (server as Record<symbol, Guard | undefined>)[GUARD];
}

/** @internal Framework lookups must not acknowledge a custom host's middleware. */
export function registerSignedRequestTransportGuard(
  server: object,
  preTransport: AdcpPreTransport
): (transport: object) => boolean {
  const entry = { preTransport, transports: new WeakSet<object>() };
  Object.defineProperty(server, GUARD, { value: entry });
  return transport => entry.transports.has(transport);
}

/** @internal Read the verifier without granting permission to connect over MCP. */
export function getSignedRequestPreTransport(server: object): AdcpPreTransport | undefined {
  return guardFor(server)?.preTransport;
}

/** @internal Called by serve() after HTTP middleware has accepted this request. */
export function permitSignedRequestTransport(server: object, transport: object): void {
  guardFor(server)?.transports.add(transport);
}
