import { AsyncLocalStorage } from 'node:async_hooks';

type ScopeCleanup = () => Promise<void>;

interface MCPConnectionScope {
  id: number;
  cacheKey: string;
  pending: Set<Promise<unknown>>;
  cleanups: Map<string, ScopeCleanup>;
}

const scopeStorage = new AsyncLocalStorage<MCPConnectionScope>();
const activeScopeKeys = new Set<string>();
let nextScopeId = 0;

/** Cache-key suffix for the current caller-owned MCP workflow. */
export function currentMCPConnectionScopeKey(): string | undefined {
  return scopeStorage.getStore()?.cacheKey;
}

/** Whether an LRU entry belongs to a workflow that has not finished yet. */
export function isMCPConnectionScopeCacheKeyActive(cacheKey: string): boolean {
  const marker = cacheKey.lastIndexOf('::scope:');
  return marker >= 0 && activeScopeKeys.has(cacheKey.slice(marker + 2));
}

/** Register one idempotent cache-entry cleanup with the current workflow. */
export function registerMCPConnectionScopeCleanup(
  namespace: 'legacy' | 'oauth' | 'modern',
  cacheKey: string,
  cleanup: ScopeCleanup
): void {
  scopeStorage.getStore()?.cleanups.set(`${namespace}\u0000${cacheKey}`, cleanup);
}

/** Track initialization that may outlive the task which started it. */
export function registerMCPConnectionScopePending(pending: Promise<unknown>): void {
  const scope = scopeStorage.getStore();
  if (!scope) return;
  scope.pending.add(pending);
  const remove = () => scope.pending.delete(pending);
  void pending.then(remove, remove);
}

/** Close only connections owned by the current workflow, if one exists. */
export async function closeCurrentMCPConnectionScope(): Promise<boolean> {
  const scope = scopeStorage.getStore();
  if (!scope) return false;

  // A timed-out parallel branch may still be initializing after the runner's
  // result path starts to unwind. Wait for those connects to either register
  // their cleanup or reject before taking the cleanup snapshot.
  while (scope.pending.size > 0) {
    await Promise.allSettled([...scope.pending]);
  }

  // Clear before awaiting so an early close followed by another tool call in
  // the same workflow can register a fresh connection for the outer finally.
  const cleanups = [...scope.cleanups.values()];
  scope.cleanups.clear();
  await Promise.allSettled(cleanups.map(cleanup => cleanup()));
  return true;
}

/**
 * Isolate connection reuse to one runner/workflow and close it on every exit.
 * Nested callers join the existing scope so a storyboard still gets exactly
 * one reusable session rather than one session per helper layer.
 */
export async function withMCPConnectionScope<T>(fn: () => Promise<T>, options: { isolate?: boolean } = {}): Promise<T> {
  if (scopeStorage.getStore() && options.isolate !== true) return fn();

  const id = ++nextScopeId;
  const scope: MCPConnectionScope = { id, cacheKey: `scope:${id}`, pending: new Set(), cleanups: new Map() };
  activeScopeKeys.add(scope.cacheKey);
  return scopeStorage.run(scope, async () => {
    try {
      return await fn();
    } finally {
      try {
        await closeCurrentMCPConnectionScope();
      } finally {
        activeScopeKeys.delete(scope.cacheKey);
      }
    }
  });
}
