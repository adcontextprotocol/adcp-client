import { createHash, randomBytes } from 'node:crypto';
import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';
import { currentMCPConnectionScopeKey } from './mcp-scope';

/** Local connection ownership; these fields must never be serialized on the wire. */
export interface MCPConnectionPolicy {
  connectionPartition?: string;
  connectionReuse?: 'process';
}

const partitionSalt = randomBytes(32);
const policyStorage = globalAsyncLocalStorage<Readonly<MCPConnectionPolicy> | undefined>('mcpConnectionPolicy');

export function assertMCPConnectionPolicy(policy?: MCPConnectionPolicy): void {
  if (
    policy?.connectionPartition !== undefined &&
    (typeof policy.connectionPartition !== 'string' || policy.connectionPartition.trim().length === 0)
  ) {
    throw new TypeError('transport.connectionPartition must be a nonempty string');
  }
  if (policy?.connectionReuse !== undefined && policy.connectionReuse !== 'process') {
    throw new TypeError('transport.connectionReuse must be "process" when configured');
  }
}

/** Install a detached policy, including an empty one, at each public call boundary. */
export function withMCPConnectionPolicy<T>(policy: MCPConnectionPolicy | undefined, run: () => T): T {
  assertMCPConnectionPolicy(policy);
  return policyStorage.run(
    policy &&
      Object.freeze({
        connectionPartition: policy.connectionPartition,
        connectionReuse: policy.connectionReuse,
      }),
    run
  );
}

/** Opaque process-local partition used only by internal connection and capability keys. */
export function mcpConnectionPartitionKey(partition?: string): string | undefined {
  if (arguments.length === 0) partition = policyStorage.getStore()?.connectionPartition;
  if (partition === undefined) return undefined;
  return createHash('sha256').update(partitionSalt).update(partition).digest('hex');
}

/** Scopes own their sessions; unscoped sharing requires explicit caller identity or opt-in. */
export function shouldReuseMCPConnection(injectedFetch = false): boolean {
  if (currentMCPConnectionScopeKey() !== undefined) return true;
  if (injectedFetch) return false;
  const policy = policyStorage.getStore();
  return policy?.connectionPartition !== undefined || policy?.connectionReuse === 'process';
}
