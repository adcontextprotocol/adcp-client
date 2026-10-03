/** Only spend commitments and account-owned resource creation may provision. */
export function isAccountProvisioningTask(toolName: string | undefined): boolean {
  return (
    toolName !== undefined &&
    (toolName.startsWith('sync_') ||
      ['create_media_buy', 'buy_products', 'accept_proposal', 'activate_signal', 'acquire_rights'].includes(toolName))
  );
}
