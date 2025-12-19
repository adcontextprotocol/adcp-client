/**
 * Tool Support Utilities
 *
 * Checks which tools support specific AdCP features
 */

/**
 * Check if a tool supports push_notification_config for async task notifications
 *
 * @param toolName - Name of the tool to check
 * @returns true if the tool supports push_notification_config, false otherwise
 */
export function checkToolSupportsPushNotification(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }

  // Tools that support async task notifications via push_notification_config
  const supportedTools = new Set([
    'sync_creatives',
    'create_media_buy',
    'update_media_buy',
  ]);

  return supportedTools.has(toolName.toLowerCase());
}
