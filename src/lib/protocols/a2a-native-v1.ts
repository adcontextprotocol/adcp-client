import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client,
} from '@a2a-js/sdk-v1/client';
import {
  Role,
  TaskState,
  type CancelTaskRequest,
  type SendMessageRequest,
  type TaskPushNotificationConfig,
} from '@a2a-js/sdk-v1';
import type { PushNotificationConfig } from '../types/tools.generated';

const ADCP_A2A_EXTENSION = 'https://adcontextprotocol.org/extensions/adcp/v3';
const NATIVE_ONLY = Object.freeze({ enabled: false });

export async function createNativeA2AClientFromCardUrl(cardUrl: string, fetchImpl: typeof fetch): Promise<Client> {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat: NATIVE_ONLY })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl, legacyCompat: NATIVE_ONLY }),
  });
  return factory.createFromUrl(cardUrl, '');
}

export async function callNativeA2ATool(options: {
  cardUrls: readonly string[];
  fetchImpl: typeof fetch;
  toolName: string;
  parameters: Record<string, unknown>;
  pushNotificationConfig?: PushNotificationConfig;
  contextId?: string;
  taskId?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  let client: Client | undefined;
  let lastError: unknown;
  for (const cardUrl of options.cardUrls) {
    try {
      client = await createNativeA2AClientFromCardUrl(cardUrl, options.fetchImpl);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!client) {
    const detail = lastError instanceof Error ? lastError.message : 'A2A agent card discovery failed';
    throw new Error(
      `${detail}. Native conformance uses the official A2A 1.0 client; ` +
        'for a maintained A2A 0.3 server use transport.legacyCompat.enabled=true ' +
        '(CLI: --a2a-legacy-compat).',
      { cause: lastError }
    );
  }

  const request: SendMessageRequest = {
    tenant: '',
    message: {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'data', value: { skill: options.toolName, input: options.parameters } },
          metadata: undefined,
          filename: '',
          mediaType: 'application/json',
        },
      ],
      contextId: options.contextId ?? '',
      taskId: options.taskId ?? '',
      metadata: undefined,
      extensions: [ADCP_A2A_EXTENSION],
      referenceTaskIds: [],
    },
    configuration: options.pushNotificationConfig
      ? {
          acceptedOutputModes: ['application/json'],
          taskPushNotificationConfig: toPushNotificationConfig(options.pushNotificationConfig),
          returnImmediately: false,
        }
      : undefined,
    metadata: undefined,
  };

  const result = await client.sendMessage(request, {
    serviceParameters: ServiceParameters.create(withA2AExtensions(ADCP_A2A_EXTENSION)),
    signal: options.signal,
  });
  return normalizeNativeA2AResult(result);
}

function toPushNotificationConfig(config: PushNotificationConfig): TaskPushNotificationConfig {
  const authentication = config.authentication as { schemes?: string[]; credentials?: string } | undefined;
  return {
    tenant: '',
    id: '',
    taskId: '',
    url: config.url,
    token: config.token ?? '',
    authentication: authentication
      ? {
          scheme: authentication.schemes?.[0] ?? '',
          credentials: authentication.credentials ?? '',
        }
      : undefined,
  };
}

function normalizePart(part: any): Record<string, unknown> {
  switch (part?.content?.$case) {
    case 'data':
      return { kind: 'data', data: part.content.value, metadata: part.metadata };
    case 'text':
      return { kind: 'text', text: part.content.value, metadata: part.metadata };
    case 'url':
      return {
        kind: 'file',
        file: { uri: part.content.value, name: part.filename, mimeType: part.mediaType },
        metadata: part.metadata,
      };
    case 'raw':
      return {
        kind: 'file',
        file: { bytes: part.content.value, name: part.filename, mimeType: part.mediaType },
        metadata: part.metadata,
      };
    default:
      return part;
  }
}

function taskStateName(state: TaskState | undefined): string | undefined {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return 'submitted';
    case TaskState.TASK_STATE_WORKING:
      return 'working';
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed';
    case TaskState.TASK_STATE_FAILED:
      return 'failed';
    case TaskState.TASK_STATE_CANCELED:
      return 'canceled';
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'input-required';
    case TaskState.TASK_STATE_REJECTED:
      return 'rejected';
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'auth-required';
    default:
      return undefined;
  }
}

export function createNativeCancelTaskRequest(id: string): CancelTaskRequest {
  return { tenant: '', id, metadata: undefined };
}

export function normalizeNativeA2AResult(result: any): { result: unknown } {
  if (result && typeof result === 'object' && ('result' in result || 'error' in result)) return result;
  if (result && typeof result === 'object' && ('status' in result || 'contextId' in result)) {
    return {
      result: {
        ...result,
        kind: 'task',
        status: result.status
          ? {
              ...result.status,
              state: taskStateName(result.status.state),
              message: result.status.message
                ? {
                    ...result.status.message,
                    kind: 'message',
                    parts: Array.isArray(result.status.message.parts)
                      ? result.status.message.parts.map(normalizePart)
                      : [],
                  }
                : undefined,
            }
          : undefined,
        artifacts: Array.isArray(result.artifacts)
          ? result.artifacts.map((artifact: any) => ({
              ...artifact,
              parts: artifact.parts?.map(normalizePart) ?? [],
            }))
          : [],
      },
    };
  }
  if (result && Array.isArray(result.parts)) {
    return { result: { ...result, kind: 'message', parts: result.parts.map(normalizePart) } };
  }
  return { result };
}
