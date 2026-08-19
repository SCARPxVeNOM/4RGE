/**
 * Event decoding for the verifier — spec §9 step 1.
 *
 * Hand-rolled rather than taken from a library, because §9 requires the
 * verifier to be independently auditable: a verification tool with a large
 * transitive dependency tree is not something a third party can reasonably
 * check. Both events are entirely static types, so decoding is just reading
 * 32-byte words.
 *
 * Topic hashes are computed from the signatures at load time rather than
 * pasted in. A pasted topic that drifts from the deployed contract makes
 * eth_getLogs return nothing, and "no logs" looks identical to "no such run".
 */
import { type Hex, type Receipt } from '@0gflow/core';
export interface RawLog {
    readonly address: string;
    readonly topics: string[];
    readonly data: string;
    readonly blockNumber: string;
    readonly transactionHash: string;
    readonly logIndex: string;
    readonly removed?: boolean;
}
/** A receipt as recovered from chain, with the provenance needed to anchor it. */
export interface AnchoredReceipt extends Receipt {
    readonly txHash: Hex;
    readonly blockNumber: bigint;
    readonly logIndex: number;
}
export interface Seal {
    readonly runId: Hex;
    readonly chainRoot: Hex;
    readonly stepCount: number;
    readonly outcome: number;
    readonly txHash: Hex;
    readonly blockNumber: bigint;
}
export declare const STEP_ANCHORED_SIGNATURE = "StepAnchored(bytes32,bytes32,uint32,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint8)";
export declare const RUN_SEALED_SIGNATURE = "RunSealed(bytes32,bytes32,uint32,uint8)";
export declare const STEP_ANCHORED_TOPIC: string;
export declare const RUN_SEALED_TOPIC: string;
export declare class DecodeError extends Error {
    readonly name = "DecodeError";
}
export declare function decodeStepAnchored(log: RawLog): AnchoredReceipt;
export declare function decodeRunSealed(log: RawLog): Seal;
//# sourceMappingURL=decode.d.ts.map