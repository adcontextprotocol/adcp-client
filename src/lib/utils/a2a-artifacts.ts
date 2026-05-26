/**
 * Shared A2A artifact extraction helpers.
 *
 * A2A conversational tasks append artifacts over time. The SDK's canonical
 * data path is the latest DataPart found by walking artifacts backward, then
 * parts backward. Trailing text-only artifacts can carry explanatory copy, but
 * they must not hide the latest structured AdCP payload.
 */

export interface A2ADataPartExtraction {
  artifact: Record<string, unknown>;
  part: Record<string, unknown>;
  data: Record<string, unknown>;
}

export function getLatestA2ADataPartFromTask(result: unknown): A2ADataPartExtraction | undefined {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return undefined;

  const artifacts = (result as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return undefined;

  for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
    const artifact = artifacts[artifactIndex];
    if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)) continue;

    const parts = (artifact as { parts?: unknown }).parts;
    if (!Array.isArray(parts) || parts.length === 0) continue;

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part == null || typeof part !== 'object' || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (record.kind !== 'data') continue;
      const data = record.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      return {
        artifact: artifact as Record<string, unknown>,
        part: record,
        data: data as Record<string, unknown>,
      };
    }
  }

  return undefined;
}

export function getLatestA2ADataPartFromResponse(response: unknown): A2ADataPartExtraction | undefined {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return undefined;
  return getLatestA2ADataPartFromTask((response as { result?: unknown }).result);
}
