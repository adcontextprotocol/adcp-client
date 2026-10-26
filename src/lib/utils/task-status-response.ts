/** A status query describes another task; its status/error are data, not the query's lifecycle. */
export function isTaskStatusResponse(value: unknown, toolName?: string): boolean {
  if (toolName !== 'get_task_status' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ['task_id', 'task_type', 'protocol', 'status', 'created_at', 'updated_at'].every(
      field => typeof record[field] === 'string'
    ) &&
    record.adcp_error === undefined &&
    record.errors === undefined
  );
}
