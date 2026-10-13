/**
 * Experimental AdCP 3.3 identity preview: pinned draft schemas, generated
 * types in sync with them, runtime validation, and type ergonomics.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { identityPreviewSchemaErrors } = require('../dist/lib/signing/server.js');

const ROOT = path.join(__dirname, '..');

describe('identity preview schemas', () => {
  it('records provenance for every vendored source', () => {
    const upstream = JSON.parse(readFileSync(path.join(ROOT, 'schemas/identity-preview/UPSTREAM.json'), 'utf8'));
    assert.equal(upstream.repository, 'adcontextprotocol/adcp');
    for (const [file, source] of Object.entries(upstream.sources)) {
      assert.match(source.commit, /^[0-9a-f]{40}$/, file);
      assert.ok(readFileSync(path.join(ROOT, 'schemas/identity-preview', file), 'utf8').length > 0, file);
    }
  });

  it('keeps generated types and the runtime bundle in sync with the pinned sources', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate-identity-preview.ts', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('validates the spec R7 onboarding example and rejects unknown requirement kinds on authoring', () => {
    const posture = {
      sandbox: { mode: 'open', url: 'https://streamhaus.example/sandbox' },
      billing: {
        operator: { mode: 'open', requirements: [{ kind: 'grant' }] },
        agent: {
          mode: 'application',
          url: 'https://streamhaus.example/partners/agent-billing',
          requirements: [{ kind: 'billing_entity' }, { kind: 'contract' }],
        },
      },
      url: 'https://streamhaus.example/partners/buyer-agents',
      message: 'Sandbox is open to any verified buying agent.',
    };
    assert.deepEqual(identityPreviewSchemaErrors(posture, 'core/agent-onboarding.json'), []);
    posture.sandbox.requirements = [{ kind: 'future_identity_badge' }];
    assert.notDeepEqual(identityPreviewSchemaErrors(posture, 'core/agent-onboarding.json'), []);
  });

  it('validates principal relationships', () => {
    assert.deepEqual(
      identityPreviewSchemaErrors(
        { status: 'pending', setup: { message: 'Apply' } },
        'core/principal-relationship.json'
      ),
      []
    );
    assert.notDeepEqual(identityPreviewSchemaErrors({ status: 'approved' }, 'core/principal-relationship.json'), []);
  });

  it('exposes typed experimental shapes under strict TypeScript', () => {
    const dir = mkdtempSync(path.join(ROOT, '.tmp-identity-types-'));
    try {
      const file = path.join(dir, 'usage.ts');
      writeFileSync(
        file,
        `import type { ExperimentalIdentity } from '../dist/lib/types/index';
import type { TrustRecord, AgentOnboarding, GrantAbsentDetails, VerifiedSigner } from '../dist/lib/signing/server';
import type { AdcpCredential as Credential } from '../dist/lib/server/index';
const record: TrustRecord = { agents: [{ url: 'https://buyer.agency.com', roles: ['adcp:buying'] }] };
const posture: AgentOnboarding = { sandbox: { mode: 'open' } };
const details: GrantAbsentDetails = { scope: 'agent', reason: 'grant_absent' };
const relationship: ExperimentalIdentity.PrincipalRelationship = { status: 'pending', setup: { message: 'Apply' } };
const reason: ExperimentalIdentity.ExperimentalPrincipalChangedReason = 'relationship_expiring';
const signer: VerifiedSigner = { keyid: 'k', verified_at: 1, profile: 'web-bot-auth', principal_id: 'p' };
const credential: Credential = { kind: 'http_sig', keyid: 'k', agent_url: 'https://b.com', verified_at: 1, profile: 'web-bot-auth' };
// @ts-expect-error onboarding modes are closed
const badMode: AgentOnboarding = { sandbox: { mode: 'sometimes' } };
// @ts-expect-error relationship status is closed
const badStatus: ExperimentalIdentity.PrincipalRelationship = { status: 'approved' };
void [record, posture, details, relationship, reason, signer, credential, badMode, badStatus];
`
      );
      const program = ts.createProgram([file], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        types: ['node'],
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
