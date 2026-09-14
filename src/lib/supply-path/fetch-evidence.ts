import { defaultSupplyPathAuthorities } from './revocations';
import { withAbortSignal } from '../protocols/abort';
import { createHash } from 'node:crypto';
import { parse } from 'secure-json-parse';
import { SsrfRefusedError, SSRF_TRANSIENT_CODES, type SsrfFetchResult } from '../net/ssrf-fetch';
import { ssrfSafeFetchAdAgents, AdAgentsRedirectRefusedError } from '../discovery/adagents-redirects';
import type { AuthoritativeSupplyPathOptions, SupplyPathEvidence, SupplyPathManifest } from './types';
import { defaultSupplyPathRevocations, parseRevocations, type SupplyPathRevocation } from './revocations';
import { record } from './validation';

export function boundedOption(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

/** A verification-local evidence session. No cached verdict survives a request. */
export class SupplyPathEvidenceSession {
  readonly evidence: SupplyPathEvidence[] = [];
  readonly crossOriginAuthorities = new Set<string>();
  private readonly observedRevocations = new Map<string, SupplyPathRevocation[]>();
  readonly revocations = new Map<string, readonly import('./revocations').SupplyPathRevocation[]>();
  readonly signal: AbortSignal;
  private readonly maxBodyBytes: number;
  private readonly timeoutMs: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private readonly abort: () => void;
  private readonly responses = new Map<string, Promise<SsrfFetchResult | null>>();
  private readonly provenance = new WeakMap<SsrfFetchResult, SupplyPathEvidence>();
  private observedBytes = 0;
  private readonly documents = new Map<string, Promise<SupplyPathManifest | null>>();

  constructor(private readonly options: AuthoritativeSupplyPathOptions) {
    this.timeoutMs = boundedOption(options.timeoutMs, 15_000, 60_000, 'timeoutMs');
    this.maxBodyBytes = boundedOption(options.maxBodyBytes, 256 * 1024, 20 * 1024 * 1024, 'maxBodyBytes');
    this.signal = this.controller.signal;
    this.abort = () => this.controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
    this.timer = setTimeout(
      () => this.controller.abort(new Error('Supply-path verification deadline exceeded')),
      this.timeoutMs
    );
  }
  close(): void {
    clearTimeout(this.timer);
    this.controller.abort(new Error('Supply-path evidence session closed'));
    this.options.signal?.removeEventListener('abort', this.abort);
  }
  adagents(publisher: string): Promise<SupplyPathManifest | null> {
    let pending = this.documents.get(publisher);
    if (!pending) {
      pending = this.readAndRemember(publisher);
      this.documents.set(publisher, pending);
    }
    return pending;
  }
  read(
    publisher: string,
    kind: SupplyPathEvidence['kind'],
    url: string,
    pointer = false
  ): Promise<SsrfFetchResult | null> {
    const key = JSON.stringify([publisher, kind, url, pointer]);
    let pending = this.responses.get(key);
    if (!pending) {
      pending = this.fetchEvidence(publisher, kind, url, pointer);
      this.responses.set(key, pending);
    }
    return pending;
  }
  private async fetchEvidence(
    publisher: string,
    kind: SupplyPathEvidence['kind'],
    url: string,
    pointer = false
  ): Promise<SsrfFetchResult | null> {
    this.signal.throwIfAborted();
    try {
      if (this.observedBytes >= 64 * 1024 * 1024) throw new Error('evidence_budget_exceeded');
      const parsed = new URL(url);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        (parsed.port && parsed.port !== '443')
      ) {
        throw new Error('invalid_evidence_url');
      }
      const response = await ssrfSafeFetchAdAgents(
        url,
        {
          timeoutMs: this.timeoutMs,
          maxBodyBytes: this.maxBodyBytes,
          signal: this.signal,
          trustedFetchFn: this.options.trustedFetchFn,
          headers: { Accept: kind === 'adagents' ? 'application/json' : 'text/plain', 'Cache-Control': 'no-cache' },
        },
        pointer ? { mode: 'none' } : { mode: 'same-origin', originUrl: url, maxRedirects: 3 },
        result => {
          this.observedBytes += result.body.byteLength;
          const evidence: SupplyPathEvidence = {
            kind,
            publisher_domain: publisher,
            requested_url: url,
            resolved_url: result.url,
            fetched_at: new Date().toISOString(),
            status: result.status,
            byte_length: result.body.byteLength,
            sha256: createHash('sha256').update(result.body).digest('hex'),
            connection_pinned: result.connectionPinned,
            ...(result.status >= 300 && result.status < 400 && result.headers.location
              ? { delegated_to: result.headers.location }
              : {}),
            ...(this.options.retainEvidenceBodies ? { body_base64: Buffer.from(result.body).toString('base64') } : {}),
          };
          this.evidence.push(evidence);
          this.provenance.set(result, evidence);
          if (this.observedBytes > 64 * 1024 * 1024) throw new Error('evidence_budget_exceeded');
        }
      );
      if (response.status === 404 && kind !== 'adagents') return { ...response, body: new Uint8Array() };
      if (response.status !== 200) return null;
      const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      const validType =
        kind === 'adagents'
          ? contentType === 'application/json' || contentType?.endsWith('+json')
          : contentType === 'text/plain';
      if (!validType) throw new Error('invalid_content_type');
      return response;
    } catch (error) {
      this.signal.throwIfAborted();
      const code =
        error instanceof SsrfRefusedError || error instanceof AdAgentsRedirectRefusedError
          ? error.code
          : error instanceof Error &&
              ['invalid_evidence_url', 'invalid_content_type', 'evidence_budget_exceeded'].includes(error.message)
            ? error.message
            : 'fetch_failed';
      this.evidence.push({
        kind,
        publisher_domain: publisher,
        requested_url: url,
        fetched_at: new Date().toISOString(),
        error: code,
      });
      // Preserve the repository's explicit network-policy refusal boundary.
      if (error instanceof SsrfRefusedError && !SSRF_TRANSIENT_CODES.has(error.code)) throw error;
      return null;
    }
  }
  private async parseManifest(publisher: string, response: SsrfFetchResult): Promise<SupplyPathManifest | null> {
    let document: unknown;
    try {
      document = parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
      if (!record(document)) throw new Error('not_object');
    } catch {
      this.documentError(publisher, response, 'invalid_document');
      return null;
    }
    const denials = parseRevocations(document.revoked_publisher_domains);
    if (denials === null) {
      this.documentError(publisher, response, 'invalid_revocations');
      throw new TypeError('Invalid publisher revocation evidence');
    }
    // Denials survive invalid affirmative envelopes and failed/chained pointers.
    this.observedRevocations.set(publisher, [...(this.observedRevocations.get(publisher) ?? []), ...denials]);
    // Persist before any later fetch or authority operation can fail or exhaust
    // the deadline. A failed affirmative verification must not erase a denial.
    if (denials.length) await this.rememberRevocations(publisher);
    return document;
  }
  private documentError(publisher: string, response: SsrfFetchResult, error: string): void {
    this.evidence.push({
      kind: 'adagents',
      publisher_domain: publisher,
      requested_url: response.url,
      fetched_at: new Date().toISOString(),
      error,
    });
  }
  private async readAdagents(publisher: string): Promise<SupplyPathManifest | null> {
    const url = `https://${publisher}/.well-known/adagents.json`;
    const initial = await this.read(publisher, 'adagents', url);
    if (!initial) return null;
    let authorityLocation = url;
    let documentResponse = initial;
    let manifest = await this.parseManifest(publisher, initial);
    if (!manifest) return null;
    if (manifest.authoritative_location !== undefined || manifest.superseded_by !== undefined) {
      const target = manifest.authoritative_location ?? manifest.superseded_by;
      if (
        typeof target !== 'string' ||
        (manifest.authoritative_location !== undefined &&
          (manifest.authorized_agents !== undefined || manifest.superseded_by !== undefined))
      ) {
        this.documentError(publisher, initial, 'ambiguous_authoritative_pointer');
        return null;
      }
      const evidence = this.provenance.get(initial);
      if (evidence) evidence.delegated_to = target;
      let location: URL;
      try {
        location = new URL(target);
      } catch {
        this.documentError(publisher, initial, 'invalid_authoritative_location');
        return null;
      }
      if (
        location.protocol !== 'https:' ||
        location.username ||
        location.password ||
        location.hash ||
        (location.port && location.port !== '443')
      ) {
        this.documentError(publisher, initial, 'invalid_authoritative_location');
        return null;
      }
      authorityLocation = location.href;
      await this.checkAuthority(publisher, authorityLocation, 'check');
      const response = await this.read(publisher, 'adagents', target, true);
      if (!response) return null;
      documentResponse = response;
      manifest = await this.parseManifest(publisher, response);
      if (!manifest) return null;
      if (manifest.authoritative_location !== undefined || manifest.superseded_by !== undefined) {
        this.documentError(publisher, response, 'chained_authoritative_pointer');
        return null;
      }
    } else {
      await this.checkAuthority(publisher, authorityLocation, 'check');
    }
    if (!Array.isArray(manifest.authorized_agents)) {
      this.documentError(publisher, documentResponse, 'missing_authorized_agents');
      // parseManifest already captured denials; invalid envelopes cannot establish a pin.
      return null;
    }
    await this.checkAuthority(publisher, authorityLocation, 'observe');
    if (new URL(authorityLocation).origin !== new URL(url).origin) this.crossOriginAuthorities.add(publisher);
    return manifest;
  }
  private async checkAuthority(publisher: string, location: string, operation: 'check' | 'observe'): Promise<void> {
    let accepted: boolean;
    try {
      accepted = await withAbortSignal([this.signal], undefined, () =>
        (this.options.authorityStore ?? defaultSupplyPathAuthorities)[operation](publisher, location)
      );
    } catch (cause) {
      this.signal.throwIfAborted();
      throw new Error('Supply-path authority storage failed', { cause });
    }
    this.signal.throwIfAborted();
    if (!accepted)
      throw new TypeError(
        `Authoritative location changed for ${publisher} to ${location}; independently confirm the publisher migration before updating its pin`
      );
  }
  private async readAndRemember(publisher: string): Promise<SupplyPathManifest | null> {
    const manifest = await this.readAdagents(publisher);
    const effective = await this.rememberRevocations(publisher);
    return manifest ? { ...manifest, revoked_publisher_domains: effective } : null;
  }
  private async rememberRevocations(publisher: string): Promise<SupplyPathRevocation[]> {
    const observed = this.observedRevocations.get(publisher) ?? [];
    let held: readonly SupplyPathRevocation[];
    try {
      held = await withAbortSignal([this.signal], undefined, () =>
        (this.options.revocationStore ?? defaultSupplyPathRevocations).observe(publisher, observed)
      );
    } catch (cause) {
      this.signal.throwIfAborted();
      throw new Error('Supply-path revocation storage failed', { cause });
    }
    this.signal.throwIfAborted();
    // Persistence can add prior denials; it cannot erase current wire evidence.
    const effective = [...new Map([...held, ...observed].map(entry => [entry.publisher_domain, entry])).values()];
    this.revocations.set(publisher, effective);
    return effective;
  }
}
