/**
 * npx @0gflow/verify <runId> — spec §9.
 *
 * Verifies a run from public data alone: chain logs, 0G Storage, and the agent
 * registry. Nothing here trusts the operator's account of what happened.
 */
import { type Hex } from '@0gflow/core';
import { type SpecForLinkage } from './verify.js';
interface Args {
    [key: string]: unknown;
    runId: Hex | null;
    rpc?: string;
    contract?: string;
    registry?: string;
    fromBlock?: string;
    indexer?: string;
    spec?: string;
    inputs?: string;
    traceDir?: string;
    tamper: boolean;
    json: boolean;
    help: boolean;
}
export declare function parseArgs(argv: readonly string[]): Args;
/**
 * Accepts either a flow spec (has `steps`) or a bundle carrying both the spec
 * and the run's input values, so a run artifact can be passed directly.
 */
export declare function loadSpec(specPath: string, inputsPath: string | undefined): SpecForLinkage;
export declare function main(argv: readonly string[]): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map