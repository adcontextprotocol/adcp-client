import type { VersionAdapter, VersionDrift } from '../types';

const PUSH_NOTIFICATION_DRIFT: VersionDrift = {
  type: 'pre31_discovery_webhook_stripped',
  message:
    'push_notification_config stripped from get_signals: discovery-task webhooks require AdCP 3.1, ' +
    'but the target seller does not advertise 3.1 support. Poll for the result instead.',
  strippedFields: ['push_notification_config'],
};

export const getSignalsAdapter: VersionAdapter = {
  toolName: 'get_signals',
  adaptRequest(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { params };
    const request = params as Record<string, unknown>;
    if (!('push_notification_config' in request)) return { params };
    const { push_notification_config: _, ...adapted } = request;
    return { params: adapted, drift: PUSH_NOTIFICATION_DRIFT };
  },
};
