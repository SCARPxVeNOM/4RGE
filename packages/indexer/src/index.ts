/**
 * @0gflow/indexer — chain events into a queryable store (§8.1).
 */

export { ingestRange, catchUp, type ChainReader, type RawLogWithBlock, type IngestResult } from './ingest.js';
export { MemoryStore } from './memory-store.js';
export { PostgresStore, SCHEMA } from './postgres-store.js';
export { JsonRpcChainReader, RpcError } from './rpc.js';
export type { Store, StepRow, RunRow, AgentRow, FlowRow, SealInput } from './store.js';
export { probeAgents, httpHealthProbe, type HealthProbe, type ProbeResult } from './health.js';
