interface CanonicalActionSchema {
  oneOf: Array<{
    properties: {
      task: { const: string };
      action: { const?: string; enum?: string[] };
    };
  }>;
}

/** Task routing is independent of whether an action maps to an update_media_buy field. */
export function canonicalMediaBuyActionTasks(schema: CanonicalActionSchema): Record<string, string[]> {
  const tasks: Record<string, string[]> = {};
  for (const branch of schema.oneOf) {
    const task = branch.properties.task.const;
    const values = branch.properties.action.enum ?? [branch.properties.action.const];
    if (
      typeof task !== 'string' ||
      !task ||
      !values.length ||
      values.some(value => typeof value !== 'string' || !value)
    ) {
      throw new Error('Canonical media-buy actions must declare task.const and action.const or action.enum.');
    }
    for (const action of values as string[]) {
      const routes = (tasks[action] ??= []);
      if (!routes.includes(task)) routes.push(task);
    }
  }
  return tasks;
}

/** Commercial change rights can exclude an otherwise discoverable canonical action. */
export function commercialMediaBuyActionNames(
  actions: readonly string[],
  actionSchema: { not?: { const?: unknown } }
): string[] {
  if (actionSchema.not === undefined) return [...actions];
  const excluded = actionSchema.not.const;
  if (typeof excluded !== 'string') {
    throw new Error('Commercial media-buy action exclusions must declare not.const.');
  }
  return actions.filter(action => action !== excluded);
}
