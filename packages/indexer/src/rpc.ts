/**
 * JSON-RPC chain reader for the indexer — spec §8.1.
 *
 * Deliberately small: getLogs, getBlockNumber, and the block hash at a height.
 * The last is what makes reorg detection possible — without it the indexer can
 * only append, and an indexer that cannot forget serves receipts that no
 * longer exist on chain.
 */

import { request } from 'node:https';
import type { ChainReader, RawLogWithBlock } from './ingest.js';

export class RpcError extends Error {
  override readonly name = 'RpcError';
}

function post(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`RPC request to ${target.hostname} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

export class JsonRpcChainReader implements ChainReader {
  private id = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const raw = await post(
      this.rpcUrl,
      JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      this.timeoutMs,
    );
    let parsed: { result?: T; error?: { message?: string } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new RpcError(`${method}: response was not JSON: ${raw.slice(0, 200)}`);
    }
    if (parsed.error !== undefined) throw new RpcError(`${method}: ${parsed.error.message ?? 'error'}`);
    if (parsed.result === undefined) throw new RpcError(`${method}: no result`);
    return parsed.result;
  }

  async getBlockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>('eth_blockNumber', []));
  }

  async getLogs(fromBlock: bigint, toBlock: bigint, address: string): Promise<RawLogWithBlock[]> {
    return this.call<RawLogWithBlock[]>('eth_getLogs', [
      {
        address,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ]);
  }

  async getBlockHash(blockNumber: bigint): Promise<string> {
    const block = await this.call<{ hash: string } | null>('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);
    // A height above the head has no block; treat it as a hash that can never
    // match, so it is never mistaken for agreement.
    return block?.hash ?? `0xmissing-${blockNumber}`;
  }
}
