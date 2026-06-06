import type { TaskOptions, WebhookUrlTemplate } from './ConversationTypes';

export function selectWebhookTemplate(config: WebhookUrlTemplate | undefined, taskName: string): string | undefined {
  if (!config) return undefined;
  if (typeof config === 'string') return config;

  if (!config.template) return undefined;
  if (config.tools === undefined) return config.template;
  if (Array.isArray(config.tools)) {
    return config.tools.includes(taskName) ? config.template : undefined;
  }

  return config.tools(taskName) ? config.template : undefined;
}

export function resolveWebhookUrl(
  config: WebhookUrlTemplate | undefined,
  agentId: string | undefined,
  taskName: string,
  operationId: string,
  options?: Pick<TaskOptions, 'disableWebhook'>
): string | undefined {
  if (options?.disableWebhook || !agentId) return undefined;

  const template = selectWebhookTemplate(config, taskName);
  if (!template) return undefined;

  return template
    .replace(/{agent_id}/g, agentId)
    .replace(/{task_type}/g, taskName)
    .replace(/{operation_id}/g, operationId);
}
