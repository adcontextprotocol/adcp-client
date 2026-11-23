import type { VersionAdapter, VersionDrift } from '../types';

// AdCP 3.1 moved each of these tasks' own decision off top-level `status`, to
// free that key for the task envelope status, without changing its values.
// AdCP 3.0 carries the decision in `status`. Move it back before projection
// drops the 3.1 field, or a 3.0 caller reads the task status `completed` in
// place of the decision (adcp-client#3743).
function moveDecisionToStatus(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const decision = record[field];
  if (typeof decision !== 'string') return undefined;
  if (record.status !== undefined && record.status !== 'completed') return undefined;
  const { [field]: _moved, ...rest } = record;
  return { ...rest, status: decision };
}

function downgradeDecision(field: string) {
  return (data: unknown): { data: unknown; drift?: VersionDrift } => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data };
    const response = data as Record<string, unknown>;
    const moved = moveDecisionToStatus(response, field);
    if (moved) {
      return {
        data: moved,
        drift: {
          type: 'pre31_decision_status_moved',
          message: `Decision moved from ${field} to the AdCP 3.0 status field.`,
          movedFields: [{ from: field, to: 'status' }],
        },
      };
    }
    // A task completion without a decision must not reach a 3.0 caller where
    // it reads the decision.
    if (response.status !== 'completed') return { data };
    const { status: _taskStatus, ...rest } = response;
    return {
      data: rest,
      drift: {
        type: 'pre31_task_status_stripped',
        message: `Task completion omitted: AdCP 3.0 status carries the decision that 3.1 names ${field}.`,
        strippedFields: ['status'],
      },
    };
  };
}

// `get_plan_audit_logs` check entries renamed `status` to `verdict` with
// `check_governance` (3.1).
function downgradeAuditEntryVerdicts(data: unknown): { data: unknown; drift?: VersionDrift } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data };
  const response = data as Record<string, unknown>;
  if (!Array.isArray(response.plans)) return { data };
  const movedFields: Array<{ from: string; to: string }> = [];
  const plans = response.plans.map((plan: unknown, planIndex) => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan;
    const entries = (plan as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return plan;
    let changed = false;
    const adapted = entries.map((entry: unknown, entryIndex) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const moved = moveDecisionToStatus(entry as Record<string, unknown>, 'verdict');
      if (!moved) return entry;
      changed = true;
      const path = `plans[${planIndex}].entries[${entryIndex}]`;
      movedFields.push({ from: `${path}.verdict`, to: `${path}.status` });
      return moved;
    });
    return changed ? { ...(plan as Record<string, unknown>), entries: adapted } : plan;
  });
  if (movedFields.length === 0) return { data };
  return {
    data: { ...response, plans },
    drift: {
      type: 'pre31_decision_status_moved',
      message: 'Audit-log check verdicts moved to the AdCP 3.0 status field.',
      movedFields,
    },
  };
}

export const checkGovernanceAdapter: VersionAdapter = {
  toolName: 'check_governance',
  downgradeResponse: downgradeDecision('verdict'),
};

export const reportPlanOutcomeAdapter: VersionAdapter = {
  toolName: 'report_plan_outcome',
  downgradeResponse: downgradeDecision('outcome_state'),
};

export const acquireRightsAdapter: VersionAdapter = {
  toolName: 'acquire_rights',
  downgradeResponse: downgradeDecision('rights_status'),
};

export const getPlanAuditLogsAdapter: VersionAdapter = {
  toolName: 'get_plan_audit_logs',
  downgradeResponse: downgradeAuditEntryVerdicts,
};
