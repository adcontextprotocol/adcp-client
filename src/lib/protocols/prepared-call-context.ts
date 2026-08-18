import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentConfig } from '../types';
import type { PreparedProtocolToolCall } from './index';

interface PreparedCallContext {
  agent: AgentConfig;
  toolName: string;
  args: Record<string, unknown>;
  preparedCall: PreparedProtocolToolCall;
}

const preparedCallStorage = new AsyncLocalStorage<PreparedCallContext>();

/** Internal exact-wire handoff between TaskExecutor and ProtocolClient. */
export function withPreparedProtocolToolCall<T>(context: PreparedCallContext, run: () => Promise<T>): Promise<T> {
  return preparedCallStorage.run(context, run);
}

/** Consume only for the exact outer call; nested capability calls prepare normally. */
export function preparedProtocolToolCallFor(
  agent: AgentConfig,
  toolName: string,
  args: Record<string, unknown>
): PreparedProtocolToolCall | undefined {
  const context = preparedCallStorage.getStore();
  return context?.agent === agent && context.toolName === toolName && context.args === args
    ? context.preparedCall
    : undefined;
}
