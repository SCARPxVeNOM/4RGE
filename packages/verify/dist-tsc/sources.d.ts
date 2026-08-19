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
import type { Hex } from '@0gflow/core';
import { type RawLog } from './decode.js';
export interface ChainSource {
    getStepAnchoredLogs(runId: Hex): Promise<RawLog[]>;
    getRunSealedLogs(runId: Hex): Promise<RawLog[]>;
    /** ERC-721 ownerOf; null when the token does not exist. */
    ownerOf(registry: Hex, agentId: bigint): Promise<Hex | null>;
}
export type TraceOrigin = 'storage' | 'local';
export interface FetchedTrace {
    readonly bytes: Uint8Array;
    readonly origin: TraceOrigin;
    /**
     * Whether a Merkle inclusion proof was verified against the traceRoot.
     * Only 0G Storage can supply this; a local file cannot, and the report must
     * say so rather than implying third-party retrievability.
     */
    readonly inclusionProofVerified: boolean;
}
export interface TraceSource {
    readonly describe: string;
    fetch(traceRoot: Hex): Promise<FetchedTrace | null>;
}
export declare class RpcError extends Error {
    readonly name = "RpcError";
}
export declare class JsonRpcChainSource implements ChainSource {
    private readonly rpcUrl;
    private readonly contract;
    private readonly fromBlock;
    private readonly timeoutMs;
    private id;
    constructor(rpcUrl: string, contract: Hex, fromBlock: bigint, timeoutMs?: number);
    private call;
    private getLogs;
    getStepAnchoredLogs(runId: Hex): Promise<RawLog[]>;
    getRunSealedLogs(runId: Hex): Promise<RawLog[]>;
    ownerOf(registry: Hex, agentId: bigint): Promise<Hex | null>;
}
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
export declare function isIndexerErrorEnvelope(bytes: Uint8Array): boolean;
/**
 * Fetches traces from 0G Storage and verifies the Merkle inclusion proof.
 * This is the only source that can establish third-party retrievability.
 */
export declare class ZgStorageTraceSource implements TraceSource {
    private readonly indexerUrl;
    private readonly timeoutMs;
    readonly describe: string;
    constructor(indexerUrl: string, timeoutMs?: number);
    fetch(traceRoot: Hex): Promise<FetchedTrace | null>;
}
/**
 * Reads traces from a local directory, named `<traceRoot>.json`.
 *
 * This exists so a run can still be checked while 0G Storage is unavailable,
 * and so `--tamper` has something to mutate. It cannot establish that anyone
 * else can retrieve the trace, so it never yields a full VERIFIED verdict.
 */
export declare class LocalTraceSource implements TraceSource {
    private readonly dir;
    readonly describe: string;
    constructor(dir: string);
    fetch(traceRoot: Hex): Promise<FetchedTrace | null>;
}
/** Tries each source in order. Used to fall back from storage to local. */
export declare class FallbackTraceSource implements TraceSource {
    private readonly sources;
    readonly describe: string;
    constructor(sources: readonly TraceSource[]);
    fetch(traceRoot: Hex): Promise<FetchedTrace | null>;
}
//# sourceMappingURL=sources.d.ts.map