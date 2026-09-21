import type { TaskPushNotificationConfig } from '@a2a-js/sdk-v1';

export interface A2APushNotificationConfig {
  url: string;
  token?: string;
  authentication?: {
    schemes?: string[];
    /** Legacy signing-vector spelling accepted at the conformance boundary. */
    scheme?: string;
    credentials?: string;
  };
}

/** Map AdCP push registration to the official A2A 1.0 transport shape. */
export function toA2ATaskPushNotificationConfig(config: A2APushNotificationConfig): TaskPushNotificationConfig {
  const authentication = config.authentication;
  return {
    tenant: '',
    id: '',
    taskId: '',
    url: config.url,
    token: config.token ?? '',
    authentication: authentication
      ? {
          scheme: authentication.schemes?.[0] ?? authentication.scheme ?? '',
          credentials: authentication.credentials ?? '',
        }
      : undefined,
  };
}
