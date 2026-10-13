import { createHash } from 'crypto';
import { registerWebBotAuthLegacyOriginGate } from '../signing/web-bot-auth';
import { RequestSignatureError } from '../signing/errors';
import { TaskTypeValues } from '../types/enums.generated';
import { AdcpError } from '../server/decisioning/async-outcome';
import { createWebBotAuthAuthorizationFailure, getWebBotAuthAuthorizationFailure } from '../signing/web-bot-auth';
import type { AuthPrincipal } from '../server/auth';
import type { HandlerContext, ProtocolHandlers } from '../server/create-adcp-server';
import { markVerifiedHttpSig } from '../server/decisioning/buyer-agent';
import { isVerifiedWebBotSigner, type VerifiedWebBotSigner, WebBotAuthError } from '../signing/web-bot-auth';
import type { ResolvedOperation } from '../signing/operation-resolution';
import type { OriginIdentityLifecycle } from './lifecycle';
import {
  authorizeDemandGrant,
  IdentityAuthorizationError,
  type DemandGrantClaim,
  type DemandGrantOptions,
} from './trust';
import { MUTATING_TASKS } from '../utils/idempotency';
const IDENTITY_ADMIN_TOOLS = new Set(['sync_principal', 'sync_agent_notification_configs']);
const KNOWN_TOOLS = new Set<string>([...TaskTypeValues, 'get_task_status', 'list_tasks', 'tasks_get']);
const SPEND_TOOLS = new Set([...MUTATING_TASKS].filter(tool => !IDENTITY_ADMIN_TOOLS.has(tool)));
function needsSpendAuthorization(tool: string, params: unknown): boolean {
  if (SPEND_TOOLS.has(tool) || !KNOWN_TOOLS.has(tool)) return true;
  if (tool !== 'get_products' || !params || typeof params !== 'object') return false;
  const refine = (params as { refine?: unknown }).refine;
  return (Array.isArray(refine) ? refine : [refine]).some(
    entry => entry && typeof entry === 'object' && entry.action === 'finalize'
  );
}
interface IdentityClaim {
  state: 'identity-established' | 'bound';
  signer: VerifiedWebBotSigner;
  authorizationFailure?: import('../signing/web-bot-auth').WebBotAuthAuthorizationFailure;
}
function claimFromContext(ctx: HandlerContext<unknown>): IdentityClaim | undefined {
  const claim = ctx.authInfo?.extra?.identity33 as IdentityClaim | undefined;
  return claim && isVerifiedWebBotSigner(claim.signer) ? claim : undefined;
}
export function isIdentity33UnboundContext(ctx: HandlerContext<unknown>): boolean {
  return claimFromContext(ctx)?.state === 'identity-established';
}
/** Maps only audited bindings. An unknown origin remains in anonymous scope. */
export function createIdentity33PrincipalResolver(options: {
  lifecycle: OriginIdentityLifecycle;
  anonymousPrincipal?: string;
  anonymousTools?: readonly string[];
}): (signers: readonly VerifiedWebBotSigner[], operation: ResolvedOperation) => Promise<AuthPrincipal> {
  const anonymousTools = new Set(
    options.anonymousTools ?? [
      'get_adcp_capabilities',
      'get_principal',
      'sync_principal',
      'list_creative_formats',
      'get_products',
    ]
  );
  const resolver = async (
    signers: readonly VerifiedWebBotSigner[],
    operation: ResolvedOperation
  ): Promise<AuthPrincipal> => {
    if (!signers.length || signers.some(s => !isVerifiedWebBotSigner(s)))
      throw new WebBotAuthError(403, 'unverified_identity');
    const signer = signers[signers.length - 1]!;
    const revoked = signers.find(s => s.authorizationFailure);
    const { binding } = revoked ? { binding: undefined } : await options.lifecycle.getPrincipal(signer.origin);
    if (!binding && operation !== undefined && typeof operation !== 'string')
      throw new WebBotAuthError(400, 'operation');
    const authorizationFailure =
      revoked?.authorizationFailure ??
      (!binding && typeof operation === 'string' && !anonymousTools.has(operation)
        ? createWebBotAuthAuthorizationFailure('identity_not_bound')
        : undefined);
    return {
      principal:
        binding?.principalId ??
        `${options.anonymousPrincipal ?? 'anonymous'}:${createHash('sha256').update(signer.origin).digest('hex')}`,
      extra: {
        identity33: {
          state: binding ? 'bound' : 'identity-established',
          signer: revoked ?? signer,
          ...(authorizationFailure && { authorizationFailure }),
        },
      },
      ...(binding
        ? {
            credential: markVerifiedHttpSig({
              kind: 'http_sig',
              keyid: signer.keyid,
              agent_url: signer.origin,
              verified_at: signer.verified_at,
            }),
          }
        : {}),
    };
  };
  registerWebBotAuthLegacyOriginGate(resolver, async origin => {
    if ((await options.lifecycle.getPrincipal(origin)).binding)
      throw new RequestSignatureError(
        'request_signature_key_unknown',
        7,
        'Origin-bound principals require Web Bot Auth'
      );
  });
  return resolver;
}
/** Pass to createAdcpServer.identity33.authorize; framework runs it before its replay cache. */
export function createIdentity33Authorization<TAccount>(options: {
  lifecycle: OriginIdentityLifecycle;
  /** Explicitly declared custom read tools still re-check identity membership. */
  readOnlyTools?: readonly string[];
  anonymousTools?: readonly string[];
  grants: DemandGrantOptions;
  /** Runs before account resolution: look up existing seller accounts read-only. sync_accounts includes all proposed rows. Never trust request reassignment or provision here. */
  resolveClaims: (
    ctx: HandlerContext<TAccount>,
    tool: string,
    params: unknown
  ) => Promise<
    readonly (Omit<DemandGrantClaim, 'signerOrigin'> & {
      sandbox?: boolean;
      billing?: 'operator' | 'agent' | 'advertiser';
    })[]
  >;
}): (ctx: HandlerContext<TAccount>, tool: string, params: unknown) => Promise<void> {
  return async (ctx, tool, params) => {
    const identity = claimFromContext(ctx);
    const failure = getWebBotAuthAuthorizationFailure(ctx.authInfo?.extra);
    if (failure) throw new AdcpError(failure.code, failure);
    if (!identity) {
      const verified = ctx.authInfo?.extra?.webBotAuthAuthorization as { signer?: unknown } | undefined;
      if (isVerifiedWebBotSigner(verified?.signer))
        throw new AdcpError('PERMISSION_DENIED', {
          message: 'Web Bot Auth resolver did not supply an audited identity claim',
        });
      return; // Legacy gates continue to own RFC/bearer callers.
    }
    if (identity.state === 'identity-established') {
      if (tool === 'sync_principal') {
        const dryRun = !!params && typeof params === 'object' && (params as { dry_run?: unknown }).dry_run === true;
        const binding = await options.lifecycle.syncOpen(identity.signer.origin, { dryRun });
        if (dryRun) return;
        if (!ctx.authInfo) throw new IdentityAuthorizationError();
        ctx.authInfo.clientId = binding.principalId;
        ctx.authInfo.credential = markVerifiedHttpSig({
          kind: 'http_sig',
          keyid: identity.signer.keyid,
          agent_url: identity.signer.origin,
          verified_at: identity.signer.verified_at,
        });
        ctx.authInfo.extra = {
          ...ctx.authInfo.extra,
          credential: ctx.authInfo.credential,
          identity33: { ...identity, state: 'bound' },
        };
        return;
      }
      if (
        (
          options.anonymousTools ?? ['get_principal', 'get_adcp_capabilities', 'list_creative_formats', 'get_products']
        ).includes(tool) &&
        !needsSpendAuthorization(tool, params)
      )
        return;
      throw new AdcpError('PERMISSION_DENIED', { message: 'Agent identity is not onboarded for this operation' });
    }
    const origin = identity.signer.origin;
    if (IDENTITY_ADMIN_TOOLS.has(tool)) {
      await options.lifecycle.authorizeBound(origin, { identityConfiguration: true });
      return;
    }
    if (!needsSpendAuthorization(tool, params) || (!KNOWN_TOOLS.has(tool) && options.readOnlyTools?.includes(tool))) {
      await options.lifecycle.authorizeBound(origin, { readOnly: true });
      return;
    }
    const claims = await options.resolveClaims(ctx, tool, params);
    if (!claims.length) throw new IdentityAuthorizationError();
    for (const claim of claims) {
      await options.lifecycle.authorizeBound(origin, {
        sandbox: claim.sandbox,
        billing: claim.billing,
        brandDomain: claim.brand.domain,
      });
      await authorizeDemandGrant({ ...claim, signerOrigin: origin }, options.grants);
    }
  };
}
/** Adds caller-only relationship readback; unknown reads never run the durable principal runtime. */
export function withIdentity33PrincipalHandlers<TAccount>(
  base: ProtocolHandlers<TAccount>,
  lifecycle: OriginIdentityLifecycle
): ProtocolHandlers<TAccount> {
  return {
    ...base,
    async syncPrincipal(params, ctx) {
      const identity = claimFromContext(ctx);
      if (identity?.state === 'identity-established' && params.dry_run === true)
        return { result: { kind: 'validated', action: 'would_update', dry_run: true } };
      if (!base.syncPrincipal) throw new IdentityAuthorizationError();
      return base.syncPrincipal(params, ctx);
    },
    async getPrincipal(params, ctx) {
      const identity = claimFromContext(ctx);
      if (!identity) {
        if (!base.getPrincipal) throw new IdentityAuthorizationError();
        return base.getPrincipal(params, ctx);
      }
      const read = await lifecycle.getPrincipal(identity.signer.origin);
      if (!read.binding) return { result: read.result } as never;
      if (!base.getPrincipal) return { result: read.result } as never;
      const response = await base.getPrincipal(params, ctx);
      if (read.result.relationship && response && typeof response === 'object') {
        const boxed = 'structuredContent' in response;
        const payload = (boxed ? response.structuredContent : response) as { result?: { kind?: string } } | undefined;
        if (payload?.result && ['current', 'recognized', 'unconfigured'].includes(payload.result.kind ?? '')) {
          const augmented = { ...payload, result: { ...payload.result, relationship: read.result.relationship } };
          return (boxed ? { ...response, structuredContent: augmented } : augmented) as typeof response;
        }
      }
      return response;
    },
  };
}

/** Use as createPrincipalLifecycle.resolvePrincipal to keep the configuration record on the audited binding. */
export function createIdentity33PrincipalScopeResolver<TAccount>(options: {
  lifecycle: OriginIdentityLifecycle;
  tenantId: string;
  legacy?: (ctx: HandlerContext<TAccount>) => Promise<import('../server/principal/types').ResolvedPrincipalScope>;
}): (ctx: HandlerContext<TAccount>) => Promise<import('../server/principal/types').ResolvedPrincipalScope> {
  if (!options.tenantId) throw new TypeError('Principal scope requires a trusted tenant id');
  return async ctx => {
    const identity = claimFromContext(ctx);
    if (!identity) {
      if (!options.legacy) throw new IdentityAuthorizationError();
      return options.legacy(ctx);
    }
    const { binding } = await options.lifecycle.getPrincipal(identity.signer.origin);
    if (!binding) throw new IdentityAuthorizationError();
    return {
      tenant_id: options.tenantId,
      principal_id: binding.principalId,
      principal_record_id: binding.principalId,
      principal_kind: binding.principalKind ?? 'buyer_agent',
    };
  };
}
