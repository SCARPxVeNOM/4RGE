/**
 * A 0G Flow agent you can deploy and get hired.
 *
 * This is the whole thing. Change `describe`, `schema` and `work` and you have
 * your own agent; everything else here is the parts that are easy to get
 * quietly wrong, which is exactly what the SDK exists to handle.
 *
 * What makes it hireable rather than just a web service:
 *
 *   /health   says it is alive, and publishes the address it signs with, so an
 *             operator can check the registry lists that exact key
 *   /schema   declares what it takes and returns, which the executor validates
 *             input against before calling you
 *   /invoke   does the work AND signs the output, which is what proves the
 *             work was yours and what the escrow checks before paying you
 *
 * The signing key never leaves this process, and is never the key that owns
 * your identity NFT. That separation is deliberate: the owner is a cold key
 * holding an asset, this is a hot key on a server you may not fully control.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  handleInvoke,
  healthBody,
  schemaBody,
  signOutput,
  require_,
  AgentError,
  type AgentDefinition,
  type JsonValue,
} from '@0gflow/adapter-sdk';

// ---------------------------------------------------------------------------
// Your agent
// ---------------------------------------------------------------------------

/**
 * The ERC-8004 token id you were given when you published.
 *
 * Left unset until then. It is part of what you sign, so a wrong value here
 * produces signatures that verify nowhere — publish first, then set it.
 */
const AGENT_ID = process.env['AGENT_ID'] ?? '0';

const schema = {
  input: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', description: 'The text to work on.' } },
  },
  output: {
    type: 'object',
    required: ['result'],
    properties: {
      result: { type: 'string' },
      characters: { type: 'number' },
    },
  },
};

/**
 * Replace this with whatever your agent actually does.
 *
 * It may be async, call a model, hit an API — anything. Two rules:
 *
 *   return something, always. A 200 with no output anchors a hash of nothing,
 *   which is a different and false claim from "here is the answer".
 *
 *   throw an AgentError when you cannot. Say whether retrying is safe: the
 *   executor retries only when you say so, and a deterministic failure marked
 *   retryable burns your caller's deadline four times over.
 */
function work(input: Record<string, JsonValue>): JsonValue {
  const text = require_.string(input, 'text');

  if (text.length > 10_000) {
    throw new AgentError('input is too long for this agent', 'too-large', false, 413);
  }

  return {
    result: text.split(' ').reverse().join(' '),
    characters: text.length,
  };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * The key this agent signs its outputs with.
 *
 * In production set `AGENT_KEY` and publish the matching *address* as your
 * agent's signer. Without it a key is generated per boot, which is fine for
 * poking at locally and useless once deployed: every restart would change the
 * address, and no run could ever be attributed to you.
 */
const key = process.env['AGENT_KEY'];
const account = privateKeyToAccount((key ?? generatePrivateKey()) as `0x${string}`);

if (key === undefined) {
  console.warn(
    'AGENT_KEY is not set, so a throwaway signing key was generated for this boot.\n' +
      `  address: ${account.address}\n` +
      '  Set AGENT_KEY before publishing, or nothing you sign can be attributed to you.',
  );
}

const agent: AgentDefinition = {
  agentId: AGENT_ID,
  version: '1.0.0',
  schema,
  async invoke(request) {
    const output = work(request.input);

    // The executor tells us where this step will be anchored. Without that a
    // signature would be valid against every chain and every deployment, so
    // there is nothing safe to sign and we return the answer unsigned.
    if (request.chainId === undefined || request.receipts === undefined) {
      return { output };
    }

    const { signature } = await signOutput(
      { request, agentId: AGENT_ID, output },
      // The SDK hands over the digest; the prefixing is done here, by viem.
      (digest) => account.signMessage({ message: { raw: digest as `0x${string}` } }),
    );

    return { output, outputSignature: signature };
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// A host that injects PORT also decides the interface: a container binding
// loopback is unreachable, and that failure looks like a broken deploy rather
// than a wrong address.
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? (process.env['PORT'] === undefined ? '127.0.0.1' : '0.0.0.0');

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // Anyone may read a listed agent's schema and health; the executor calling
    // you is a server, but a directory in someone's browser is not.
    'access-control-allow-origin': '*',
  });
  res.end(payload);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health') {
      // The signer address is published so an operator can confirm the registry
      // lists this exact key. A mismatch is otherwise invisible until a step
      // silently records as unproven.
      return send(res, 200, { ...(healthBody(agent) as object), signer: account.address });
    }

    if (path === '/schema') return send(res, 200, schemaBody(agent));

    if (path === '/invoke') {
      if (req.method !== 'POST') {
        return send(res, 405, {
          error: { code: 'method-not-allowed', message: 'use POST', retryable: false },
        });
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, {
          error: { code: 'bad-request', message: 'body is not JSON', retryable: false },
        });
      }
      const result = await handleInvoke(agent, body);
      return send(res, result.status, result.body);
    }

    return send(res, 404, {
      error: { code: 'not-found', message: `no route for ${path}`, retryable: false },
    });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`agent listening on ${HOST}:${PORT}`);
  console.log(`  agentId  ${AGENT_ID}${AGENT_ID === '0' ? '  (set AGENT_ID after publishing)' : ''}`);
  console.log(`  signer   ${account.address}`);
  console.log('');
  console.log('  Publish it:');
  console.log('    ZG_PRIVATE_KEY=0x… npx @0gflow/publish \\');
  console.log('      --endpoint https://your-deployed-url \\');
  console.log(`      --signer ${account.address} --name "My agent"`);
});
