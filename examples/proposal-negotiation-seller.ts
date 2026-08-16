#!/usr/bin/env tsx
/**
 * Runnable authenticated MCP seller for `refine_proposals`.
 *
 * SOURCE_PROPOSAL_JSON='{"proposal_id":"...",...}' \
 * DEMO_API_KEY='replace-me-with-a-long-random-key' \
 * npx tsx examples/proposal-negotiation-seller.ts
 */
import { randomUUID } from 'node:crypto';
import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';
import {
  createIdempotencyStore,
  createProposalRefinementHandler,
  createProposalSuccessor,
  memoryBackend,
  proposalRefinementScopeFromContext,
  serve,
  verifyApiKey,
  type CanonicalProposal,
  type ProposalActiveHold,
  type ProposalRefinementScope,
  type ProposalRefinementTransaction,
  type ProposalSourceExpectation,
} from '@adcp/sdk/server';

const sourceJson = process.env['SOURCE_PROPOSAL_JSON'];
const apiKey = process.env['DEMO_API_KEY'];
if (!sourceJson) throw new Error('SOURCE_PROPOSAL_JSON is required');
if (!apiKey || apiKey.length < 16) throw new Error('DEMO_API_KEY must contain at least 16 characters');

const source = JSON.parse(sourceJson) as CanonicalProposal;
type VersionedProposal = { proposal: CanonicalProposal; version: number; active_hold?: ProposalActiveHold };
const records = new Map<string, VersionedProposal>();
const recordKey = (scope: Readonly<ProposalRefinementScope>, id: string) =>
  `${scope.tenant_id}\0${scope.principal_id}\0${scope.account_id ?? ''}\0${id}`;
const demoScope = { tenant_id: 'publisher-demo', principal_id: 'proposal-demo-buyer' };
records.set(recordKey(demoScope, source.proposal_id), { proposal: source, version: 1 });

const refinementHandler = createProposalRefinementHandler({
  capabilities: { supported_dimensions: [] },
  scope: proposalRefinementScopeFromContext,
  store: {
    get: (scope, id) => {
      const record = records.get(recordKey(scope, id));
      if (!record) return null;
      const activeHoldExpiry = record.active_hold ? Date.parse(record.active_hold.expires_at) : undefined;
      const activeHold =
        record.active_hold &&
        (activeHoldExpiry === undefined || !Number.isFinite(activeHoldExpiry) || activeHoldExpiry > Date.now())
          ? structuredClone(record.active_hold)
          : undefined;
      return {
        proposal: record.proposal,
        version: String(record.version),
        ...(activeHold && { active_hold: activeHold }),
      };
    },
    begin: (scope, expectedSources): ProposalRefinementTransaction => {
      const staged: CanonicalProposal[] = [];
      const expectations = structuredClone(expectedSources) as ProposalSourceExpectation[];
      return {
        stage: proposals => staged.push(...structuredClone(proposals)),
        commit: () => {
          for (const expected of expectations) {
            const current = records.get(recordKey(scope, expected.proposal_id));
            if ((current ? String(current.version) : null) !== expected.version) {
              throw new Error(`concurrent proposal update: ${expected.proposal_id}`);
            }
          }
          for (const proposal of staged) {
            const key = recordKey(scope, proposal.proposal_id);
            if (records.has(key)) throw new Error(`successor already exists: ${proposal.proposal_id}`);
          }
          const holds = new Map<string, ProposalActiveHold>();
          for (const expected of expectations) {
            if (expected.action !== 'finalize') continue;
            const current = records.get(recordKey(scope, expected.proposal_id));
            if (current?.active_hold) {
              const expiresAt = Date.parse(current.active_hold.expires_at);
              if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
                throw new Error(`source already has an active or invalid hold: ${expected.proposal_id}`);
              }
            }
            const committed = staged.find(
              proposal =>
                proposal.parent_proposal_id === expected.proposal_id && proposal.proposal_status === 'committed'
            );
            if (!committed?.expires_at || Date.parse(committed.expires_at) <= Date.now()) {
              throw new Error(`finalize must stage a committed successor with a future hold: ${expected.proposal_id}`);
            }
            holds.set(expected.proposal_id, {
              proposal_id: committed.proposal_id,
              expires_at: committed.expires_at,
            });
          }
          for (const expected of expectations) {
            const key = recordKey(scope, expected.proposal_id);
            const current = records.get(key);
            if (current) {
              records.set(key, {
                ...current,
                version: current.version + 1,
                ...(holds.has(expected.proposal_id) && { active_hold: holds.get(expected.proposal_id)! }),
              });
            }
          }
          for (const proposal of staged) records.set(recordKey(scope, proposal.proposal_id), { proposal, version: 1 });
        },
        rollback: () => staged.splice(0),
      };
    },
  },
  // Commercial policy remains application-owned. This demo only reserves
  // the exact terms of an available draft for fifteen minutes.
  evaluate: ({ refinement, source: current }) => {
    if (!current || refinement.action !== 'finalize') {
      return {
        source_proposal_id: refinement.proposal_id,
        outcome: 'unable',
        reason_code: 'source_unavailable',
        reason: 'This demo only finalizes an available draft.',
      };
    }
    return {
      source_proposal_id: refinement.proposal_id,
      outcome: 'finalized',
      proposal: createProposalSuccessor(current, {
        ...current,
        proposal_id: `held:${randomUUID()}`,
        proposal_status: 'committed',
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    };
  },
});

const idempotency = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServer({
      name: 'Proposal Negotiation Seller',
      version: '1.0.0',
      taskStore,
      idempotency,
      resolveIdempotencyPrincipal: ctx => ctx.proposalRefinementScope?.principal_id,
      proposalNegotiation: {
        capabilities: { supported_dimensions: [] },
        resolveScope: ctx => ({
          tenant_id: 'publisher-demo',
          principal_id: ctx.authInfo?.clientId ?? 'unreachable-anonymous-principal',
        }),
        refineProposals: refinementHandler,
      },
    }),
  {
    authenticate: verifyApiKey({ keys: { [apiKey]: { principal: demoScope.principal_id } } }),
  }
);
