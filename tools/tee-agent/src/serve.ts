/**
 * Serves the 0G Compute agent over §6.1's HTTP contract.
 *
 * Routing is `@0gflow/adapter-sdk`'s `routeAgentRequest`, so the three paths
 * behave exactly as they do for any agent built with the SDK.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { routeAgentRequest } from '@0gflow/adapter-sdk';
import { TeeAgent, type TeeAgentOptions } from './agent.js';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        // Left as null so the SDK reports a bad request rather than throwing.
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

export async function createTeeAgentServer(
  options: TeeAgentOptions,
): Promise<{ server: Server; agent: TeeAgent; provider: string; teeSigner: string; model: string }> {
  const agent = new TeeAgent(options);
  // Resolve the provider before listening: a step that arrives while the agent
  // is still choosing one would fail for a reason that has nothing to do with
  // the flow.
  const info = await agent.ready();
  const definition = agent.definition();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const result = await routeAgentRequest(
        definition,
        req.method ?? 'GET',
        url.pathname,
        await readBody(req),
      );

      const payload = JSON.stringify(
        result?.body ?? { error: { code: 'not-found', message: url.pathname, retryable: false } },
      );
      res.writeHead(result?.status ?? 404, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    })();
  });

  return { server, agent, ...info };
}
