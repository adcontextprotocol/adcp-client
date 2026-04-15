/**
 * Network Consistency Checker for AdCP
 *
 * Validates managed publisher network deployments by checking that:
 * 1. The authoritative adagents.json is well-formed
 * 2. Each property domain has a valid pointer file
 * 3. No orphaned or stale pointer files exist
 * 4. All authorized agent endpoints are reachable
 */

import { createLogger, type LogLevel } from '../utils/logger';
import { LIBRARY_VERSION } from '../version';
import { validateUserAgent } from '../utils/validate-user-agent';
import { validateAgentUrl } from '../validation';
import type { AdAgentsJson, AuthorizedAgent, Property } from './types';

// ====== Configuration ======

/** Progress update emitted after each domain or agent check completes. */
export interface CheckProgress {
  phase: 'pointers' | 'orphans' | 'agents';
  completed: number;
  total: number;
  domain?: string;
}

export interface NetworkConsistencyCheckerConfig {
  /** URL of the authoritative adagents.json file */
  authoritativeUrl?: string;
  /** Domains to check (if no authoritativeUrl, fetches pointer from first domain) */
  domains?: string[];
  /** Max parallel fetches (default 10, max 50) */
  concurrency?: number;
  /** Per-request timeout in ms (default 10000) */
  timeoutMs?: number;
  logLevel?: LogLevel;
  userAgent?: string;
  /** Called after each domain/agent check completes. */
  onProgress?: (progress: CheckProgress) => void;
}

// ====== Report types ======

export interface OrphanedPointer {
  domain: string;
  pointerUrl: string;
}

export interface StalePointer {
  domain: string;
  pointerUrl: string;
  expectedUrl: string;
}

export interface MissingPointer {
  domain: string;
  error: string;
}

export interface SchemaError {
  field: string;
  message: string;
}

export interface AgentHealthResult {
  url: string;
  reachable: boolean;
  statusCode?: number;
  error?: string;
}

export type DomainStatus = 'ok' | 'missing_pointer' | 'stale_pointer' | 'orphaned_pointer' | 'error';

export interface DomainDetail {
  domain: string;
  status: DomainStatus;
  pointerUrl?: string;
  errors: string[];
}

export interface CheckSummary {
  totalDomains: number;
  validPointers: number;
  orphanedPointers: number;
  stalePointers: number;
  missingPointers: number;
  schemaErrors: number;
  unreachableAgents: number;
  totalIssues: number;
}

export interface NetworkCheckReport {
  checkedAt: string;
  authoritativeUrl: string;
  coverage: number;
  summary: CheckSummary;
  orphanedPointers: OrphanedPointer[];
  stalePointers: StalePointer[];
  missingPointers: MissingPointer[];
  schemaErrors: SchemaError[];
  agentHealth: AgentHealthResult[];
  domains: DomainDetail[];
}

// ====== Implementation ======

const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB

const FETCH_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

export class NetworkConsistencyChecker {
  private readonly authoritativeUrl?: string;
  private readonly domains: string[];
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly userAgentHeader: string;
  private readonly fromHeader: string;
  private readonly onProgress?: (progress: CheckProgress) => void;

  constructor(config: NetworkConsistencyCheckerConfig) {
    if (!config.authoritativeUrl && (!config.domains || config.domains.length === 0)) {
      throw new Error('Either authoritativeUrl or domains must be provided');
    }
    if (config.userAgent) {
      validateUserAgent(config.userAgent);
    }

    this.authoritativeUrl = config.authoritativeUrl;
    this.domains = config.domains ?? [];
    this.concurrency = Math.min(config.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.concurrency < 1) throw new Error('concurrency must be >= 1');
    if (this.timeoutMs < 1) throw new Error('timeoutMs must be >= 1');
    this.logger = createLogger({ level: config.logLevel ?? 'warn' }).child('NetworkConsistencyChecker');
    this.userAgentHeader = `adcp-network-checker/${LIBRARY_VERSION} (+https://adcontextprotocol.org)`;
    this.fromHeader = config.userAgent
      ? `adcp-network-checker@adcontextprotocol.org (${config.userAgent}; v${LIBRARY_VERSION})`
      : `adcp-network-checker@adcontextprotocol.org (v${LIBRARY_VERSION})`;
    this.onProgress = config.onProgress;
  }

  async check(): Promise<NetworkCheckReport> {
    const report: NetworkCheckReport = {
      checkedAt: new Date().toISOString(),
      authoritativeUrl: '',
      coverage: 0,
      summary: {
        totalDomains: 0,
        validPointers: 0,
        orphanedPointers: 0,
        stalePointers: 0,
        missingPointers: 0,
        schemaErrors: 0,
        unreachableAgents: 0,
        totalIssues: 0,
      },
      orphanedPointers: [],
      stalePointers: [],
      missingPointers: [],
      schemaErrors: [],
      agentHealth: [],
      domains: [],
    };

    // Step 1: Resolve and fetch the authoritative file
    const { url: resolvedUrl, data: authData } = await this.fetchAuthoritative(report);
    report.authoritativeUrl = resolvedUrl;

    if (!authData) {
      this.computeSummary(report, 0);
      return report;
    }

    // Step 2: Validate authoritative file schema
    this.validateSchema(authData, report);

    // Step 3: Extract domains from authoritative properties
    const authoritativeDomains = this.extractDomains(authData.properties ?? []);

    // Step 4: Check agent endpoint health
    if (authData.authorized_agents && authData.authorized_agents.length > 0) {
      report.agentHealth = await this.checkAgentHealth(authData.authorized_agents);
    }

    // Step 5: Check pointer files on authoritative domains
    await this.checkPointers(resolvedUrl, authoritativeDomains, report);

    // Step 6: Check for orphaned pointers (domains not in authoritative file)
    const extraDomains = this.domains.filter(d => !authoritativeDomains.has(d));
    if (extraDomains.length > 0) {
      await this.checkOrphanedPointers(resolvedUrl, extraDomains, report);
    }

    // Step 7: Compute coverage and summary
    const total = authoritativeDomains.size;
    const valid = report.domains.filter(d => d.status === 'ok').length;
    report.coverage = total > 0 ? valid / total : 0;
    this.computeSummary(report, total);

    return report;
  }

  private computeSummary(report: NetworkCheckReport, totalDomains: number): void {
    const unreachableAgents = report.agentHealth.filter(a => !a.reachable).length;
    report.summary = {
      totalDomains,
      validPointers: report.domains.filter(d => d.status === 'ok').length,
      orphanedPointers: report.orphanedPointers.length,
      stalePointers: report.stalePointers.length,
      missingPointers: report.missingPointers.length,
      schemaErrors: report.schemaErrors.length,
      unreachableAgents,
      totalIssues:
        report.schemaErrors.length +
        report.missingPointers.length +
        report.stalePointers.length +
        report.orphanedPointers.length +
        unreachableAgents,
    };
  }

  // ---- Internal methods ----

  private async fetchAuthoritative(report: NetworkCheckReport): Promise<{ url: string; data: AdAgentsJson | null }> {
    let url = this.authoritativeUrl;

    // If no authoritative URL, discover it from the first domain's pointer
    if (!url) {
      const firstDomain = this.domains[0];
      try {
        const pointerData = await this.fetchJson<AdAgentsJson>(`https://${firstDomain}/.well-known/adagents.json`);
        if (pointerData.authoritative_location) {
          url = pointerData.authoritative_location;
        } else {
          return { url: `https://${firstDomain}/.well-known/adagents.json`, data: pointerData };
        }
      } catch (error) {
        report.schemaErrors.push({
          field: 'authoritative_location',
          message: `Failed to discover authoritative URL from ${firstDomain}: ${this.sanitizeError(error)}`,
        });
        return { url: '', data: null };
      }
    }

    try {
      const data = await this.fetchJson<AdAgentsJson>(url);

      // Follow at most one authoritative_location redirect
      if (data.authoritative_location && !data.authorized_agents) {
        const redirectUrl = data.authoritative_location;
        if (!redirectUrl.startsWith('https://')) {
          report.schemaErrors.push({
            field: 'authoritative_location',
            message: `authoritative_location must use HTTPS: ${redirectUrl}`,
          });
          return { url, data: null };
        }
        if (redirectUrl === url) {
          report.schemaErrors.push({
            field: 'authoritative_location',
            message: 'authoritative_location points to itself',
          });
          return { url, data: null };
        }
        const redirectData = await this.fetchJson<AdAgentsJson>(redirectUrl);
        // Do not follow further redirects from the redirect target
        return { url: redirectUrl, data: redirectData };
      }

      return { url, data };
    } catch (error) {
      report.schemaErrors.push({
        field: '$root',
        message: `Failed to fetch authoritative file: ${this.sanitizeError(error)}`,
      });
      return { url: url ?? '', data: null };
    }
  }

  private validateSchema(data: AdAgentsJson, report: NetworkCheckReport): void {
    if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
      report.schemaErrors.push({
        field: 'authorized_agents',
        message: 'Missing or invalid authorized_agents array',
      });
    } else {
      data.authorized_agents.forEach((agent, i) => {
        if (!agent.url) {
          report.schemaErrors.push({
            field: `authorized_agents[${i}].url`,
            message: 'Missing required url field',
          });
        }
        if (!agent.authorized_for) {
          report.schemaErrors.push({
            field: `authorized_agents[${i}].authorized_for`,
            message: 'Missing required authorized_for field',
          });
        }
      });
    }

    if (data.properties && Array.isArray(data.properties)) {
      data.properties.forEach((prop, i) => {
        if (!prop.name) {
          report.schemaErrors.push({
            field: `properties[${i}].name`,
            message: 'Missing required name field',
          });
        }
        if (!prop.property_type) {
          report.schemaErrors.push({
            field: `properties[${i}].property_type`,
            message: 'Missing required property_type field',
          });
        }
        if (!prop.identifiers || !Array.isArray(prop.identifiers) || prop.identifiers.length === 0) {
          report.schemaErrors.push({
            field: `properties[${i}].identifiers`,
            message: 'Missing or empty identifiers array',
          });
        }
      });
    }
  }

  private extractDomains(properties: Property[]): Set<string> {
    const domains = new Set<string>();
    for (const prop of properties) {
      for (const id of prop.identifiers ?? []) {
        if (id.type === 'domain' || id.type === 'subdomain') {
          domains.add(id.value.toLowerCase());
        }
      }
      if (prop.publisher_domain) {
        domains.add(prop.publisher_domain.toLowerCase());
      }
    }
    return domains;
  }

  private async checkAgentHealth(agents: AuthorizedAgent[]): Promise<AgentHealthResult[]> {
    let completed = 0;
    return this.runConcurrent(agents, async agent => {
      const result = await this.probeAgent(agent);
      completed++;
      this.onProgress?.({ phase: 'agents', completed, total: agents.length });
      return result;
    });
  }

  private async probeAgent(agent: AuthorizedAgent): Promise<AgentHealthResult> {
    try {
      validateAgentUrl(agent.url);
    } catch (error) {
      return {
        url: agent.url,
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response = await fetch(agent.url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            ...FETCH_HEADERS,
            'User-Agent': this.userAgentHeader,
            From: this.fromHeader,
          },
        });

        // Follow one redirect with SSRF validation
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get?.('location');
          if (!location) {
            return { url: agent.url, reachable: false, error: 'Redirect with no Location header' };
          }
          const redirectUrl = new URL(location, agent.url).toString();
          if (!redirectUrl.startsWith('https://')) {
            return { url: agent.url, reachable: false, error: 'Redirect to non-HTTPS URL' };
          }
          validateAgentUrl(redirectUrl);
          response = await fetch(redirectUrl, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'error',
            headers: {
              ...FETCH_HEADERS,
              'User-Agent': this.userAgentHeader,
              From: this.fromHeader,
            },
          });
        }

        return {
          url: agent.url,
          reachable: response.ok || response.status === 405, // 405 = HEAD rejected but server is alive
          statusCode: response.status,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        url: agent.url,
        reachable: false,
        error: this.sanitizeError(error),
      };
    }
  }

  private async checkPointers(
    authoritativeUrl: string,
    authoritativeDomains: Set<string>,
    report: NetworkCheckReport
  ): Promise<void> {
    const domains = Array.from(authoritativeDomains);

    let completed = 0;
    const results = await this.runConcurrent(domains, async domain => {
      const result = await this.checkDomainPointer(domain, authoritativeUrl);
      completed++;
      this.onProgress?.({ phase: 'pointers', completed, total: domains.length, domain });
      return result;
    });

    for (const result of results) {
      report.domains.push(result.detail);
      if (result.missing) report.missingPointers.push(result.missing);
      if (result.stale) report.stalePointers.push(result.stale);
    }
  }

  private async checkDomainPointer(
    domain: string,
    authoritativeUrl: string
  ): Promise<{
    detail: DomainDetail;
    missing?: MissingPointer;
    stale?: StalePointer;
  }> {
    const url = `https://${domain}/.well-known/adagents.json`;

    try {
      const data = await this.fetchJson<AdAgentsJson>(url);

      if (data.authoritative_location) {
        if (data.authoritative_location === authoritativeUrl) {
          return {
            detail: {
              domain,
              status: 'ok',
              pointerUrl: data.authoritative_location,
              errors: [],
            },
          };
        } else {
          return {
            detail: {
              domain,
              status: 'stale_pointer',
              pointerUrl: data.authoritative_location,
              errors: [`Pointer references ${data.authoritative_location}, expected ${authoritativeUrl}`],
            },
            stale: {
              domain,
              pointerUrl: data.authoritative_location,
              expectedUrl: authoritativeUrl,
            },
          };
        }
      }

      // No authoritative_location — the domain hosts its own file
      if (url === authoritativeUrl) {
        return {
          detail: { domain, status: 'ok', errors: [] },
        };
      }

      return {
        detail: {
          domain,
          status: 'stale_pointer',
          errors: [`adagents.json exists but has no authoritative_location pointing to ${authoritativeUrl}`],
        },
        stale: {
          domain,
          pointerUrl: url,
          expectedUrl: authoritativeUrl,
        },
      };
    } catch (error) {
      const msg = this.sanitizeError(error);
      this.logger.debug(`Failed to fetch pointer from ${domain}: ${msg}`);
      return {
        detail: { domain, status: 'missing_pointer', errors: [msg] },
        missing: { domain, error: msg },
      };
    }
  }

  private async checkOrphanedPointers(
    authoritativeUrl: string,
    extraDomains: string[],
    report: NetworkCheckReport
  ): Promise<void> {
    let completed = 0;
    const results = await this.runConcurrent(
      extraDomains,
      async (
        domain
      ): Promise<{
        domain: string;
        orphaned: boolean;
        pointerUrl: string;
      } | null> => {
        try {
          const data = await this.fetchJson<AdAgentsJson>(`https://${domain}/.well-known/adagents.json`);
          const result =
            data.authoritative_location === authoritativeUrl
              ? { domain, orphaned: true, pointerUrl: data.authoritative_location }
              : null;
          return result;
        } catch {
          return null;
        } finally {
          completed++;
          this.onProgress?.({ phase: 'orphans', completed, total: extraDomains.length, domain });
        }
      }
    );

    for (const result of results) {
      if (result?.orphaned) {
        report.orphanedPointers.push({
          domain: result.domain,
          pointerUrl: result.pointerUrl,
        });
        report.domains.push({
          domain: result.domain,
          status: 'orphaned_pointer',
          pointerUrl: result.pointerUrl,
          errors: ['Domain has pointer file but is not listed in authoritative properties'],
        });
      }
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    validateAgentUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          ...FETCH_HEADERS,
          'User-Agent': this.userAgentHeader,
          From: this.fromHeader,
        },
      });

      // Follow one HTTP redirect with SSRF validation
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get?.('location');
        if (!location) {
          throw new Error(`HTTP ${response.status} redirect with no Location header`);
        }
        const redirectUrl = new URL(location, url).toString();
        if (!redirectUrl.startsWith('https://')) {
          throw new Error('Redirect to non-HTTPS URL not allowed');
        }
        validateAgentUrl(redirectUrl);
        response = await fetch(redirectUrl, {
          signal: controller.signal,
          redirect: 'error',
          headers: {
            ...FETCH_HEADERS,
            'User-Agent': this.userAgentHeader,
            From: this.fromHeader,
          },
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentLength = response.headers.get?.('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error('Response too large');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf-8') > MAX_RESPONSE_BYTES) {
        throw new Error('Response too large');
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sanitizeError(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === 'AbortError') return 'Request timed out';
      if (error.message.startsWith('HTTP ')) return error.message;
      if (error.message.startsWith('Request timed out')) return error.message;
      if (error.message.includes('ECONNREFUSED')) return 'Connection refused';
      if (error.message.includes('ENOTFOUND')) return 'DNS resolution failed';
      if (error.message.includes('certificate')) return 'TLS error';
      if (error.message.includes('Response too large')) return 'Response too large';
      if (error.message.includes('not allowed')) return error.message;
      if (error.message.includes('must use HTTPS')) return error.message;
      if (error.message.includes('no Location header')) return error.message;
    }
    return 'Request failed';
  }

  /**
   * Run async operations with concurrency limit, preserving input order.
   */
  private async runConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let active = 0;
    let nextIdx = 0;

    return new Promise<R[]>((resolve, reject) => {
      if (items.length === 0) return resolve([]);

      const next = (): void => {
        while (active < this.concurrency && nextIdx < items.length) {
          const i = nextIdx++;
          active++;
          fn(items[i]!)
            .then(r => {
              results[i] = r;
              active--;
              if (nextIdx >= items.length && active === 0) {
                resolve(results);
              } else {
                next();
              }
            })
            .catch(reject);
        }
      };
      next();
    });
  }
}
