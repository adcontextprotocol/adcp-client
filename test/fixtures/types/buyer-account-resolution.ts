import type {
  AccountReference,
  AgentClient,
  ResolveAccountOptions,
  ResolveAccountResult,
  SingleAgentClient,
} from '../../../dist/lib/index.js';
import type { ResolveAccountResult as FocusedResult } from '../../../dist/lib/client/core.js';

declare const single: SingleAgentClient;
declare const agent: AgentClient;
declare const hints: ResolveAccountOptions;
declare const includeDetails: boolean;

// Existing callers with explicitly typed hints still receive a wire reference.
const oldSingle: Promise<AccountReference> = single.resolveAccount(hints);
const oldAgent: Promise<AccountReference> = agent.resolveAccount(hints);
const defaultSingle: Promise<AccountReference> = single.resolveAccount();
const defaultAgent: Promise<AccountReference> = agent.resolveAccount();
const explicitFalse: Promise<AccountReference> = agent.resolveAccount({ ...hints, includeDetails: false });
const detailedSingle: Promise<ResolveAccountResult> = single.resolveAccount({ ...hints, includeDetails: true });
const detailedAgent: Promise<FocusedResult> = agent.resolveAccount({ ...hints, includeDetails: true });
const dynamic: Promise<AccountReference | ResolveAccountResult> = agent.resolveAccount({ ...hints, includeDetails });
// @ts-expect-error A dynamic boolean cannot promise only a wire reference.
const dynamicWire: Promise<AccountReference> = agent.resolveAccount({ ...hints, includeDetails });

async function useResult() {
  const resolved = await detailedAgent;
  const id: string | undefined = resolved.account_id;
  const key = resolved.naturalKey;
  await agent.getProducts({ account: resolved.reference, buying_mode: 'brief', brief: 'Inventory' });
  // @ts-expect-error The detail envelope is not a wire reference.
  await agent.getProducts({ account: resolved, buying_mode: 'brief', brief: 'Inventory' });
  void id;
  void key;
}

void [oldSingle, oldAgent, defaultSingle, defaultAgent, explicitFalse, detailedSingle, dynamic, dynamicWire, useResult];
