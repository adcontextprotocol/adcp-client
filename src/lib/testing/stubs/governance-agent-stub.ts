/**
 * Stub Governance Agent
 *
 * Minimal MCP server that implements check_governance and report_plan_outcome.
 * Used by comply() to verify sellers correctly call governance agents with
 * governance_context during the media buy lifecycle.
 *
 * - Always returns "approved" with a deterministic governance_context
 * - Records every inbound call for assertion by test scenarios
 * - Starts on an ephemeral port (HTTP or HTTPS), shuts down cleanly
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, unlinkSync } from 'fs';

import {
  CheckGovernanceRequestSchema,
  ReportPlanOutcomeRequestSchema,
  SyncPlansRequestSchema,
  GetPlanAuditLogsRequestSchema,
} from '../../types/schemas.generated';

export interface StubCallRecord {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
}

/**
 * Generate a self-signed certificate using openssl CLI.
 * Returns PEM-encoded key and cert strings.
 */
function generateSelfSignedCert(): { key: string; cert: string } {
  const id = randomUUID().slice(0, 8);
  const keyPath = join(tmpdir(), `stub-key-${id}.pem`);
  const certPath = join(tmpdir(), `stub-cert-${id}.pem`);

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );

    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    return { key, cert };
  } finally {
    try {
      unlinkSync(keyPath);
    } catch {}
    try {
      unlinkSync(certPath);
    } catch {}
  }
}

export class GovernanceAgentStub {
  private httpServer: HttpServer | HttpsServer | null = null;
  private callLog: StubCallRecord[] = [];
  private governanceContextPrefix: string;
  private expectedToken: string;

  constructor() {
    this.governanceContextPrefix = `stub-gc-${randomUUID().slice(0, 8)}`;
    this.expectedToken = `stub-token-${randomUUID()}`;
  }

  /**
   * The bearer token this stub expects. Pass this to register_governance
   * so the seller can authenticate when calling check_governance.
   */
  get authToken(): string {
    return this.expectedToken;
  }

  private handleRequest() {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '';
      if (url === '/mcp' || url === '/mcp/') {
        // Validate bearer token if present (sellers should send the token from register_governance)
        const authHeader = req.headers.authorization;
        if (authHeader && !authHeader.startsWith(`Bearer ${this.expectedToken}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bearer token' }));
          return;
        }

        const server = this.createMCPServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        } finally {
          await server.close();
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    };
  }

  /**
   * Start the stub server on an ephemeral port (HTTP).
   * Returns the MCP endpoint URL.
   */
  async start(): Promise<{ url: string }> {
    this.httpServer = createHttpServer(this.handleRequest());
    return this.listen('http');
  }

  /**
   * Start the stub server on an ephemeral port with HTTPS (self-signed cert).
   * The seller under test needs NODE_TLS_REJECT_UNAUTHORIZED=0 or a custom CA
   * to connect. Returns the HTTPS MCP endpoint URL.
   */
  async startHttps(): Promise<{ url: string }> {
    const { key, cert } = generateSelfSignedCert();
    this.httpServer = createHttpsServer({ key, cert }, this.handleRequest());
    return this.listen('https');
  }

  private listen(protocol: 'http' | 'https'): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        resolve({ url: `${protocol}://127.0.0.1:${addr.port}/mcp` });
      });
      this.httpServer!.on('error', reject);
    });
  }

  /**
   * Stop the stub server.
   */
  async stop(): Promise<void> {
    return new Promise(resolve => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the call log — every tool call received by this stub.
   */
  getCallLog(): StubCallRecord[] {
    return [...this.callLog];
  }

  /**
   * Get calls for a specific tool.
   */
  getCallsForTool(tool: string): StubCallRecord[] {
    return this.callLog.filter(c => c.tool === tool);
  }

  /**
   * Check if any call included the expected governance_context.
   */
  hasGovernanceContext(expectedContext: string): boolean {
    return this.callLog.some(c => (c.params as Record<string, unknown>).governance_context === expectedContext);
  }

  /**
   * Clear the call log.
   */
  clearCallLog(): void {
    this.callLog = [];
  }

  /**
   * Generate the governance_context string this stub issues.
   */
  generateContext(planId: string): string {
    return `${this.governanceContextPrefix}-${planId}`;
  }

  private recordCall(tool: string, params: Record<string, unknown>): void {
    this.callLog.push({
      tool,
      params: structuredClone(params),
      timestamp: new Date().toISOString(),
    });
  }

  private createMCPServer(): McpServer {
    const server = new McpServer({ name: 'Governance Agent Stub', version: '1.0.0' });

    // --- get_adcp_capabilities ---
    server.tool('get_adcp_capabilities', {}, async () => {
      this.recordCall('get_adcp_capabilities', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              adcp: { major_versions: [3] },
              supported_protocols: ['governance'],
            }),
          },
        ],
      };
    });

    // --- sync_plans ---
    server.tool('sync_plans', SyncPlansRequestSchema.shape, async (args: Record<string, unknown>) => {
      this.recordCall('sync_plans', args);
      const plans = (args.plans as Array<Record<string, unknown>>) || [];
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              plans: plans.map((p: Record<string, unknown>) => ({
                plan_id: p.plan_id,
                status: 'active',
                version: 1,
                categories: [{ category_id: 'budget_authority' }, { category_id: 'geo_compliance' }],
              })),
            }),
          },
        ],
      };
    });

    // --- check_governance ---
    server.tool('check_governance', CheckGovernanceRequestSchema.shape, async (args: Record<string, unknown>) => {
      this.recordCall('check_governance', args);

      const planId = args.plan_id as string;
      const checkId = `chk_stub_${randomUUID().slice(0, 8)}`;
      const gc = this.generateContext(planId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              check_id: checkId,
              status: 'approved',
              plan_id: planId,
              explanation: 'Stub governance agent: approved for testing.',
              governance_context: gc,
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
          },
        ],
      };
    });

    // --- report_plan_outcome ---
    server.tool('report_plan_outcome', ReportPlanOutcomeRequestSchema.shape, async (args: Record<string, unknown>) => {
      this.recordCall('report_plan_outcome', args);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              outcome_id: `out_stub_${randomUUID().slice(0, 8)}`,
              status: 'accepted',
            }),
          },
        ],
      };
    });

    // --- get_plan_audit_logs ---
    server.tool('get_plan_audit_logs', GetPlanAuditLogsRequestSchema.shape, async (args: Record<string, unknown>) => {
      this.recordCall('get_plan_audit_logs', args);

      const planIds = (args.plan_ids as string[]) || [];
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              plans: planIds.map(id => ({
                plan_id: id,
                budget: { total_committed: 0, budget_remaining: 10000 },
                entries: [],
              })),
            }),
          },
        ],
      };
    });

    return server;
  }
}
