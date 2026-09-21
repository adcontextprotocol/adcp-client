/**
 * A2A 1.0 JSON-RPC method names mapped to their stable 0.3 spellings.
 *
 * Kept in sync with @a2a-js/sdk-v1's `V1_TO_LEGACY_JSONRPC` table. We keep
 * this small synchronous copy so importing the general signing verifier does
 * not eagerly load the 1.0 SDK client. Tests compare every entry against the
 * official SDK's exported `v1MethodToLegacyJsonRpc()` translator.
 */
export const A2A_V1_TO_LEGACY_JSONRPC = Object.freeze({
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  CancelTask: 'tasks/cancel',
  SubscribeToTask: 'tasks/resubscribe',
  CreateTaskPushNotificationConfig: 'tasks/pushNotificationConfig/set',
  GetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/get',
  ListTaskPushNotificationConfigs: 'tasks/pushNotificationConfig/list',
  DeleteTaskPushNotificationConfig: 'tasks/pushNotificationConfig/delete',
  GetExtendedAgentCard: 'agent/getAuthenticatedExtendedCard',
} as const satisfies Readonly<Record<string, string>>);

/** Canonicalize either official 1.0 or legacy JSON-RPC spelling to legacy. */
export function canonicalA2AProtocolMethod(method: string): string {
  return A2A_V1_TO_LEGACY_JSONRPC[method as keyof typeof A2A_V1_TO_LEGACY_JSONRPC] ?? method;
}

/** Compare capability method declarations independent of A2A wire version. */
export function protocolMethodListIncludes(methods: readonly string[], candidate: string): boolean {
  const canonicalCandidate = canonicalA2AProtocolMethod(candidate);
  return methods.some(method => canonicalA2AProtocolMethod(method) === canonicalCandidate);
}
