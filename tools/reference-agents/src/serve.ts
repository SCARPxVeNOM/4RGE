/**
 * Reference agent server — spec §6.1.
 *
 * Hosts every reference agent on one process, each at /agents/<id>:
 *
 *   POST /agents/<id>/invoke
 *   GET  /agents/<id>/schema
 *   GET  /agents/<id>/health
 *
 *   pnpm --filter @0gflow/reference-agents serve
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from '@0gflow/core';
import { AGENTS, AGENTS_BY_ID } from './agents.js';

const PORT = Number(process.env['AGENT_PORT'] ?? 8710);

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createAgentServer() {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const match = /^\/agents\/([^/]+)\/(invoke|schema|health)$/.exec(url.pathname);

      if (url.pathname === '/' || url.pathname === '/agents') {
        return send(res, 200, {
          agents: AGENTS.map((a) => ({
            id: a.id,
            agentId: a.agentId,
            description: a.description,
            endpoint: `/agents/${a.id}`,
          })),
        });
      }

      if (match === null) return send(res, 404, { error: { code: 'not-found', message: `no route for ${url.pathname}`, retryable: false } });

      const [, agentId, action] = match as unknown as [string, string, string];
      const agent = AGENTS_BY_ID.get(agentId);
      if (agent === undefined) {
        return send(res, 404, { error: { code: 'unknown-agent', message: `no agent "${agentId}"`, retryable: false } });
      }

      if (action === 'health') return send(res, 200, { ok: true, agentId: agent.agentId, version: '1.0.0' });
      if (action === 'schema') return send(res, 200, agent.schema);

      if (req.method !== 'POST') {
        return send(res, 405, { error: { code: 'method-not-allowed', message: 'use POST', retryable: false } });
      }

      let envelope: Record<string, JsonValue>;
      try {
        envelope = JSON.parse(await readBody(req)) as Record<string, JsonValue>;
      } catch {
        return send(res, 400, { error: { code: 'bad-request', message: 'body is not JSON', retryable: false } });
      }

      const input = envelope['input'];
      if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
        return send(res, 400, { error: { code: 'bad-request', message: '"input" must be an object', retryable: false } });
      }

      const startedAt = Date.now();
      try {
        const result = agent.invoke(input as Record<string, JsonValue>);
        if (result.error !== undefined) {
          return send(res, result.status ?? 500, { error: result.error });
        }
        return send(res, result.status ?? 200, {
          output: result.output,
          attestation: result.attestation ?? null,
          meta: { durationMs: Date.now() - startedAt, agent: agent.id },
        });
      } catch (error) {
        // A thrown error means the input did not match the schema. That is the
        // caller's fault and will not change on a retry.
        return send(res, 422, {
          error: { code: 'schema', message: (error as Error).message, retryable: false },
        });
      }
    })();
  });
}

if (process.argv[1]?.endsWith('serve.ts') === true || process.env['AGENT_SERVE'] === '1') {
  const server = createAgentServer();
  server.listen(PORT, () => {
    const { port } = server.address() as AddressInfo;
    console.log(`reference agents listening on http://127.0.0.1:${port}`);
    for (const agent of AGENTS) {
      console.log(`  /agents/${agent.id.padEnd(14)} ${agent.description}`);
    }
  });
}
