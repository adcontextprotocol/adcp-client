import type { DeferredTaskState, DeferredTaskStorage, SingleAgentClientConfig } from '../../../dist/lib/index.js';

const states = new Map<string, DeferredTaskState>();

const storage: DeferredTaskStorage = {
  async get(key) {
    return states.get(key);
  },
  async set(key, value) {
    states.set(key, value);
  },
  async delete(key) {
    states.delete(key);
  },
  async has(key) {
    return states.has(key);
  },
  async putIfAbsent(key, value) {
    if (states.has(key)) return false;
    states.set(key, value);
    return true;
  },
  async replaceIfVersion(key, expectedVersion, value) {
    if (states.get(key)?.continuationVersion !== expectedVersion) return false;
    states.set(key, value);
    return true;
  },
  async takeIfVersion(key, expectedVersion) {
    const value = states.get(key);
    if (value?.continuationVersion !== expectedVersion) return undefined;
    states.delete(key);
    return value;
  },
};

const state: DeferredTaskState = {
  continuationVersion: 'record-generation-id',
  taskId: 'client-correlation-id',
  contextId: 'seller-context-id',
  a2aTaskId: 'a2a-transport-task-id',
  serverVersion: 'v3',
  agentId: 'trusted-agent-id',
  taskName: 'create_media_buy',
  params: { idempotency_key: 'purchase-key' },
  messages: [],
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

void storage;
void state;

const clientConfig: SingleAgentClientConfig = {
  deferredStorage: storage,
  resolveDeferredAgent: async agentId =>
    agentId === 'trusted-agent-id'
      ? {
          id: agentId,
          name: 'Trusted agent',
          protocol: 'a2a',
          agent_uri: 'https://seller.example/a2a',
        }
      : undefined,
  deferredTaskTtlSeconds: 60,
};

void clientConfig;
