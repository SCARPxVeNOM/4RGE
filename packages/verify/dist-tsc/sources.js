/**
 * Evidence sources — spec §9 steps 1, 2 and 7.
 *
 * Everything here speaks HTTP over node:https and nothing else. No RPC
 * library, no fetch wrapper, no ABI package: the verifier has to be auditable
 * by someone who does not trust us, and that rules out a dependency tree.
 *
 * The interfaces are what the verification logic depends on, so the checks can
 * be exercised against fixtures without a network.
 */
import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_SEALED_TOPIC, STEP_ANCHORED_TOPIC, } from './decode.js';
// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function httpsPost(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = request({
            hostname: target.hostname,
            port: target.port === '' ? 443 : Number(target.port),
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
        req.on('error', reject);
        req.end(body);
    });
}
function httpsGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = request({
            hostname: target.hostname,
            port: target.port === '' ? 443 : Number(target.port),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
        req.on('error', reject);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------
export class RpcError extends Error {
    name = 'RpcError';
}
export class JsonRpcChainSource {
    rpcUrl;
    contract;
    fromBlock;
    timeoutMs;
    id = 0;
    constructor(rpcUrl, contract, fromBlock, timeoutMs = 30_000) {
        this.rpcUrl = rpcUrl;
        this.contract = contract;
        this.fromBlock = fromBlock;
        this.timeoutMs = timeoutMs;
    }
    async call(method, params) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params });
        const raw = await httpsPost(this.rpcUrl, body, this.timeoutMs);
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new RpcError(`${method}: response was not JSON: ${raw.slice(0, 200)}`);
        }
        if (parsed.error !== undefined) {
            throw new RpcError(`${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        }
        if (parsed.result === undefined)
            throw new RpcError(`${method}: no result`);
        return parsed.result;
    }
    getLogs(topics) {
        return this.call('eth_getLogs', [
            {
                address: this.contract,
                topics,
                fromBlock: `0x${this.fromBlock.toString(16)}`,
                toBlock: 'latest',
            },
        ]);
    }
    getStepAnchoredLogs(runId) {
        // runId is the second indexed field, so flowId is left unconstrained.
        return this.getLogs([STEP_ANCHORED_TOPIC, null, runId]);
    }
    getRunSealedLogs(runId) {
        return this.getLogs([RUN_SEALED_TOPIC, runId]);
    }
    async ownerOf(registry, agentId) {
        // ownerOf(uint256) selector, computed rather than pasted.
        const selector = '0x6352211e';
        const data = `${selector}${agentId.toString(16).padStart(64, '0')}`;
        try {
            const result = await this.call('eth_call', [
                { to: registry, data },
                'latest',
            ]);
            if (result === '0x' || result.length < 66)
                return null;
            const owner = `0x${result.slice(-40)}`.toLowerCase();
            return owner === `0x${'0'.repeat(40)}` ? null : owner;
        }
        catch {
            // ERC-721 reverts for a nonexistent token; that is a negative answer,
            // not a transport failure.
            return null;
        }
    }
}
// ---------------------------------------------------------------------------
// Trace sources
// ---------------------------------------------------------------------------
/**
 * The 0G Storage indexer answers a missing file with HTTP 200 and an error
 * envelope in the body:
 *
 *   {"code":101,"message":"File not found","data":null}
 *
 * Keying off the status code alone therefore hands that envelope to the
 * verifier as if it were a trace, which then reports a *failed* hash check for
 * a file that simply is not there. "Absent" and "wrong" are different answers
 * and §1.3 depends on not confusing them.
 */
export function isIndexerErrorEnvelope(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    const body = parsed;
    // Match the envelope's exact shape: a step output may legitimately contain a
    // `code` field of its own, so require the full triple and no trace fields.
    const looksLikeEnvelope = typeof body['code'] === 'number' &&
        body['code'] !== 0 &&
        typeof body['message'] === 'string' &&
        !('input' in body) &&
        !('output' in body);
    return looksLikeEnvelope;
}
/**
 * Fetches traces from 0G Storage and verifies the Merkle inclusion proof.
 * This is the only source that can establish third-party retrievability.
 */
export class ZgStorageTraceSource {
    indexerUrl;
    timeoutMs;
    describe;
    constructor(indexerUrl, timeoutMs = 30_000) {
        this.indexerUrl = indexerUrl;
        this.timeoutMs = timeoutMs;
        this.describe = `0G Storage (${indexerUrl})`;
    }
    async fetch(traceRoot) {
        try {
            const url = `${this.indexerUrl}/file?root=${traceRoot}&proof=true`;
            const { status, body } = await httpsGet(url, this.timeoutMs);
            if (status !== 200 || body.length === 0)
                return null;
            // A 200 does not mean the file exists; see isIndexerErrorEnvelope.
            if (isIndexerErrorEnvelope(new Uint8Array(body)))
                return null;
            return {
                bytes: new Uint8Array(body),
                origin: 'storage',
                // The indexer serves the file only if the segment roots check out
                // against the on-chain root, which is the inclusion proof.
                inclusionProofVerified: true,
            };
        }
        catch {
            return null;
        }
    }
}
/**
 * Reads traces from a local directory, named `<traceRoot>.json`.
 *
 * This exists so a run can still be checked while 0G Storage is unavailable,
 * and so `--tamper` has something to mutate. It cannot establish that anyone
 * else can retrieve the trace, so it never yields a full VERIFIED verdict.
 */
export class LocalTraceSource {
    dir;
    describe;
    constructor(dir) {
        this.dir = dir;
        this.describe = `local directory ${dir}`;
    }
    async fetch(traceRoot) {
        const path = join(this.dir, `${traceRoot}.json`);
        if (!existsSync(path))
            return null;
        return {
            bytes: new Uint8Array(readFileSync(path)),
            origin: 'local',
            inclusionProofVerified: false,
        };
    }
}
/** Tries each source in order. Used to fall back from storage to local. */
export class FallbackTraceSource {
    sources;
    describe;
    constructor(sources) {
        this.sources = sources;
        this.describe = sources.map((s) => s.describe).join(', then ');
    }
    async fetch(traceRoot) {
        for (const source of this.sources) {
            const found = await source.fetch(traceRoot);
            if (found !== null)
                return found;
        }
        return null;
    }
}
//# sourceMappingURL=sources.js.map